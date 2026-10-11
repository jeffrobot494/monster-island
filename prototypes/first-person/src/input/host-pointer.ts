// RUN.world builds only (VITE_RUNDOT, set by `npm run build:run`). The game iframe is not allowed to lock the pointer
// itself (its sandbox lacks allow-pointer-lock), so the host locks its own document instead (System API:
// requestFullscreen({ pointerLock }) / setPointerLock) and forwards mouse moves and buttons to the game.
// https://series-1.gitbook.io/rundot-docs/readme/system

export type HostPointerInput =
  | { type: 'move'; movementX: number; movementY: number; buttons: number }
  | { type: 'button'; button: number; buttons: number; pressed: boolean }
  | { type: 'wheel'; deltaX: number; deltaY: number; deltaZ: number; deltaMode: number };

interface FullscreenState { active: boolean; pointerLocked: boolean; reason?: string }

/** The slice of RundotGameAPI.system used here. */
interface SystemApi {
  getEnvironment(): { capabilities?: { fullscreen?: 'unavailable' | 'always-on' | 'toggleable'; pointerLock?: boolean } };
  requestFullscreen(options?: { pointerLock?: boolean }): Promise<FullscreenState>;
  setPointerLock(locked: boolean): Promise<FullscreenState>;
  onFullscreenStateChange(listener: (s: FullscreenState) => void): () => void;
  onPointerInput(listener: (i: HostPointerInput) => void): () => void;
}

export interface HostPointer {
  /** Capture the cursor. Call straight from a click or key handler: it must be the first async step of the gesture. */
  request(): void;
  release(): void;
  onLock: (locked: boolean) => void;
  onInput: (i: HostPointerInput) => void;
}

/** The host's pointer lock, or null when this is not a RUN.world build or the host cannot lock the pointer. */
export async function loadHostPointer(): Promise<HostPointer | null> {
  if (!import.meta.env.VITE_RUNDOT) return null;
  // The SDK is vendored beside index.html (scripts/vendor-rundot.mjs), not bundled. The same URL as its <script>
  // tag, so this is the same, already initialising, module instance.
  const url = new URL('vendor/rundot-sdk/rundot-game-api/index.js', document.baseURI).href;
  let sys: SystemApi;
  try {
    sys = (await import(/* @vite-ignore */ url)).default.system;
  } catch (err) {
    console.warn('[host-pointer] RUN.world SDK failed to load', err);
    return null;
  }
  // getEnvironment throws until the SDK's on-import initialisation finishes
  let caps: ReturnType<SystemApi['getEnvironment']>['capabilities'];
  for (let i = 0; i < 100 && !caps; i++) {
    try {
      caps = sys.getEnvironment().capabilities ?? {};
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!caps?.pointerLock) {
    console.warn('[host-pointer] the host cannot lock the pointer', caps);
    return null;
  }

  let fullscreen = false;
  const host: HostPointer = {
    request() {
      const p = fullscreen || caps.fullscreen === 'always-on' ? sys.setPointerLock(true) : sys.requestFullscreen({ pointerLock: true });
      p.then(apply, (err) => console.warn('[host-pointer] lock request failed', err));
    },
    release() {
      sys.setPointerLock(false).then(apply, () => {});
    },
    onLock: () => {},
    onInput: () => {},
  };
  function apply(s: FullscreenState) {
    fullscreen = s.active;
    // a refusal is normal (Escape just pressed, focus lost): the player clicks again
    if (s.reason) console.info(`[host-pointer] not locked: ${s.reason}`);
    host.onLock(s.pointerLocked);
  }
  sys.onFullscreenStateChange(apply);
  sys.onPointerInput((i) => host.onInput(i));
  return host;
}
