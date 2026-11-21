/**
 * Demo shell: WebGPU capability probe + clear pass.
 *
 * The actual Cornell-box bake lands here in roadmap milestone M6
 * (docs/ROADMAP.md). Until then this page verifies that WebGPU works on the
 * visitor's browser and surfaces the device limits the lightmapper cares
 * about (docs/RISKS.md R2, R6, R7).
 */

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

  const info = adapter.info;
  const limits = device.limits;
  const rows: ProbeRow[] = [
    { name: 'adapter', value: `${info.vendor || '?'} / ${info.architecture || '?'} ${info.device || ''}`.trim() },
    { name: 'maxTextureDimension2D', value: String(limits.maxTextureDimension2D) },
    { name: 'maxTextureArrayLayers', value: String(limits.maxTextureArrayLayers) },
    { name: 'maxComputeInvocationsPerWorkgroup', value: String(limits.maxComputeInvocationsPerWorkgroup) },
    { name: 'maxComputeWorkgroupsPerDimension', value: String(limits.maxComputeWorkgroupsPerDimension) },
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

void runProbe();
