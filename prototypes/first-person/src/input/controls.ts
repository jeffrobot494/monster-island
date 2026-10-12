// Keyboard + mouse input with pointer lock and rebindable keys (spec §3).
import type { HostPointer } from './host-pointer';
export type ActionName =
  | 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'jump' | 'dodge' | 'interact' | 'finish' | 'torch' | 'sword' | 'spear' | 'throw' | 'inspect'
  | 'map' | 'minimap' | 'journal' | 'confirm' | 'camera';

export const DEFAULT_BINDINGS: Record<ActionName, string> = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft', jump: 'Space', dodge: 'KeyC', interact: 'KeyE',
  finish: 'KeyF', torch: 'KeyT', sword: 'Digit1', spear: 'Digit2', throw: 'KeyR', inspect: 'KeyQ', map: 'KeyM', minimap: 'KeyZ', journal: 'Tab', confirm: 'Enter', camera: 'KeyV',
};

export const ACTION_LABEL: Record<ActionName, string> = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right', sprint: 'Sprint', jump: 'Jump', dodge: 'Dodge',
  interact: 'Interact (bind, drag, drop, altar)', finish: 'Finish a downed monster', torch: 'Torch on/off', sword: 'Sword', spear: 'Spear', throw: 'Throw the spear in hand', inspect: 'Inspect',
  map: 'Map', minimap: 'Minimap range', journal: 'Journal', confirm: 'Dismiss banner', camera: 'First / third person',
};

export interface Settings {
  sensitivity: number; // radians per pixel × 1000
  invertY: boolean;
  fov: number;
  volume: number;
  fxVolume: number;
  shadows: 'off' | 'low' | 'high';
  bindings: Record<ActionName, string>;
  /** meters from you to the minimap's rim (60, 120 or 250; Z steps through them; 120 when unset) */
  minimapRange?: number;
  /** over-the-shoulder camera instead of the champion's eyes */
  thirdPerson: boolean;
  /** going into the game goes fullscreen, holding Esc for the game: Esc pauses and resumes (Chrome, Edge) */
  fullscreen: boolean;
}

const KEY = 'hmfp:settings';

export function loadSettings(): Settings {
  const d: Settings = { sensitivity: 2.2, invertY: false, fov: 75, volume: 0.8, fxVolume: 1, shadows: 'high', bindings: { ...DEFAULT_BINDINGS }, thirdPerson: false, fullscreen: true };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && typeof s === 'object') {
      const b = { ...d.bindings, ...(s.bindings ?? {}) };
      // settings saved before jump existed had Space on dodge
      if (!s.bindings?.jump && b.dodge === 'Space') b.dodge = DEFAULT_BINDINGS.dodge;
      return { ...d, ...s, bindings: b };
    }
  } catch {
    /* storage unavailable */
  }
  return d;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return ({ ShiftLeft: 'Shift', ShiftRight: 'R-Shift', Space: 'Space', ControlLeft: 'Ctrl', Tab: 'Tab', Enter: 'Enter', Escape: 'Esc' } as Record<string, string>)[code] ?? code;
}

export class Controls {
  keys = new Set<string>();
  mouseL = false;
  mouseR = false;
  /** accumulated look deltas since the last read (radians) */
  dYaw = 0;
  dPitch = 0;
  /** the mouse wheel: a notch since the last frame (+1 down, -1 up), what's been scrolled toward the next, and when
   *  the next can come (a trackpad's flick is many small events) */
  private wheelStep = 0;
  private wheelAcc = 0;
  private wheelReady = 0;
  locked = false;
  lastInput = performance.now();
  /** one-shot presses since the last frame */
  private pressed = new Set<ActionName>();
  private clicked = false;
  onLockChange: (locked: boolean) => void = () => {};
  /** the browser wouldn't hand over the pointer: after the player's own Esc it takes a click, which a key isn't */
  onLockRefused: () => void = () => {};
  onAction: (a: ActionName) => void = () => {};
  rebinding: ActionName | null = null;
  onRebound: () => void = () => {};
  /** ?nolock=1: drag to look, no pointer lock (headless / devtools) */
  noLock = false;
  private dragging = false;
  /** Chrome on Windows sometimes reports one huge bogus movementX/Y under pointer lock (and right after locking);
   *  those read as a 180° flick. Track a running average of real motion to spot and drop them. */
  private lockedAt = 0;
  private avgMove = 0;
  private host: HostPointer | null = null;

  constructor(private el: HTMLElement, public settings: Settings) {
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseL = this.mouseR = false;
    });
    document.addEventListener('pointerlockchange', () => this.setLocked(document.pointerLockElement === this.el));
    document.addEventListener('pointerlockerror', () => this.onLockRefused());
    el.addEventListener('mousedown', (e) => {
      if (!this.active) {
        if (this.noLock) this.dragging = true;
        return;
      }
      if (!this.host) this.button(e.button, true);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
      this.dragging = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (this.host ? !(this.noLock && this.dragging) : !this.locked && !(this.noLock && this.dragging)) return;
      this.look(e.movementX, e.movementY);
    });
    // under the RUN host's lock the wheel comes through it (useHost)
    window.addEventListener('wheel', (e) => {
      if (!this.host || this.noLock) this.wheel(e.deltaY, e.deltaMode);
    }, { passive: true });
  }

  /** RUN.world: the host holds the pointer lock and forwards the mouse (input/host-pointer.ts). */
  useHost(host: HostPointer) {
    this.host = host;
    host.onLock = (locked) => this.setLocked(locked);
    host.onInput = (i) => {
      if (!this.locked) return;
      if (i.type === 'move') this.look(i.movementX, i.movementY);
      else if (i.type === 'wheel') this.wheel(i.deltaY, i.deltaMode);
      else if (i.type === 'button') {
        if (i.pressed) this.button(i.button, true);
        else if (i.button === 0) this.mouseL = false;
        else if (i.button === 2) this.mouseR = false;
      }
    };
  }

  private setLocked(locked: boolean) {
    if (locked === this.locked) return;
    this.locked = locked;
    this.lockedAt = performance.now();
    this.avgMove = 0;
    if (!locked) {
      this.keys.clear();
      this.mouseL = this.mouseR = false;
    }
    this.onLockChange(locked);
  }

  private button(b: number, down: boolean) {
    this.lastInput = performance.now();
    if (b === 0) {
      this.mouseL = down;
      if (down) this.clicked = true;
    }
    if (b === 2) this.mouseR = down;
  }

  private look(dx: number, dy: number) {
    const now = performance.now();
    this.lastInput = now;
    // under pointer lock (ours or the RUN host's), drop the bogus spikes described at lockedAt
    if (this.locked) {
      if (now - this.lockedAt < 100) return; // the first events after locking carry the cursor's jump to center
      const mag = Math.abs(dx) + Math.abs(dy);
      if (mag > 200 && mag > 6 * this.avgMove + 40) return; // a spike far beyond the recent motion: discard it
      this.avgMove += (mag - this.avgMove) * 0.2;
    }
    const k = this.settings.sensitivity / 1000;
    this.dYaw -= dx * k;
    this.dPitch -= dy * k * (this.settings.invertY ? -1 : 1);
  }

  /** Locked, or in no-lock dev mode. */
  get active() {
    return this.locked || this.noLock;
  }

  /**
   * Fullscreen with the Esc key held by the page (the Keyboard Lock API: Chrome, Edge). Then a short Esc reaches the
   * game instead of making the browser free the pointer, so the game frees it itself and can take it back on the next
   * Esc with no click (a browser asks for one only after its own Esc). Holding Esc leaves fullscreen.
   */
  get canHoldEsc(): boolean {
    return !!(navigator as { keyboard?: { lock?: unknown } }).keyboard?.lock && document.fullscreenEnabled && !this.host && !this.noLock;
  }

  requestLock() {
    if (this.noLock) return;
    if (this.host) return this.host.request();
    if (this.settings.fullscreen && this.canHoldEsc && !document.fullscreenElement) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      (navigator as unknown as { keyboard: { lock(keys: string[]): Promise<void> } }).keyboard.lock(['Escape']).catch(() => {});
    }
    // raw input where supported: sidesteps the OS acceleration path that produces most of the spikes
    const req = (opts?: object) => (this.el.requestPointerLock as (o?: object) => unknown).call(this.el, opts) as Promise<void> | undefined;
    let p: Promise<void> | undefined;
    try {
      p = req({ unadjustedMovement: true });
    } catch {
      p = req();
    }
    if (p && typeof p.catch === 'function') p.catch(() => req()?.catch?.(() => {}));
  }

  exitLock() {
    if (this.host) {
      if (this.locked) this.host.release();
      return;
    }
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private keyDown(e: KeyboardEvent) {
    if (this.rebinding) {
      e.preventDefault();
      if (e.code !== 'Escape') this.settings.bindings[this.rebinding] = e.code;
      this.rebinding = null;
      this.onRebound();
      return;
    }
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
    const b = this.settings.bindings;
    const action = (Object.keys(b) as ActionName[]).find((a) => b[a] === e.code);
    if (action === 'journal' || e.code === 'Tab') e.preventDefault();
    if (e.code === 'Space' && this.active) e.preventDefault();
    this.lastInput = performance.now();
    if (!e.repeat && action) {
      // UI toggles work with or without the lock
      if (action === 'journal' || action === 'map' || action === 'minimap' || action === 'confirm' || action === 'camera') {
        this.onAction(action);
        return;
      }
      if (this.active) this.pressed.add(action);
    }
    if (this.active) this.keys.add(e.code);
  }

  down(a: ActionName): boolean {
    return this.active && this.keys.has(this.settings.bindings[a]);
  }

  /** Consume a one-shot press. */
  take(a: ActionName): boolean {
    const had = this.pressed.has(a);
    this.pressed.delete(a);
    return had;
  }

  takeClick(): boolean {
    const c = this.clicked;
    this.clicked = false;
    return c;
  }

  readLook(): [number, number] {
    const r: [number, number] = [this.dYaw, this.dPitch];
    this.dYaw = this.dPitch = 0;
    return r;
  }

  /** One wheel notch is a step (a mouse sends ~100 px or 3 lines a notch); at most one every 150 ms. */
  private wheel(dy: number, mode: number) {
    if (!this.active || !dy) return;
    this.lastInput = performance.now();
    this.wheelAcc += mode === 1 ? dy * 40 : mode === 2 ? dy * 800 : dy;
    if (Math.abs(this.wheelAcc) < 50 || performance.now() < this.wheelReady) return;
    this.wheelStep = Math.sign(this.wheelAcc);
    this.wheelAcc = 0;
    this.wheelReady = performance.now() + 150;
  }

  /** Consume a wheel notch: +1 (down), -1 (up) or 0. */
  takeWheel(): number {
    const s = this.wheelStep;
    this.wheelStep = 0;
    return s;
  }

  clearFrame() {
    this.pressed.clear();
    this.wheelStep = 0;
  }
}
