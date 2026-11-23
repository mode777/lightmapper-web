/**
 * Demo shell: WebGPU capability probe + the M2 G-buffer stage runner.
 *
 * "Run M2 stage" bakes the fixture scene's G-buffer (raster split passes +
 * unocclude) and shows the position / normal / unocclude atlas slices —
 * the M2 exit criteria (docs/ROADMAP.md): "Pages demo shows correct
 * position/normal/unocclude atlases". Full Cornell bake lands in M6.
 */

import {
  bakeGBuffer,
  drawRgba8ToCanvas,
  normalToPreview,
  positionToPreview,
  unoccludeToPreview,
  type BakeGBufferResult,
} from '@lightmapper/core';
import { fixtureScene } from './fixture.js';

function setText(id: string, html: string): void {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function fmtBytes(n: number): string {
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
  if (n % 1024 === 0) return `${n / 1024} KiB`;
  return `${n} B`;
}

interface ProbeRow {
  name: string;
  value: string;
}

function limitsTable(rows: ProbeRow[]): string {
  return `<table>${rows.map((r) => `<tr><td>${r.name}</td><td>${r.value}</td></tr>`).join('')}</table>`;
}

let webgpuDevice: GPUDevice | null = null;

async function runProbe(): Promise<void> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    setText(
      'probe',
      `<p><span class="status-err">WebGPU is not available in this browser.</span></p>
       <p class="hint">Try a recent Chrome/Edge (113+), or Safari 18+ / iOS 18+. On Linux you may need
       <code>chrome://flags/#enable-unsafe-webgpu</code>. Headless/CI recipes are documented in
       docs/ROADMAP.md §Verification.</p>`,
    );
    return;
  }

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) {
    setText(
      'probe',
      `<p><span class="status-warn">WebGPU exists but no adapter was returned</span> (possible on GPU-less machines or blocklisted drivers).</p>`,
    );
    return;
  }

  let device: GPUDevice | null = null;
  try {
    device = await adapter.requestDevice();
  } catch {
    device = null;
  }
  if (!device) {
    setText('probe', `<p><span class="status-err">Adapter found but device creation failed.</span></p>`);
    return;
  }
  webgpuDevice = device;
  const runButton = document.getElementById('run-m2') as HTMLButtonElement | null;
  runButton?.removeAttribute('disabled');
  setText('m2-status', 'Ready — click Run M2 stage.');

  const info = adapter.info;
  const limits = device.limits;
  const rows: ProbeRow[] = [
    { name: 'adapter', value: `${info.vendor || '?'} / ${info.architecture || '?'} ${info.device || ''}`.trim() },
    { name: 'maxTextureDimension2D', value: String(limits.maxTextureDimension2D) },
    { name: 'maxStorageBuffersPerShaderStage', value: String(limits.maxStorageBuffersPerShaderStage) },
    { name: 'maxStorageBufferBindingSize', value: fmtBytes(limits.maxStorageBufferBindingSize) },
    { name: 'maxColorAttachmentBytesPerSample', value: String(limits.maxColorAttachmentBytesPerSample) },
    { name: 'float32-filterable', value: adapter.features.has('float32-filterable') ? 'yes' : 'no (panorama → rgba16f, ADR-0006)' },
  ];

  setText(
    'probe',
    `<p><span class="status-ok">WebGPU is working.</span></p>${limitsTable(rows)}`,
  );

  // A real (tiny) render pass: clear the canvas to teal.
  const canvas = document.getElementById('clear-canvas') as HTMLCanvasElement;
  const context = canvas.getContext('webgpu');
  if (!context) return;
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.16, g: 0.72, b: 0.6, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
}

/* ------------------------------------------------------------------ */
/* M2 stage runner                                                     */
/* ------------------------------------------------------------------ */

const ERROR_MESSAGES: Record<string, string> = {
  noWebGPU: 'WebGPU is not available in this browser.',
  noAdapter: 'No WebGPU adapter was returned.',
  deviceRequestFailed: 'GPUDevice creation failed.',
  noMeshes: 'The fixture scene has no meshes (bug).',
  meshMissingUv2: 'A fixture mesh is missing UV2 (bug).',
  lightmapTooSmall: 'A lightmap size computed to zero.',
  textureExceedsDeviceLimit: 'Atlas exceeds the device texture size limit.',
  textureExceedsMaxSize: 'Atlas exceeds the configured maximum size.',
  atlasTooSmall: 'Atlas packing failed (atlas too small).',
  deviceLost: 'The GPU device was lost during the bake.',
  aborted: 'Bake cancelled.',
};

function addSliceView(
  container: HTMLElement,
  title: string,
  image: { width: number; height: number; data: Uint8Array<ArrayBuffer> },
): void {
  const block = document.createElement('div');
  block.className = 'slice-view';
  const label = document.createElement('p');
  label.textContent = title;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  if (ctx) drawRgba8ToCanvas(ctx, image);
  block.append(label, canvas);
  container.append(block);
}

async function runM2Stage(): Promise<void> {
  const output = document.getElementById('m2-output');
  const status = document.getElementById('m2-status');
  const button = document.getElementById('run-m2') as HTMLButtonElement | null;
  if (!output || !status) return;
  button?.setAttribute('disabled', 'true');
  output.textContent = '';
  status.textContent = 'Baking G-buffer…';

  const t0 = performance.now();
  try {
    const result: BakeGBufferResult = await bakeGBuffer(fixtureScene(), {
      device: webgpuDevice ?? undefined,
      atlasMaxSize: 1024,
      bias: 0.01,
      denoise: { strength: 1, range: 8 },
      onProgress: (fraction, message) => {
        status.textContent = `${message} (${Math.round(fraction * 100)}%)`;
        return true;
      },
    });

    if (!result.ok) {
      status.innerHTML = `<span class="status-err">Bake failed: ${ERROR_MESSAGES[result.error] ?? result.error}</span>`;
      return;
    }

    const ms = Math.round(performance.now() - t0);
    result.destroy(); // readbacks stay valid; free the GPU side
    status.innerHTML =
      `<span class="status-ok">G-buffer baked in ${ms} ms.</span> ` +
      `Atlas ${result.atlasSize[0]}×${result.atlasSize[1]} × ${result.atlasSlices} slice(s), ` +
      `${result.meshRects.length} mesh(es).`;

    for (let slice = 0; slice < result.atlasSlices; slice++) {
      const heading = document.createElement('h3');
      heading.textContent = `Atlas slice ${slice}`;
      output.append(heading);
      const row = document.createElement('div');
      row.className = 'slice-row';
      addSliceView(row, 'position (bounds-normalized RGB)', positionToPreview(result.position[slice], result.bounds));
      addSliceView(row, 'normal (0.5·n+0.5)', normalToPreview(result.normal[slice]));
      addSliceView(row, 'unocclude mask (red)', unoccludeToPreview(result.unocclude[slice]));
      output.append(row);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.innerHTML = `<span class="status-err">Bake threw: ${message}</span>`;
    if (error instanceof Error && error.stack) {
      console.error(error);
    }
  } finally {
    button?.removeAttribute('disabled');
  }
}

function wireM2Runner(): void {
  const button = document.getElementById('run-m2');
  if (!button) return;
  button.addEventListener('click', () => void runM2Stage());
}

void runProbe();
wireM2Runner();
