#!/usr/bin/env python3
"""Software-WebGPU end-to-end check of the demo on the verification box.

Runs the built demo (`demos/cornell/dist`) in chrome-headless-shell with
SwiftShader WebGPU via CDP, triggers the M2 G-buffer stage (`?autorun`) and
asserts that the baked atlases actually contain geometry.

Why this exists: the project has no GPU in CI (ADR-0011) and WebGPU
validation errors never throw — invalid pipelines silently produce empty
bakes. This script catches that class of bug before a human looks at Pages.

Usage (from the repo root, after `npm run build:demo`):

    python3 tools/verify-demo-remote.py [--screenshot out.png]

Environment:
    SSH_HOST, SSH_USER, SSH_PASSWORD   verification box credentials
                                       (read from the environment, never written)
    CHROME_SHELL_PATH                  optional; chrome-headless-shell binary
                                       on the box (defaults to the documented path)

Exit status: 0 when every atlas slice has raster coverage, 1 otherwise.
Remote side needs only Python 3 + the browser (the CDP client is stdlib-only).
"""

import argparse
import base64
import json
import os
import posixpath
import sys
import tarfile
import tempfile

import paramiko

DEFAULT_CHROME = (
    "~/browsers/chrome-headless-shell/linux-131.0.6778.264/"
    "chrome-headless-shell-linux64/chrome-headless-shell"
)

# WebGPU on SwiftShader: the adapter is blocklisted by default and needs the
# Vulkan feature + Dawn blocklist override (headless-shell has no display).
FLAGS = [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--disable-vulkan-surface",
    "--use-angle=vulkan",
    "--ignore-gpu-blocklist",
    "--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist",
    "--disable-dawn-features=disallow_unsafe_apis",
]

POLL_JS = r"""
(() => {
  const pick = (id) => {
    const el = document.getElementById(id);
    return el ? el.textContent.trim() : null;
  };
  return JSON.stringify({
    probe: pick('probe'),
    status: pick('m2-status'),
    headings: [...document.querySelectorAll('#m2-output h3')].map((h) => h.textContent),
  });
})()
"""

# Analytic check against demos/cornell/src/fixture.ts: four planar wall
# quads whose exact world position and normal are known for every texel.
# A texel's fragment samples uv = (x + 1) / W because of the half-pixel
# uv_offset quirk, and chart UVs map linearly onto the rect.
SELFCHECK_JS = r"""
(() => {
  const r = window.__lightmapperLastGBuffer;
  const dbg = window.__lightmapperDebug;
  if (!r || !r.ok || !dbg) return JSON.stringify({ error: 'no result' });
  const [W, H] = r.atlasSize;
  const CH = 0.02, CW = 0.96; // fixture FULL_CHART = {0.02..0.98}
  const SIDE = CW * 256;      // wall chart length in texels (245.76)
  // mesh index → [p00, p10, p11, p01] (uv-rect corners), expected normal
  const quads = {
    0: [[-2, 0, 2.5], [2, 0, 2.5], [2, 0, -2.5], [-2, 0, -2.5], [0, 1, 0]],   // floor
    1: [[-2, 3, -2.5], [2, 3, -2.5], [2, 3, 2.5], [-2, 3, 2.5], [0, -1, 0]],  // ceiling
    4: [[-2, 3, -2.5], [-2, 3, 2.5], [-2, 0, 2.5], [-2, 0, -2.5], [1, 0, 0]], // left (red)
    5: [[2, 3, 2.5], [2, 3, -2.5], [2, 0, -2.5], [2, 0, 2.5], [-1, 0, 0]],    // right (green)
  };
  const report = {};
  // Where did covered texels actually land? (bbox per slice)
  const bbox = {};
  for (let s = 0; s < r.atlasSlices; s++) {
    const p = r.position[s].data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (p[(y * W + x) * 4 + 3] >= 0.5) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    bbox[s] = { x0, y0, x1, y1, n };
  }
  report.layout = {
    atlas: r.atlasSize,
    rects: r.meshRects.map((m) => ({ slice: m.slice, ox: m.offset[0] * W, oy: m.offset[1] * H, w: m.scale[0] * W, h: m.scale[1] * H })),
    bbox,
  };
  for (const key of Object.keys(quads)) {
    const [p00, p10, p11, p01, wantN] = quads[key];
    const m = r.meshRects[+key];
    const s = m.slice;
    const pos = r.position[s].data, nrm = r.normal[s].data, uno = r.unocclude[s].data;
    const ox = m.offset[0] * W, oy = m.offset[1] * H;
    const lw = m.scale[0] * W, lh = m.scale[1] * H;
    let maxPosErr = 0, maxNrmErr = 0, count = 0, uncovered = 0, badAlpha = 0, pushed = 0, worst = null;
    for (let y = Math.ceil(oy) + 2; y < Math.floor(oy + lh) - 2; y++) {
      for (let x = Math.ceil(ox) + 2; x < Math.floor(ox + lw) - 2; x++) {
        const u = (x + 1 - ox) / lw, v = (y + 1 - oy) / lh;
        if (u < CH + 0.01 || u > CH + CW - 0.01 || v < CH + 0.01 || v > CH + CW - 0.01) continue;
        const tu = (u - CH) / CW, tv = (v - CH) / CW;
        const i = (y * W + x) * 4;
        if (pos[i + 3] < 0.5) { uncovered++; continue; }
        if (pos[i + 3] !== 1) badAlpha++;
        if (uno[i] > 0.5) { pushed++; continue; } // un-occluded: moved on purpose
        for (let c = 0; c < 3; c++) {
          const e = (1 - tu) * (1 - tv) * p00[c] + tu * (1 - tv) * p10[c] + tu * tv * p11[c] + (1 - tu) * tv * p01[c];
          const err = Math.abs(pos[i + c] - e);
          if (err > maxPosErr) { maxPosErr = err; worst = [x, y, pos[i], pos[i + 1], pos[i + 2], e]; }
          const ne = Math.abs(dbg.f16ToF32(nrm[i + c]) - wantN[c]);
          if (ne > maxNrmErr) maxNrmErr = ne;
        }
        count++;
      }
    }
    report['mesh' + key] = { slice: s, count, uncovered, badAlpha, pushed, maxPosErr, maxNrmErr, worst };
  }
  // Edge expansion (ADR-0007): texels whose sample point falls just
  // OUTSIDE a chart cannot be covered by the fill pass — only the expanded
  // draw reaches them. They must be covered with linearly extrapolated
  // attributes, and the bleed must stop within about a texel. Checked on
  // the floor's chart border. With the fixture's 2 % inset the first ring
  // outside sits 0.12 texels out and the second 1.12, so both are
  // unambiguous: < 0.4 texel out must be covered, > 0.8 must be empty.
  {
    const m = r.meshRects[0], s = m.slice;
    const pos = r.position[s].data, nrm = r.normal[s].data;
    const ox = m.offset[0] * W, oy = m.offset[1] * H, lw = m.scale[0] * W, lh = m.scale[1] * H;
    const X0 = ox + CH * lw, X1 = ox + (CH + CW) * lw, Y0 = oy + CH * lh, Y1 = oy + (CH + CW) * lh;
    let mustCover = 0, mustEmpty = 0, ringCovered = 0, ringEmpty = 0, maxPosErr = 0, maxNrmErr = 0, worst = null;
    for (let y = Math.floor(oy); y <= Math.ceil(oy + lh); y++) {
      for (let x = Math.floor(ox); x <= Math.ceil(ox + lw); x++) {
        const sx = x + 1, sy = y + 1; // sample point in texel units (half-pixel quirk)
        const outX = sx < X0 ? X0 - sx : sx > X1 ? sx - X1 : 0;
        const outY = sy < Y0 ? Y0 - sy : sy > Y1 ? sy - Y1 : 0;
        const out = Math.max(outX, outY);
        if (out <= 0 || (out >= 0.4 && out <= 0.8) || out > 1.3) continue; // inside / ambiguous / far
        const i = (y * W + x) * 4;
        const covered = pos[i + 3] >= 0.5;
        if (out < 0.4) {
          if (!covered) { mustCover++; continue; }
          ringCovered++;
          const tu = ((x + 1 - ox) / lw - CH) / CW, tv = ((y + 1 - oy) / lh - CH) / CW;
          const q = quads[0]; // floor: [p00, p10, p11, p01, normal]
          for (let c = 0; c < 3; c++) {
            const e = (1 - tu) * (1 - tv) * q[0][c] + tu * (1 - tv) * q[1][c]
                    + tu * tv * q[2][c] + (1 - tu) * tv * q[3][c];
            const err = Math.abs(pos[i + c] - e);
            if (err > maxPosErr) { maxPosErr = err; worst = [x, y, out, pos[i], pos[i + 1], pos[i + 2], e]; }
            const ne = Math.abs(dbg.f16ToF32(nrm[i + c]) - q[4][c]);
            if (ne > maxNrmErr) maxNrmErr = ne;
          }
        } else {
          if (covered) mustEmpty++; else ringEmpty++;
        }
      }
    }
    report.edgeExpansion = { ringCovered, ringEmpty, mustCover, mustEmpty, maxPosErr, maxNrmErr, worst };
  }
  // Un-occlusion, analytically: a floor texel under one of the two boxes
  // sits inside the box volume, so its ±x/±z tangent rays hit the box walls
  // from behind (RAY_BACK → mask = 1) iff the wall is within
  // texel_size * denoiser_range and farther than `bias`. Open floor only
  // ever produces front-face hits → mask = 0. This exercises the ported
  // trace_ray DDA against ground truth for every floor texel.
  {
    const m = r.meshRects[0];
    const s = m.slice;
    const pos = r.position[s].data, uno = r.unocclude[s].data;
    const ox = m.offset[0] * W, oy = m.offset[1] * H, lw = m.scale[0] * W, lh = m.scale[1] * H;
    const boxes = [[-1.65, -0.65, -2.05, -1.05], [0.35, 1.75, 0.75, 2.15]]; // x0,x1,z0,z1
    // texel_size = max world units per atlas texel * sqrt(2); ray = * range.
    const texel = Math.max(4 / SIDE, 5 / SIDE) * Math.SQRT2;
    const rayLen = texel * 8, bias = 0.01, band = 2.5 * Math.max(4 / SIDE, 5 / SIDE);
    let checked = 0, skipped = 0, mismatches = 0, flagged = 0, expected = 0, worst = null;
    for (let y = Math.ceil(oy) + 2; y < Math.floor(oy + lh) - 2; y++) {
      for (let x = Math.ceil(ox) + 2; x < Math.floor(ox + lw) - 2; x++) {
        const i = (y * W + x) * 4;
        if (pos[i + 3] < 0.5) continue;
        // Classify by the texel's ORIGINAL world position (from its uv), not
        // the read-back one: flagged texels have been pushed out on purpose.
        const wx = -2 + 4 * (((x + 1 - ox) / lw - CH) / CW);
        const wz = 2.5 - 5 * (((y + 1 - oy) / lh - CH) / CW);
        let want = 0, d = Infinity;
        for (const b of boxes) {
          if (wx > b[0] && wx < b[1] && wz > b[2] && wz < b[3]) {
            d = Math.min(wx - b[0], b[1] - wx, wz - b[2], b[3] - wz);
            // Flagged iff a box wall is reachable (within the ray length)
            // and not inside the ray-bias dead zone.
            want = d > bias && d < rayLen ? 1 : 0;
          }
        }
        // Inside the footprint the decision flips exactly at d = rayLen and
        // d = bias; stay clear of both (my texel_size estimate is analytic,
        // the kernel's comes from screen-space derivatives).
        if (d !== Infinity && (Math.abs(d - rayLen) < band || Math.abs(d - bias) < 0.012)) { skipped++; continue; }
        // Open floor (want = 0) is checked exactly: front-face hits never
        // flag, and the far box wall is beyond the ray length, so the mask
        // must be 0 no matter how close the texel is to a box.
        const got = uno[i] > 0.5 ? 1 : 0;
        checked++;
        if (got) flagged++;
        if (want) expected++;
        if (got !== want) {
          mismatches++;
          if (!worst) worst = [x, y, wx, wz, d, want, got];
        }
      }
    }
    report.unocclude = { slice: s, rayLen, checked, skipped, mismatches, flagged, expected, worst,
      // Coarse map of one box footprint (every 6th texel): got/want.
      // '.' = agree 0, 'O' = agree 1 (flagged), 'x' = want 1 got 0, '!' = want 0 got 1.
      map: (() => {
        const b = boxes[1], rows = [];
        for (let z = b[2] - 0.25; z <= b[3] + 0.25; z += 6 * (5 / SIDE)) {
          let row = '';
          for (let x = b[0] - 0.25; x <= b[1] + 0.25; x += 6 * (4 / SIDE)) {
            // world → floor texel
            const u = 0.01 + 0.98 * (x + 2) / 4, v = 0.01 + 0.98 * (2.5 - z) / 5;
            const tx = Math.round(ox + u * lw - 1), ty = Math.round(oy + v * lh - 1);
            const i = (ty * W + tx) * 4;
            if (pos[i + 3] < 0.5) { row += ' '; continue; }
            const got = uno[i] > 0.5 ? 1 : 0;
            const inside = x > b[0] && x < b[1] && z > b[2] && z < b[3];
            const d = inside ? Math.min(x - b[0], b[1] - x, z - b[2], b[3] - z) : Infinity;
            const want = inside && d > bias && d < rayLen ? 1 : 0;
            const near = inside && (Math.abs(d - rayLen) < band || Math.abs(d - bias) < 0.012);
            row += near ? '~' : got === want ? (got ? 'O' : '.') : (want ? 'x' : '!');
          }
          rows.push(row);
        }
        return rows;
      })() };
  }
  return JSON.stringify(report);
})()
"""

# Runs on the box. stdlib only (no pip / websocket-client there).
REMOTE_DRIVER = r"""#!/usr/bin/env python3
import base64, json, os, socket, struct, subprocess, sys, time, urllib.request

CHROME = os.path.expanduser(sys.argv[1])
PORT = int(sys.argv[2])
FLAGS = json.loads(sys.argv[3])
POLL = base64.b64decode(sys.argv[4]).decode()
SCREENSHOT = sys.argv[5]
SELFCHECK = base64.b64decode(sys.argv[6]).decode()
URL = "http://127.0.0.1:%d/index.html?autorun" % PORT


class MiniWS:
    # Minimal RFC6455 client for CDP text frames.

    def __init__(self, url):
        rest = url[len("ws://"):]
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=120)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            "GET /%s HTTP/1.1\r\nHost: %s:%s\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        assert b" 101 " in buf.split(b"\r\n", 1)[0] + b" ", buf[:120]
        self.buf = b""

    def send_text(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv_text(self, timeout=120):
        self.sock.settimeout(timeout)
        while True:
            if len(self.buf) >= 2:
                opcode = self.buf[0] & 0xF
                n = self.buf[1] & 0x7F
                offset = 0
                if n < 126:
                    offset = 2
                elif n == 126 and len(self.buf) >= 4:
                    n = struct.unpack(">H", self.buf[2:4])[0]
                    offset = 4
                elif n == 127 and len(self.buf) >= 10:
                    n = struct.unpack(">Q", self.buf[2:10])[0]
                    offset = 10
                if offset and len(self.buf) >= offset + n:
                    payload = self.buf[offset:offset + n]
                    self.buf = self.buf[offset + n:]
                    if opcode == 1:
                        return payload.decode(errors="replace")
                    continue
            self.buf += self.sock.recv(65536)


def main():
    cdp = 9321
    profile = "/tmp/lightmapper-verify-profile"
    subprocess.run(["rm", "-rf", profile], check=False)
    chrome = subprocess.Popen(
        [CHROME, "--headless", "--no-sandbox", "--disable-gpu-sandbox",
         "--user-data-dir=" + profile, "--remote-debugging-port=%d" % cdp,
         "--window-size=1280,3600"] + FLAGS + ["about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = None
        for _ in range(60):
            time.sleep(0.3)
            try:
                data = json.load(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json/list" % cdp, timeout=2))
                pages = [t for t in data if t.get("type") == "page"]
                if pages:
                    target = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                continue
        assert target, "no CDP target"
        ws = MiniWS(target)
        counter = [0]

        def call(method, params=None):
            counter[0] += 1
            rid = counter[0]
            ws.send_text(json.dumps({"id": rid, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(ws.recv_text())
                if msg.get("id") == rid:
                    if "error" in msg:
                        raise RuntimeError("%s: %s" % (method, msg["error"]))
                    return msg.get("result", {})

        call("Page.enable")
        call("Page.navigate", {"url": URL})
        state = None
        deadline = time.time() + 240
        while time.time() < deadline:
            res = call("Runtime.evaluate", {"expression": POLL, "returnByValue": True})
            state = json.loads(res["result"]["value"])
            text = (state.get("status") or "")
            if "baked" in text or "failed" in text or "threw" in text:
                break
            time.sleep(2)
        selfcheck = None
        if state and "baked" in (state.get("status") or ""):
            res = call("Runtime.evaluate", {"expression": SELFCHECK, "returnByValue": True})
            try:
                selfcheck = json.loads(res["result"]["value"])
            except Exception:
                selfcheck = {"error": str(res.get("result"))[:400]}
        if SCREENSHOT:
            shot = call("Page.captureScreenshot", {"format": "png"})
            with open(SCREENSHOT, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
        if state is not None:
            state["selfcheck"] = selfcheck
        print("RESULT " + json.dumps(state))
    finally:
        chrome.terminate()
        try:
            chrome.wait(10)
        except subprocess.TimeoutExpired:
            chrome.kill()


main()
"""


def rrun(ssh, cmd, timeout=120):
    _, out, err = ssh.exec_command(cmd, timeout=timeout)
    o, e = out.read().decode(errors="replace"), err.read().decode(errors="replace")
    return o, e


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--screenshot", default=None, help="download the page screenshot to this path")
    parser.add_argument("--port", type=int, default=8791)
    args = parser.parse_args()

    for var in ("SSH_HOST", "SSH_USER", "SSH_PASSWORD"):
        if var not in os.environ:
            sys.exit(f"{var} is not set — this check needs the verification box (AGENTS.md).")
    dist = os.path.join("demos", "cornell", "dist", "index.html")
    if not os.path.isfile(dist):
        sys.exit("demos/cornell/dist is missing — run `npm run build:demo` first.")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(os.environ["SSH_HOST"], username=os.environ["SSH_USER"],
                password=os.environ["SSH_PASSWORD"], timeout=20)
    try:
        home, _ = rrun(ssh, "echo $HOME")
        remote_dir = posixpath.join(home.strip(), "lightmapper-verify")
        rrun(ssh, f"rm -rf {remote_dir} && mkdir -p {remote_dir}/docroot")

        with tempfile.NamedTemporaryFile(suffix=".tgz", delete=False) as tmp:
            tar_path = tmp.name
        with tarfile.open(tar_path, "w:gz") as tar:
            tar.add(os.path.dirname(dist), arcname=".")
        sftp = ssh.open_sftp()
        sftp.put(tar_path, posixpath.join(remote_dir, "demo.tgz"))
        os.unlink(tar_path)
        with sftp.open(posixpath.join(remote_dir, "drive.py"), "w") as f:
            f.write(REMOTE_DRIVER)
        sftp.close()
        rrun(ssh, f"cd {remote_dir}/docroot && tar xzf ../demo.tgz")

        chrome = os.environ.get("CHROME_SHELL_PATH", DEFAULT_CHROME)
        shot_remote = "/tmp/lightmapper-verify.png" if args.screenshot else ""
        out, err = rrun(
            ssh,
            # NOTE: no pkill-by-pattern — the pattern would match this very
            # command line and kill the shell. The server is tracked by pid.
            "cd {d}/docroot && setsid python3 -m http.server {p} </dev/null >/dev/null 2>&1 & "
            "echo $! > /tmp/lightmapper-verify.pid; sleep 0.7; "
            "curl -s -o /dev/null -w 'serve: %{{http_code}}\\n' http://127.0.0.1:{p}/index.html; "
            "python3 {d}/drive.py '{c}' {p} '{f}' '{b}' '{s}' '{k}'; "
            "kill $(cat /tmp/lightmapper-verify.pid) 2>/dev/null; true".format(
                d=remote_dir, p=args.port, c=chrome,
                f=json.dumps(FLAGS).replace("'", "'\\''"),
                b=base64.b64encode(POLL_JS.encode()).decode(),
                s=shot_remote,
                k=base64.b64encode(SELFCHECK_JS.encode()).decode(),
            ),
            timeout=460,
        )
        print(out.strip())
        if err.strip():
            print("remote stderr:", err.strip()[-1500:], file=sys.stderr)

        if args.screenshot and shot_remote:
            sftp = ssh.open_sftp()
            try:
                sftp.get(shot_remote, args.screenshot)
                print(f"screenshot: {args.screenshot}")
            finally:
                sftp.close()
    finally:
        ssh.close()

    result_line = next((l for l in out.splitlines() if l.startswith("RESULT ")), None)
    if result_line is None:
        sys.exit("FAIL: the page never reported a result")
    state = json.loads(result_line[len("RESULT "):])
    status = state.get("status") or ""
    print("status:", status)
    for h in state.get("headings") or []:
        print(" ", h)

    ok = "baked" in status and bool(state.get("headings"))
    for heading in state.get("headings") or []:
        try:
            coverage = float(heading.split("coverage ")[1].split("%")[0])
        except (IndexError, ValueError):
            ok = False
            continue
        if coverage <= 0.0:
            ok = False
    if not ok:
        sys.exit("FAIL: no geometry in the baked atlases (see status above)")

    # Analytic content check (positions/normals of the planar fixture walls).
    selfcheck = state.get("selfcheck") or {}
    if "error" in selfcheck or not selfcheck:
        print("self-check:", selfcheck or "missing")
        sys.exit("FAIL: analytic self-check did not run")
    for rect in (selfcheck.get("layout") or {}).get("rects") or []:
        print(f"  rect: slice {rect['slice']} at ({rect['ox']}, {rect['oy']}) size {rect['w']}x{rect['h']}")
    for name, c in selfcheck.items():
        if name == "layout":
            continue
        if name == "unocclude":
            print(f"  unocclude: slice {c['slice']} ray {c['rayLen']:.4f} — checked {c['checked']} "
                  f"(skipped {c['skipped']} near thresholds) flagged {c['flagged']} "
                  f"expected {c['expected']} mismatches {c['mismatches']}")
            w = c.get("worst")
            if w:
                d = "inf" if w[4] is None else f"{w[4]:.4f}"
                print(f"    first mismatch at texel {w[0]},{w[1]} world ({w[2]:.4f}, {w[3]:.4f}) "
                      f"d={d} want {w[5]} got {w[6]}")
            if c["mismatches"]:
                print("    short-box footprint map ('O' flagged, 'x' missed, '~' near threshold):")
                for row in c.get("map") or []:
                    print("      " + row)
            # trace_ray + unocclude must agree with the analytic expectation;
            # the two box footprints guarantee a few thousand flagged texels.
            if c["mismatches"] or c["flagged"] < 1000 or c["checked"] < 50000:
                ok = False
            continue
        if name == "edgeExpansion":
            # Ring positions are NOT exact plane extrapolations: the expanded
            # vertices keep their original attributes, so a ring sample reads
            # the plane at (sample − barycentric-weighted vertex push), i.e.
            # up to ~1 texel along the surface (ADR-0007 note, 2026-11-26).
            # Upstream's 1-px wire lines interpolate exactly; this is the
            # measured, accepted delta. Normals are flat here → exact.
            texel_world = 5 / 245.76
            print(f"  edge expansion: floor chart border — {c['ringCovered']} ring texels covered, "
                  f"{c['ringEmpty']} beyond empty; missed {c['mustCover']}, bled {c['mustEmpty']}; "
                  f"ring maxPosErr {c['maxPosErr']:.6f} ({c['maxPosErr'] / texel_world:.2f} texels, "
                  f"≤ 1.1 by design) maxNrmErr {c['maxNrmErr']:.6f}")
            if c["worst"]:
                print(f"    worst ring texel {c['worst'][0]},{c['worst'][1]} ({c['worst'][2]:.2f} texel out): got "
                      f"({c['worst'][3]:.5f}, {c['worst'][4]:.5f}, {c['worst'][5]:.5f})")
            if c["mustCover"] or c["mustEmpty"] or c["ringCovered"] < 500 \
                    or c["maxPosErr"] > 1.1 * texel_world or c["maxNrmErr"] > 0.01:
                ok = False
            continue
        print(f"  {name}: slice {c['slice']} texels {c['count']} (un-occluded {c['pushed']} skipped) "
              f"uncovered {c['uncovered']} badAlpha {c['badAlpha']} "
              f"maxPosErr {c['maxPosErr']:.6f} maxNrmErr {c['maxNrmErr']:.6f}")
        if c.get("worst"):
            print(f"    worst texel {c['worst'][0]},{c['worst'][1]}: got "
                  f"({c['worst'][2]:.5f}, {c['worst'][3]:.5f}, {c['worst'][4]:.5f})")
        if c["count"] < 1000 or c["uncovered"] or c["badAlpha"]:
            ok = False
        # Wall charts are 256 texels over 4–5 world units → ≥ 0.0156 per
        # texel; an exact interpolation must be far below a quarter texel.
        if c["maxPosErr"] > 0.004 or c["maxNrmErr"] > 0.01:
            ok = False
    if not ok:
        sys.exit("FAIL: baked G-buffer content deviates from the fixture geometry")
    print("PASS: raster coverage + exact wall positions/normals, edge-expansion ring, "
          "and un-occlusion (trace_ray) all match the fixture analytically")


if __name__ == "__main__":
    main()
