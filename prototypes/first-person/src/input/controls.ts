// Keyboard + mouse input with pointer lock and rebindable keys (spec §3).
export type ActionName =
  | 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'jump' | 'dodge' | 'interact' | 'finish' | 'torch' | 'inspect' | 'map'
  | 'journal' | 'confirm' | 'camera';

export const DEFAULT_BINDINGS: Record<ActionName, string> = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft', jump: 'Space', dodge: 'KeyC', interact: 'KeyE',
  finish: 'KeyF', torch: 'KeyT', inspect: 'KeyQ', map: 'KeyM', journal: 'Tab', confirm: 'Enter', camera: 'KeyV',
};

export const ACTION_LABEL: Record<ActionName, string> = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right', sprint: 'Sprint', jump: 'Jump', dodge: 'Dodge',
  interact: 'Interact (bind, drag, drop, altar)', finish: 'Finish a downed monster', torch: 'Torch on/off', inspect: 'Inspect',
  map: 'Map', journal: 'Journal', confirm: 'Dismiss banner', camera: 'First / third person',
};

export interface Settings {
  sensitivity: number; // radians per pixel × 1000
  invertY: boolean;
  fov: number;
  volume: number;
  fxVolume: number;
  shadows: 'off' | 'low' | 'high';
  bindings: Record<ActionName, string>;
  /** over-the-shoulder camera instead of the champion's eyes */
  thirdPerson: boolean;
}

const KEY = 'hmfp:settings';

export function loadSettings(): Settings {
  const d: Settings = { sensitivity: 2.2, invertY: false, fov: 75, volume: 0.8, fxVolume: 1, shadows: 'high', bindings: { ...DEFAULT_BINDINGS }, thirdPerson: false };
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
  locked = false;
  lastInput = performance.now();
  /** one-shot presses since the last frame */
  private pressed = new Set<ActionName>();
  private clicked = false;
  onLockChange: (locked: boolean) => void = () => {};
  onAction: (a: ActionName) => void = () => {};
  rebinding: ActionName | null = null;
  onRebound: () => void = () => {};
  /** ?nolock=1: drag to look, no pointer lock (headless / devtools) */
  noLock = false;
  private dragging = false;

  constructor(private el: HTMLElement, public settings: Settings) {
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseL = this.mouseR = false;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) {
        this.keys.clear();
        this.mouseL = this.mouseR = false;
      }
      this.onLockChange(this.locked);
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.active) {
        if (this.noLock) this.dragging = true;
        return;
      }
      this.lastInput = performance.now();
      if (e.button === 0) {
        this.mouseL = true;
        this.clicked = true;
      }
      if (e.button === 2) this.mouseR = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
      this.dragging = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked && !(this.noLock && this.dragging)) return;
      this.lastInput = performance.now();
      const k = this.settings.sensitivity / 1000;
      this.dYaw -= e.movementX * k;
      this.dPitch -= e.movementY * k * (this.settings.invertY ? -1 : 1);
    });
  }

  /** Locked, or in no-lock dev mode. */
  get active() {
    return this.locked || this.noLock;
  }

  requestLock() {
    if (this.noLock) return;
    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  exitLock() {
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
      if (action === 'journal' || action === 'map' || action === 'confirm' || action === 'camera') {
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

  clearFrame() {
    this.pressed.clear();
  }
}
