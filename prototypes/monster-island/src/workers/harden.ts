// Runtime hardening for workers that run generated code (§4). Import this FIRST in a worker entry.
// The host keeps private references; generated code sees throwing stubs or nothing.
const g = globalThis as any;

export const hostNow: () => number = g.performance.now.bind(g.performance);
export const hostSetTimeout: (fn: () => void, ms: number) => number = g.setTimeout.bind(g);
export const hostClearTimeout: (id: number) => void = g.clearTimeout.bind(g);
export const hostPost: (msg: unknown, transfer?: Transferable[]) => void = g.postMessage.bind(g);
export const hostCreateBlobUrl = (source: string) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
export const hostRevokeUrl = (url: string) => URL.revokeObjectURL(url);

let hardened = false;

export function harden() {
  if (hardened) return;
  hardened = true;
  const stub = (name: string, hint: string) =>
    function blocked() {
      throw new Error(`${name} is not available to island modules (${hint})`);
    };
  Math.random = stub('Math.random', 'use api.rand()');
  const DateStub = stub('Date', 'use api.time');
  Object.defineProperty(g, 'Date', { value: DateStub, configurable: false, writable: false });
  Object.defineProperty(g.performance, 'now', { value: stub('performance.now', 'timing is host-only'), configurable: false });
  Object.defineProperty(g, 'crypto', { get: stub('crypto', 'use api.rand()'), configurable: false });
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'EventSource', 'indexedDB', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'postMessage', 'close', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker']) {
    try {
      Object.defineProperty(g, name, { value: undefined, configurable: false, writable: false });
    } catch {
      /* not present in this environment */
    }
  }
}
