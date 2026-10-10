import type { MainToSim, ModuleSource, SimToMain } from './protocol';

type Handler = (m: SimToMain) => void;

const WATCHDOG_MS = 5000;

/** Main-thread owner of the sim worker: messaging, sequence checks, and the hang watchdog (§7). */
export class SimClient {
  private worker: Worker | null = null;
  private lastSeq = 0;
  private lastFrameAt = performance.now();
  private awaitingResync = false;
  paused = false;
  speed = 1;
  onMessage: Handler = () => {};
  onHang: () => void = () => {};

  constructor() {
    setInterval(() => this.checkWatchdog(), 1000);
  }

  start(init: { save: string | null; seed: number; modules: ModuleSource[]; quarantine?: string[]; skip?: number }) {
    this.worker?.terminate();
    this.worker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<SimToMain>) => this.handle(ev.data);
    this.worker.onerror = (ev) => console.error('[sim worker]', ev.message, ev.filename, ev.lineno);
    this.worker.onmessageerror = () => console.error('[sim worker] message error');
    this.lastSeq = 0;
    this.lastFrameAt = performance.now() + 10000; // grace period while loading
    this.post({ type: 'init', ...init, speed: this.speed, paused: this.paused });
  }

  post(m: MainToSim) {
    this.worker?.postMessage(m);
  }

  setControl(c: { speed?: number; paused?: boolean }) {
    if (c.speed !== undefined) this.speed = c.speed;
    if (c.paused !== undefined) {
      if (this.paused && !c.paused) this.lastFrameAt = performance.now();
      this.paused = c.paused;
    }
    this.post({ type: 'control', ...c });
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
