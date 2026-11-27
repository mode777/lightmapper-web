import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccelWorkerHost } from '../src/accel/accel-worker-client.js';

/**
 * AccelWorkerHost must never leave build() pending: a worker that fails to
 * load, throws at top level, or gets a message error produces no "result"
 * message, so those paths need explicit rejection (browser-only class; a
 * fake Worker stands in here).
 */
class FakeWorker extends EventTarget {
  terminated = false;
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Deliver a worker reply the way the real Worker would. */
  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const g = globalThis as unknown as { Worker: unknown };
let original: unknown;
let worker: FakeWorker;

beforeEach(() => {
  original = g.Worker;
  worker = new FakeWorker();
  g.Worker = class {
    constructor() {
      return worker;
    }
  };
});

afterEach(() => {
  g.Worker = original;
});

const input = {
  meshes: [],
  atlasSize: [64, 64] as [number, number],
  atlasSlices: 1,
  probePositions: null,
};

describe('AccelWorkerHost — no path may hang', () => {
  it('resolves with the worker result', async () => {
    const host = new AccelWorkerHost();
    const pending = host.build(input);
    expect(worker.posted).toHaveLength(1);
    worker.reply({ type: 'result', id: 1, result: { marker: true } });
    await expect(pending).resolves.toEqual({ marker: true });
  });

  it('rejects on a worker error reply', async () => {
    const host = new AccelWorkerHost();
    const pending = host.build(input);
    worker.reply({ type: 'error', id: 1, message: 'boom' });
    await expect(pending).rejects.toThrow(/accel worker: boom/);
  });

  it('rejects on a script-load failure / top-level throw (no message at all)', async () => {
    const host = new AccelWorkerHost();
    const pending = host.build(input);
    worker.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow(/accel worker: failed to load/);
  });

  it('rejects on a message error', async () => {
    const host = new AccelWorkerHost();
    const pending = host.build(input);
    worker.dispatchEvent(new Event('messageerror'));
    await expect(pending).rejects.toThrow(/accel worker: message error/);
  });

  it('rejects pending builds on dispose and terminates the worker', async () => {
    const host = new AccelWorkerHost();
    const a = host.build(input);
    const b = host.build(input);
    host.dispose();
    await expect(a).rejects.toThrow(/accel worker: disposed/);
    await expect(b).rejects.toThrow(/accel worker: disposed/);
    expect(worker.terminated).toBe(true);
  });

  it('ignores replies for unknown ids and settles each build only once', async () => {
    const host = new AccelWorkerHost();
    const pending = host.build(input);
    worker.reply({ type: 'error', id: 999, message: 'stale' }); // ignored
    worker.reply({ type: 'result', id: 1, result: { ok: 1 } });
    worker.reply({ type: 'error', id: 1, message: 'late' }); // already settled
    await expect(pending).resolves.toEqual({ ok: 1 });
  });
});
