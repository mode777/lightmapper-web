/**
 * Worker entry for @lightmapper/unwrap — runs the xatlas wasm off the
 * main thread (ARCHITECTURE §5: unwrap runs in a Web Worker with
 * transferable typed arrays).
 *
 * Message protocol:
 *   -> { type: 'unwrap', id, input: UnwrapInput }
 *   <- { type: 'result', id, result }              (transferable buffers)
 *   <- { type: 'error', id, message }
 */

import { unwrapMesh, type UnwrapInput } from './index.js';

export interface UnwrapRequestMessage {
  type: 'unwrap';
  id: number;
  input: UnwrapInput;
}

export type UnwrapResponseMessage =
  | {
      type: 'result';
      id: number;
      result: {
        uv: Float32Array;
        vertexMap: Uint32Array;
        indices: Uint32Array;
        vertexCount: number;
        indexCount: number;
        sizeHint: [number, number];
      };
    }
  | { type: 'error'; id: number; message: string };

export async function handleRequest(input: UnwrapInput) {
  return unwrapMesh(input);
}

self.addEventListener('message', async (event: MessageEvent<UnwrapRequestMessage>) => {
  const data = event.data;
  if (data?.type !== 'unwrap') {
    return;
  }
  try {
    const result = await handleRequest(data.input);
    const response: UnwrapResponseMessage = {
      type: 'result',
      id: data.id,
      result: {
        uv: result.uv,
        vertexMap: result.vertexMap,
        indices: result.indices,
        vertexCount: result.vertexCount,
        indexCount: result.indexCount,
        sizeHint: result.sizeHint,
      },
    };
    (self as unknown as Worker).postMessage(response, [
      response.result.uv.buffer,
      response.result.vertexMap.buffer,
      response.result.indices.buffer,
    ]);
  } catch (error) {
    const response: UnwrapResponseMessage = {
      type: 'error',
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
});
