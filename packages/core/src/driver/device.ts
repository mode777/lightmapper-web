/**
 * Private GPUDevice acquisition for the bake driver (browser only).
 *
 * Provenance (semantics): LightmapperRD::bake creates a *local rendering
 * device* off the RenderingServer (or a platform RenderingContextDriver)
 * @ 67421f36e5069e62573c44beb8dd2f8f91e065b0.
 * License: MIT (Godot Engine contributors; see NOTICE.md)
 *
 * PORT: the browser equivalent is a fresh GPUDevice from an adapter request
 * (`powerPreference` selects the GPU). No canvas is required — all bake
 * targets are offscreen (ARCHITECTURE §5).
 */

import { assertSpecConstants } from './gpu-constants.js';

export interface DeviceRequestOptions {
  /** Bring your own device (skips adapter/device creation). */
  device?: GPUDevice;
  powerPreference?: 'high-performance' | 'low-power';
}

export type DeviceRequestResult =
  | { ok: true; device: GPUDevice; owned: boolean }
  | { ok: false; error: 'noWebGPU' | 'noAdapter' | 'deviceRequestFailed' };

/** Request the private device used by all bake stages. */
export async function requestBakeDevice(options: DeviceRequestOptions = {}): Promise<DeviceRequestResult> {
  // The driver uses spec-constant usage flags instead of the runtime
  // globals (node-testable); make sure this platform agrees with them.
  assertSpecConstants();
  if (options.device !== undefined) {
    return { ok: true, device: options.device, owned: false };
  }
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return { ok: false, error: 'noWebGPU' };
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({
      powerPreference: options.powerPreference ?? 'high-performance',
    });
  } catch {
    adapter = null;
  }
  if (adapter === null) {
    return { ok: false, error: 'noAdapter' };
  }
  try {
    const device = await adapter.requestDevice();
    return { ok: true, device, owned: true };
  } catch {
    return { ok: false, error: 'deviceRequestFailed' };
  }
}

/**
 * Watch `device.lost`; resolves with the loss reason when the device dies.
 * The driver races this against stage execution (ARCHITECTURE §6).
 */
export function raceDeviceLost(device: GPUDevice): Promise<GPUDeviceLostInfo> {
  return new Promise<GPUDeviceLostInfo>((resolve) => {
    void device.lost.then((info) => resolve(info));
  });
}
