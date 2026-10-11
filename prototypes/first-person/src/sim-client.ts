import type { MainToSim, SimToMain } from './protocol';

type Handler = (m: SimToMain) => void;

const WATCHDOG_MS = 15000;

/** Main-thread owner of the sim worker: messaging, sequence checks, and the hang watchdog (§7). */
export class SimClient {
  private worker: Worker | null = null;
  private lastSeq = 0;
  private lastFrameAt = performance.now();
  private awaitingResync = false;
  paused = false;
  onMessage: Handler = () => {};
  onHang: () => void = () => {};

  constructor() {
    setInterval(() => this.checkWatchdog(), 1000);
  }

  start(init: Omit<Extract<MainToSim, { type: 'init' }>, 'type'>) {
    this.worker?.terminate();
    this.worker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<SimToMain>) => this.handle(ev.data);
    this.worker.onerror = (ev) => console.error('[sim worker]', ev.message, ev.filename, ev.lineno);
    this.worker.onmessageerror = () => console.error('[sim worker] message error');
    this.lastSeq = 0;
    this.lastFrameAt = performance.now() + 10000; // grace period while loading
    this.post({ type: 'init', ...init });
  }

  /** Kill the worker for good: no more frames, saves or watchdog restarts. */
  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.paused = true;
  }

  post(m: MainToSim) {
    this.worker?.postMessage(m);
  }

  setPaused(paused: boolean) {
    if (this.paused && !paused) this.lastFrameAt = performance.now() + 5000;
    this.paused = paused;
    this.post({ type: 'control', paused });
  }

  private handle(m: SimToMain) {
    if (m.type === 'frame' || m.type === 'fullState') {
      this.lastFrameAt = performance.now();
      if (m.type === 'fullState') {
        this.lastSeq = m.seq;
        this.awaitingResync = false;
      } else {
        if (this.awaitingResync) return;
        if (this.lastSeq && m.seq !== this.lastSeq + 1) {
          this.awaitingResync = true;
          this.post({ type: 'resync' });
          return;
        }
        if (!(m.ents instanceof Float32Array) || !Array.isArray(m.tiles)) {
          this.awaitingResync = true;
          this.post({ type: 'resync' });
          return;
        }
        this.lastSeq = m.seq;
      }
    }
    this.onMessage(m);
  }

  private checkWatchdog() {
    if (!this.worker || this.paused || document.hidden) {
      this.lastFrameAt = Math.max(this.lastFrameAt, performance.now() - 1000);
      return;
    }
    if (performance.now() - this.lastFrameAt > WATCHDOG_MS) {
      this.worker.terminate();
      this.worker = null;
      this.onHang();
    }
  }
}
