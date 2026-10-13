// Boot and wiring for the first-person desktop game (spec §3–§12): sim worker, renderer, controller, HUD, journal,
// map, audio, and the creation pipeline.
import * as THREE from 'three';
import { Renderer } from './render/renderer';
import { SimClient } from './sim-client';
import { Ui, h } from './ui/ui';
import { HudView, type CompassMarker, type TargetInfo } from './ui/hud';
import { WorldMap, type MapMarker } from './ui/map';
import { Minimap, type MinimapDot } from './ui/minimap';
import { pickPlatform } from './platform';
import { KEYS } from './persist/save-store';
import { CreationPipeline } from './god/pipeline';
import { runValidation } from './god/validation-host';
import type { SavedWorld } from './sim/island';
import type { ChronicleEvent, CreationRecord, Entity, Zone } from './sim/types';
import { F_ANIMAL, F_BOUND, F_CORPSE, F_DOWNED, F_HUMAN, F_ITEM, F_MONSTER, F_SHAKE, F_TELEGRAPH, F_HITTABLE, type FramePayload, type Hud, type MonsterCard, type NameInfo, type SimToMain } from './protocol';
import { GAME_TIMESCALE } from './sim/clock';
import type { Alert } from './sim/sim';
import type { CtrlReason } from './sim/champion';
import { loadHostPointer } from './input/host-pointer';
import { Controls, loadSettings, saveSettings, keyLabel, ACTION_LABEL, type ActionName } from './input/controls';
import { ChampionController, EYE_H } from './input/controller';
import { Mounts, bodyCaps, bodyDist } from './render/climb-rig';
import { CLIMB, capZone } from './sim/climb-body';
import { BODY, SHAPE_M, axisDist, bodyR } from './sim/body';
import { GameAudio } from './audio/audio';
import { M } from './sim/ground';
import { zoneFor } from './sim/aim';
import { REGION_NAMES } from './sim/island-gen';
import { checkSettings, DEFAULT_SETTINGS, type TerrainSettings } from './sim/terrain-import';
import savedTerrainFile from './terrain/saved-terrain.json';

/**
 * The terraformer's island (src/terrain/saved-terrain.json, written by terraformer.html's "Save to game"; null when
 * there is none). New islands take their ground from it. Read at boot: the dev server doesn't reload pages when the
 * terraformer saves (dev/terrain-middleware.ts), so a running game keeps its island until it's reloaded.
 */
function savedTerrain(): TerrainSettings | null {
  const file: unknown = savedTerrainFile;
  if (file === null) return null;
  try {
    return checkSettings(file);
  } catch (err) {
    console.warn('[terrain] ignoring src/terrain/saved-terrain.json:', (err as Error).message);
    return null;
  }
}
import houndsSrc from './god/reference-modules/war-hounds.js?raw';
import fogSrc from './god/reference-modules/poison-fog.js?raw';

const params = new URLSearchParams(location.search);
const devMode = import.meta.env.DEV;
const REF: Record<string, string> = { 'war-hounds': houndsSrc, 'poison-fog': fogSrc };

if (params.has('debug')) {
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;left:8px;top:160px;max-width:60vw;max-height:40vh;overflow:hidden;z-index:9;font:10px monospace;color:#fff;background:rgba(0,0,0,.6);padding:6px;white-space:pre-wrap;pointer-events:none';
  document.body.append(pre);
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[k].bind(console);
    console[k] = (...a: unknown[]) => {
      orig(...a);
      pre.textContent = (pre.textContent + `\n[${k}] ` + a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).slice(-3000);
    };
  }
  window.addEventListener('error', (e) => console.error('uncaught', e.message, e.filename, e.lineno));
}

/** Local wall time as epoch ms (see sim/clock.ts). */
function localNow(): number {
  return Date.now() - new Date().getTimezoneOffset() * 60_000;
}

const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;

async function boot() {
  if (touchOnly && !params.has('force')) {
    document.body.append(h('div', { class: 'mobile-note' }, 'Island Humans and Monsters (first person) needs a desktop computer with a mouse and keyboard.'));
    return;
  }
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const settings = loadSettings();
  if (params.get('third') === '1') settings.thirdPerson = true;
  const renderer = new Renderer(canvas);
  renderer.setFov(settings.fov);
  renderer.sky.setShadows(settings.shadows);
  renderer.renderer.shadowMap.enabled = settings.shadows !== 'off';
  if (devMode && params.has('noshadow')) {
    renderer.renderer.shadowMap.enabled = false;
    renderer.sky.setShadows('off');
  }
  const controls = new Controls(canvas, settings);
  controls.noLock = devMode && params.has('nolock');
  if (import.meta.env.VITE_RUNDOT) {
    // RUN.world: the iframe cannot lock the pointer, the host does; without that, drag to look
    const host = await loadHostPointer();
    if (host) controls.useHost(host);
    else controls.noLock = true;
  }
  const audio = new GameAudio();
  audio.setVolumes(settings.volume, settings.fxVolume);
  const uiRoot = document.getElementById('ui')!;
  const hudView = new HudView(uiRoot, settings);
  const map = new WorldMap(uiRoot);
  map.reveal = params.has('reveal');
  const minimap = new Minimap(hudView.root, settings.minimapRange ?? 120);
  // the compass's landmarks, for the minimap (rebuilt with the HUD, 10 times a second)
  let landmarks: CompassMarker[] = [];
  let ui!: Ui;

  const autoSource = (prompt: string) => {
    const name = params.get('manualsrc');
    const id = prompt.match(/Its id MUST be '([^']+)'/)?.[1];
    if (!devMode || !name || !id || !REF[name]) return null;
    return REF[name].replace(/id: '(war-hounds|poison-fog)'/, `id: '${id}'`);
  };
  const platform = await pickPlatform(params, (p) => ui.askSource(p), autoSource);
  const store = platform.store;
  // Another tab starting a new island on this save slot (the in-game "new island", the terraformer's "Save & play")
  // replaces this one: stop saving, or this tab's next save would overwrite the new island.
  const slot = params.get('slot') ?? 'default';
  const islands = typeof BroadcastChannel === 'function' ? new BroadcastChannel('humans-monsters/islands') : null;
  let replaced = () => {};
  if (islands) islands.onmessage = (e) => { if (e.data?.newIsland === slot) replaced(); };
  if (params.get('fresh') === '1') {
    islands?.postMessage({ newIsland: slot });
    await store.clear?.();
    params.delete('fresh');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }

  // ---------- persisted state ----------
  let worldJson = await store.get(KEYS.world);
  let world: SavedWorld | null = worldJson ? JSON.parse(worldJson) : null;
  if (world && world.core?.v !== 3) {
    world = null;
    worldJson = null;
  }
  let chronicle: ChronicleEvent[] = JSON.parse((await store.get(KEYS.chronicle)) ?? '[]');
  const sources: Record<string, string> = {};
  for (const m of world?.manifest ?? []) {
    const s = await store.get(KEYS.mod(m.id));
    if (s !== null) sources[m.id] = s;
  }
  const seed = Number(params.get('seed')) || world?.core.seed || (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0);

  // ---------- live state ----------
  const sim = new SimClient();
  const controller = new ChampionController(controls, renderer.terrain.ground, (m) => sim.post(m as never));
  renderer.terrain.onColliders = () => (controller.decorSolids = renderer.terrain.colliders);
  controller.grid = renderer.terrain.grid;
  controller.onClimbStep = () => audio.play('step', undefined, { surface: controller.mount ? 'grass' : 'rock' });
  // climbing on monsters (docs/climbing-phase3-plan.md)
  const mounts = new Mounts(renderer.ents);
  mounts.any = devMode && params.has('mountany');
  controller.findMount = (x, y, z, maxM, how) => mounts.find(new THREE.Vector3(x, y, z), maxM, how);
  controller.onMount = () => hudView.hintOnce('mount');
  // a hard landing: the sim decides the damage (it also hears falls that end in hold, the pointer free)
  controller.onFall = (impact) => input({ type: 'land', impact, x: controller.x, z: controller.z });
  controller.onStep = () => audio.play('step', undefined, { surface: renderer.terrain.tileAt(controller.x, controller.z) });
  controller.onLand = (impact) => {
    controller.onStep();
    renderer.view.land(impact);
    if (impact > 5) renderer.particles.burst('dust', controller.x * M, controller.eyeY - EYE_H + 0.1, controller.z * M);
  };
  let hud: Hud | null = null;
  let chronicleDirty = false;
  let saveWaiters: ((w: string) => void)[] = [];
  let installWaiter: ((r: { ok: boolean; error?: string }) => void) | null = null;
  let readyCreation: CreationRecord | null = null;
  let creationMarker: { x: number; z: number; until: number; label: string } | null = null;
  let safeSince = 0;
  const firstVisible = new Map<string, { x: number; z: number }>();
  let gameOverShown = false;
  const names = new Map<number, NameInfo>();
  let monsterCards: MonsterCard[] = [];
  let ctrlReason: CtrlReason = 'player';
  let screams: FramePayload['screams'] = [];
  let firstPlay = true;
  let pendingSwing: { at: number } | null = null;
  const spectator = { x: 0, y: 30, z: 0, yaw: 0, pitch: -0.4 };
  let lastHurtAt = 0;
  let paused = false, pausedAt = 0;
  // a paused load holds only once the view has settled: half a second drawn since the first frame arrived
  let sawFrame = false, settleT = 0, viewReady = false;

  const pushEvents = (events: ChronicleEvent[]) => {
    if (params.has('debug')) for (const e of events) console.info(`[chronicle] D${e.day}: ${e.text}`);
    chronicle.push(...events);
    if (chronicle.length > 200) chronicle = chronicle.slice(-200);
    chronicleDirty = true;
    ui.setChronicle(chronicle);
  };
  const godLog = (text: string, importance: number) => pushEvents([{ tick: hud?.tick ?? 0, clockMs: hud?.clockMs ?? localNow(), day: hud?.day ?? 1, text, importance, source: 'god' }]);
  const input = (i: unknown) => sim.post({ type: 'input', input: i as never });

  // ---------- settings panel (journal → Settings) ----------
  function settingsPanel(): HTMLElement {
    const apply = () => {
      saveSettings(settings);
      renderer.setFov(settings.fov);
      renderer.sky.setShadows(settings.shadows);
      renderer.renderer.shadowMap.enabled = settings.shadows !== 'off';
      audio.setVolumes(settings.volume, settings.fxVolume);
    };
    const range = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void) => {
      const out = h('span', {}, String(get()));
      const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        set(Number(inp.value));
        out.textContent = inp.value;
        apply();
      });
      return h('label', {}, label, h('span', {}, inp, ' ', out));
    };
    const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const inp = h('input', { type: 'checkbox', ...(get() ? { checked: true } : {}) }) as HTMLInputElement;
      inp.addEventListener('change', () => {
        set(inp.checked);
        apply();
      });
      return h('label', {}, label, inp);
    };
    const shadows = h('select', {}) as HTMLSelectElement;
    for (const q of ['off', 'low', 'high']) shadows.append(h('option', { value: q, ...(settings.shadows === q ? { selected: true } : {}) }, q));
    shadows.addEventListener('change', () => {
      settings.shadows = shadows.value as 'off' | 'low' | 'high';
      apply();
    });
    const binds = (Object.keys(settings.bindings) as ActionName[]).map((a) => {
      const b = h('button', { class: 'btn keybind' }, keyLabel(settings.bindings[a]));
      b.addEventListener('click', () => {
        controls.rebinding = a;
        b.textContent = 'press a key…';
        controls.onRebound = () => {
          saveSettings(settings);
          ui.refreshSettings();
        };
      });
      return h('label', {}, ACTION_LABEL[a], b);
    });
    return h('div', {},
      h('h3', { class: 'serif' }, 'How to play'),
      h('p', { class: 'muted' }, 'Hunt the six monsters in their hidden lairs. Beat one down to 20 %, bind it (E), drag it home and burn it on the altar of the Most High for its full HP in favor, or finish it (F). Watch for the red ring of a wind-up: dodge (C) or raise your shield (right mouse). A day lasts 8 minutes: 4 of daylight, 4 of night. Judgment falls at midnight: the god with more favor reshapes the island. The world keeps running while you read this, unless you paused first (Esc).'),
      h('h3', { class: 'serif' }, 'Controls'),
      h('div', { class: 'settings-block' },
        range('Mouse sensitivity', 0.5, 6, 0.1, () => settings.sensitivity, (v) => (settings.sensitivity = v)),
        check('Invert mouse Y', () => settings.invertY, (v) => (settings.invertY = v)),
        ...(controls.canHoldEsc ? [check('Fullscreen (Esc pauses and resumes; hold Esc to leave it)', () => settings.fullscreen, (v) => {
          settings.fullscreen = v;
          if (!v && document.fullscreenElement) void document.exitFullscreen();
        })] : []),
        ...binds),
      h('h3', { class: 'serif' }, 'Video and audio'),
      h('div', { class: 'settings-block' },
        range('Field of view', 60, 100, 1, () => settings.fov, (v) => (settings.fov = v)),
        h('label', {}, 'Shadows', shadows),
        range('Master volume', 0, 1, 0.05, () => settings.volume, (v) => (settings.volume = v)),
        range('Effects volume', 0, 1, 0.05, () => settings.fxVolume, (v) => (settings.fxVolume = v))),
    );
  }

  ui = new Ui({
    action: (a) => sim.post({ type: 'action', action: a }),
    settingsPanel,
    closeInspector: () => {
      sim.post({ type: 'inspect', id: null });
      ui.setInspector(null);
    },
    newIsland: async () => {
      // Stop the worker without pausing it (a pause triggers a save), and drop every later write
      // (late saves, pagehide, the god pipeline), so nothing of the old island can land after the clear.
      sim.stop();
      store.set = async () => {};
      await store.clear?.();
      const p = new URLSearchParams(location.search);
      p.delete('seed');
      p.set('fresh', '1'); // and clear once more on boot, before anything is read
      location.search = p.toString();
    },
    showCreation: () => showCreation(),
    dev: (cmd) => {
      if (cmd === 'judge-human') sim.post({ type: 'devJudge', human: 300, monster: 0 });
      else if (cmd === 'judge-monster') sim.post({ type: 'devJudge', human: 0, monster: 300 });
      else if (cmd === 'crown') sim.post({ type: 'devCrown' });
      else if (cmd === 'kill-champion') sim.post({ type: 'devKillChampion' });
      else if (cmd === 'skip-8') sim.post({ type: 'devSkipHours', hours: 8 });
      else if (cmd === 'raid') sim.post({ type: 'devRaid' });
      else if (cmd === 'fly') toggleFly();
      else if (cmd.startsWith('install-')) devInstall(cmd.slice(8));
      else if (cmd === 'reveal') {
        map.reveal = !map.reveal;
        map.tilesChanged();
      }
    },
    // closing the journal (its × or Tab) goes straight back into the game, not to the paused view
    panelChanged: (open) => {
      if (!open && !screenOpen()) lockGame();
      else updateLockUi();
    },
  }, devMode);
  function toggleFly() {
    controller.setFlying(!controller.flying);
    ui.toast(controller.flying ? 'Fly mode: WASD along your view, Space up, C down, Shift for speed (F9 to land)' : 'Fly mode off', 'info', 4);
  }
  // dev hotkeys: F8 crowns the next champion now (no waiting for dawn); F9 toggles fly mode
  if (devMode) window.addEventListener('keydown', (e) => {
    if ((e.code !== 'F8' && e.code !== 'F9') || e.repeat) return;
    e.preventDefault();
    if (e.code === 'F8') sim.post({ type: 'devCrown' });
    else toggleFly();
  });
  if (platform.warning) ui.toast(platform.warning, 'info', 10);
  ui.setChronicle(chronicle);

  // ---------- screens, pointer lock and pause ----------
  const screenOpen = () => ui.isSheetOpen() || ui.isModalOpen() || map.open;
  // ?hideplay=1 (headless screenshots): no click-to-play card, and so no pause
  const hidePlay = devMode && params.has('hideplay');
  /**
   * The paused view stops the world: the sim worker, the picture and the sound. Losing the pointer with nothing open
   * (Esc, alt-tab, or before the first click) pauses; a screen opened from the pause keeps it paused, and getting the
   * pointer back resumes. The journal and map opened during play don't pause (the world runs on while you read).
   */
  function setPause(on: boolean) {
    if (on === paused) return;
    paused = on;
    if (on) pausedAt = performance.now();
    sim.setPaused(on || document.hidden);
    renderer.frozen = on;
    audio.hold(on);
  }
  function updateLockUi() {
    const out = !controls.active && !gameOverShown && !hidePlay;
    // Out of play with nothing open is the paused view, and so is everything before the first click (the summary of
    // the time away, say). After loading, it waits for the view to settle onto the champion (frames place the camera).
    if (out && viewReady && (!screenOpen() || firstPlay)) setPause(true);
    else if (controls.active && !controls.noLock) setPause(false);
    hudView.showPlay(!screenOpen() && !gameOverShown && !hidePlay && (paused || !controls.active), firstPlay);
  }
  const lockGame = () => {
    audio.start();
    if (screenOpen()) return;
    // no pointer lock to wait for (?nolock, a RUN host without one): straight back into play
    if (controls.noLock) {
      firstPlay = false;
      setPause(false);
      updateLockUi();
    } else controls.requestLock();
  };
  hudView.onPlay = () => lockGame();
  hudView.onCamera = () => controls.onAction('camera');
  /** Third person: pull the camera back over the champion's right shoulder, short of the ground. */
  function shoulderCam(eye: { x: number; y: number; z: number; yaw: number; pitch: number }) {
    const BACK = 4.2, SIDE = 0.7, UP = 0.35;
    const cp = Math.cos(eye.pitch);
    const fx = Math.sin(eye.yaw) * cp, fy = Math.sin(eye.pitch), fz = Math.cos(eye.yaw) * cp;
    const px = eye.x - Math.cos(eye.yaw) * SIDE, py = eye.y + UP, pz = eye.z + Math.sin(eye.yaw) * SIDE;
    let d = BACK;
    for (let k = 0.5; k <= BACK; k += 0.25) {
      const x = px - fx * k, y = py - fy * k, z = pz - fz * k;
      if (y < renderer.terrain.y(x / M, z / M) + 0.4) {
        d = Math.max(0.3, k - 0.25);
        break;
      }
    }
    return { x: px - fx * d, y: py - fy * d, z: pz - fz * d, yaw: eye.yaw, pitch: eye.pitch };
  }
  canvas.addEventListener('click', () => {
    if (!controls.active) lockGame();
  });
  controls.onLockRefused = () => {
    if (!controls.active) hudView.needClick();
  };
  controls.onLockChange = (locked) => {
    // let go: stop on the spot and put the sim's champion there first, so it holds him exactly where you are
    if (!locked) controller.release();
    input({ type: 'lock', on: locked });
    if (locked) firstPlay = false;
    updateLockUi();
  };
  const closeScreens = () => {
    if (map.open) map.toggle(false);
    if (ui.isModalOpen()) ui.closeModal();
    if (ui.isSheetOpen()) ui.closeSheet();
    updateLockUi();
  };
  controls.onAction = (a) => {
    if (a === 'journal') {
      if (ui.isSheetOpen()) closeScreens();
      else {
        controls.exitLock();
        ui.openSheet();
      }
    } else if (a === 'map') {
      if (map.open) {
        map.toggle(false);
        lockGame();
      } else {
        controls.exitLock();
        map.toggle(true, { x: controller.x, z: controller.z });
      }
      updateLockUi();
    } else if (a === 'minimap') {
      settings.minimapRange = minimap.cycle();
      saveSettings(settings);
    } else if (a === 'camera') {
      settings.thirdPerson = !settings.thirdPerson;
      saveSettings(settings);
      hudView.setCamera(settings.thirdPerson);
    } else if (a === 'confirm') {
      if (ui.isModalOpen()) {
        ui.closeModal();
        lockGame();
      }
    }
  };
  window.addEventListener('keydown', (e) => {
    // (holding Esc leaves fullscreen: its repeats aren't presses)
    if (e.code !== 'Escape' || e.repeat) return;
    // the page hears Esc with the pointer still captured only when fullscreen holds Esc for it: pause by letting it go,
    // which lets the next Esc take it back
    if (controls.locked) return controls.exitLock();
    if (map.open) map.toggle(false);
    else if (screenOpen()) return;
    // Esc again on the pause card: back into the game (not the Esc that just paused it, should the page hear that one)
    else if (paused && performance.now() - pausedAt > 300) return lockGame();
    // Esc releases the pointer, which pauses; with no pointer lock to release, pause here
    if (controls.noLock && !hidePlay) setPause(true);
    updateLockUi();
  });
  if (controls.noLock) setTimeout(() => input({ type: 'lock', on: true }), 1500);

  // ---------- sim worker ----------
  const snapshotWorld = () =>
    new Promise<string>((resolve) => {
      saveWaiters.push(resolve);
      sim.post({ type: 'requestSave' });
    });

  async function install(id: string, source: string, record: CreationRecord, night: number): Promise<{ ok: boolean; error?: string }> {
    await store.set(KEYS.mod(id), source);
    sources[id] = source;
    const r = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      installWaiter = resolve;
      sim.post({ type: 'install', id, source, record, night });
    });
    if (!r.ok) {
      delete sources[id];
      await store.remove(KEYS.mod(id));
    }
    return r;
  }

  async function devInstall(name: string) {
    const src = REF[name];
    if (!src || sources[name]) return ui.toast(`${name} is already installed.`);
    const rec: CreationRecord = { id: name, title: name === 'war-hounds' ? 'War-hounds of the Most High' : 'The sweet fog of the salt flats', god: name === 'war-hounds' ? 'human' : 'monster', domain: name === 'war-hounds' ? 'creatures' : 'weather', scale: 2, day: hud?.day ?? 1, announcement: name === 'war-hounds' ? 'And the Most High said, Let hounds walk beside my people and hunt the beasts. And it was so.' : 'And the god of the beasts said, Let a fog rise from the salt flats, sweet to my children and bitter to men. And it was so.' };
    const r = await install(name, src, rec, -1);
    if (r.ok) {
      readyCreation = rec;
      showCreation();
    } else ui.toast(`Install failed: ${r.error}`);
  }

  function showCreation() {
    if (!readyCreation) return;
    const rec = readyCreation;
    readyCreation = null;
    ui.setCreationReady(false);
    const p = firstVisible.get(rec.id);
    if (p) creationMarker = { x: p.x, z: p.z, until: performance.now() + 600_000, label: rec.title };
    controls.exitLock();
    ui.genesis(rec);
    audio.play('judgment');
  }

  function handleAlert(a: Alert) {
    switch (a.kind) {
      case 'scream':
        ui.toast(a.text, 'scream', 8);
        hudView.hintOnce('scream');
        break;
      case 'champion':
        ui.toast(a.text, 'champion', 8);
        break;
      case 'shofar':
        ui.toast(a.text, 'shofar', 6);
        audio.play('shofar');
        break;
      case 'judgment':
        ui.banner('Judgment', a.text, 'judgment', 9);
        audio.play('judgment');
        break;
      case 'lair':
        ui.banner('A lair', a.text, 'lair', 6);
        hudView.hintOnce('lair');
        break;
      case 'altar':
        ui.toast(a.text, 'info', 4);
        break;
      case 'gameover':
        break;
      default:
        ui.toast(a.text, a.kind, 6);
    }
  }

  function onFrame(f: FramePayload) {
    sawFrame = true;
    renderer.onFrame(f);
    if (f.tiles.length) {
      map.tilesChanged();
      minimap.terrainChanged();
    }
    if (f.explored.length) map.markExplored(f.explored);
    // authority and epochs (F6)
    const prev = controller.ctrl;
    controller.ctrl = f.ctrl;
    ctrlReason = f.ctrlReason;
    controller.view = f.ctrlReason === 'downed' ? 'downed' : f.ctrlReason === 'captive' ? 'carried' : f.ctrlReason === 'dead' ? 'spectate' : 'normal';
    if (f.champ && (f.epoch !== controller.epoch || f.correction || (prev === 'sim' && f.ctrl === 'player'))) {
      controller.epoch = f.epoch;
      const p = f.correction ?? f.champ;
      if (climbLog) console.info(`[climb] snap${f.correction ? ' (correction)' : ''} to ${p.x.toFixed(2)},${p.z.toFixed(2)} alt ${(p.alt ?? 0).toFixed(1)}`);
      controller.snap(p.x, p.z, p.alt ?? 0);
      if (!f.correction) controller.yaw = f.champ.yaw;
    }
    controller.reason = f.ctrlReason;
    // in hold (the pointer free: a screen open, the pause) the view stays where you let go, which is where the sim holds
    // the champion (controller.release); on a wall or mid-fall the client also finishes the fall
    const keep = f.ctrlReason === 'hold';
    if (f.ctrl === 'sim' && f.champ && !keep) {
      controller.x = f.champ.x;
      controller.z = f.champ.z;
    }
    screams = f.screams;
    for (const s of f.sounds) {
      const kind = s.kind === 'thud' ? 'step' : s.kind;
      audio.play(kind as never, { x: s.x * M, y: renderer.terrain.y(s.x, s.z) + 1.2, z: s.z * M }, { size: s.size });
    }
    for (const c of f.combat) {
      if (c.kind === 'blocked') {
        controller.blockedHit(c.amount ?? 0);
        audio.play('block');
      } else if (c.kind === 'hit' && c.severed) {
        hudView.hitMarker(c.zone ?? null, true);
        renderer.kick(-0.04, (Math.random() - 0.5) * 0.04);
        ui.toast(c.killed ? 'A killing blow!' : `You sever its ${c.zone === 'sig' ? 'signature limb' : c.zone}!`, 'info', 3);
      } else if (c.kind === 'hit' && c.downed) hudView.hintOnce('downed');
      if (climbLog && c.kind === 'hit' && controller.mount?.id === c.id) console.info(`[climb] hit it from its body: ${c.zone} ${c.amount}`);
      if ((c.kind === 'shake' || c.kind === 'thrown') && climbLog) console.info(`[climb] ${c.kind}${c.hard ? ' (grab)' : ''} by ${c.id}${c.kind === 'shake' ? `, -${c.amount} stamina` : ''}`);
      if (c.kind === 'shake' && controller.mount?.id === c.id) {
        controller.shake(c.amount ?? 0);
        renderer.kick(0.02, (Math.random() - 0.5) * 0.05);
      } else if (c.kind === 'thrown' && controller.mount?.id === c.id) {
        controller.throwOff(c.x ?? controller.x, c.z ?? controller.z, !!c.hard);
        ui.toast(c.hard ? 'It tears you off and hurls you away!' : 'You are thrown off!', 'info', 2.5);
      }
    }
    if (f.hurt > 0) controller.knock();
    if (f.hurt > 0 && performance.now() - lastHurtAt > 150) {
      lastHurtAt = performance.now();
      hudView.flashHurt();
      renderer.view.hurt();
      renderer.kick(0.025, (Math.random() < 0.5 ? -1 : 1) * 0.035);
      audio.play('hurt');
    }
    for (const t of f.toasts) ui.toast(t, 'info', 3);
    if (f.actionError) ui.toast(f.actionError, 'info', 3);
  }

  const climbLog = devMode && params.has('climblog');
  const scenario = devMode ? params.get('script') : null;
  let firstFull = true;
  sim.onMessage = (m: SimToMain) => {
    switch (m.type) {
      case 'defs':
        renderer.onDefs(m);
        map.setTiles(renderer.terrain.grid.types, renderer.terrain.defs);
        break;
      case 'fullState': {
        renderer.onFullState(m);
        minimap.terrainChanged();
        map.setTiles(renderer.terrain.grid.types, renderer.terrain.defs);
        map.setExplored(m.explored);
        controller.walk = m.walkCost;
        controller.feat = renderer.terrain.surface;
        controller.decorSolids = renderer.terrain.colliders;
        controller.epoch = m.epoch;
        if (firstFull) {
          firstFull = false;
          const L = m.layout;
          spectator.x = (L.villageAltar.x + 0.5) * M;
          spectator.z = (L.villageAltar.z + 4) * M;
          const pose = params.get('pose')?.split(',').map(Number);
          if (devMode && pose && pose.length >= 2) {
            sim.post({ type: 'devScenario', name: `place:${pose[0]},${pose[1]}` });
            controller.yaw = ((pose[2] ?? 0) * Math.PI) / 180;
            controller.pitch = ((pose[3] ?? 0) * Math.PI) / 180;
          } else {
            // face the High Place from the village
            const cx = L.villageAltar.x + 0.5, cz = L.villageAltar.z + 1;
            controller.yaw = Math.atan2(L.highAltar.x - cx, L.highAltar.z - cz);
          }
          // a dev scenario once the world is there (it acts on the champion's pose, so after the first one)
          if (scenario) setTimeout(() => sim.post({ type: 'devScenario', name: scenario }), 500);
          startHolds();
        }
        break;
      }
      case 'frame':
        onFrame(m);
        break;
      case 'walkCost':
        controller.walk = m.cost;
        break;
      case 'names':
        for (const [id, n] of m.names) names.set(id, n);
        break;
      case 'hud': {
        hud = m.hud;
        renderer.hour = hud.hour;
        renderer.light = hud.light;
        if (hud.champion) {
          controller.speedMul = hud.champion.speedMul;
          controller.dragging = !!hud.champion.dragging;
          controller.torch = hud.champion.torch;
          // the sim has the last word on what's in hand (out of spears, a new champion, a load) once a switch has
          // had time to reach it
          if (performance.now() - wieldAt > 600) setWield(hud.champion.wield, false);
          renderer.view.torchOn = hud.champion.torch;
          renderer.view.dragging = !!hud.champion.dragging;
          if (hud.champion.dragging) hudView.hintOnce('drag');
        }
        if (hud.light < 0.35) hudView.hintOnce('night');
        ui.setHud(hud);
        if (hud.gameOver && !gameOverShown) {
          gameOverShown = true;
          controls.exitLock();
          ui.gameOver(hud.gameOver.winner, hud);
        }
        // the Genesis card waits until the champion is out of danger (R31)
        if (hud.dangerNear) safeSince = performance.now();
        if (readyCreation && !screenOpen() && !paused && performance.now() - safeSince > 10_000) showCreation();
        if (pipeline && hud.pendingCreations.length) pipeline.kick();
        break;
      }
      case 'villagers':
        monsterCards = m.monsters;
        ui.setVillagers(m.villagers, m.monsters);
        break;
      case 'events':
        pushEvents(m.events);
        break;
      case 'alerts':
        for (const a of m.alerts) handleAlert(a);
        break;
      case 'save': {
        worldJson = m.world;
        world = JSON.parse(m.world);
        store.set(KEYS.world, m.world).catch((err) => console.error('[save] world', err));
        if (chronicleDirty) {
          chronicleDirty = false;
          store.set(KEYS.chronicle, JSON.stringify(chronicle)).catch((err) => console.error('[save] chronicle', err));
        }
        const w = saveWaiters;
        saveWaiters = [];
        for (const fn of w) fn(m.world);
        break;
      }
      case 'installed':
        installWaiter?.(m);
        installWaiter = null;
        break;
      case 'visible':
        if (!firstVisible.has(m.id)) firstVisible.set(m.id, { x: m.x, z: m.z });
        break;
      case 'away':
        if (m.summary.hours >= 0.25) {
          controls.exitLock();
          ui.away(m.summary);
        }
        break;
      case 'inspect':
        ui.setInspector(m.info);
        break;
      case 'actionResult':
        if (m.error) ui.toast(m.error, 'info', 4);
        break;
      case 'moduleFault':
        console.warn(`[creation ${m.id}] ${m.hook}: ${m.error}${m.stack ? ` (${m.stack})` : ''}`);
        break;
      case 'quarantined':
        console.warn(`[creation ${m.id}] quarantined: ${m.reason}`);
        break;
      case 'error':
        console.error('[sim]', m.error);
        break;
    }
  };

  sim.onHang = () => {
    const active = (world?.manifest ?? []).filter((x) => x.status === 'active');
    const culprit = active[active.length - 1];
    godLog(culprit ? `The world froze. "${culprit.title}" is stilled.` : 'The world trembled and froze for a moment.', 2);
    startSim(culprit ? [culprit.id] : []);
  };

  const modulesFor = (w: SavedWorld | null) => (w?.manifest ?? []).filter((x) => sources[x.id] !== undefined).map((x) => ({ id: x.id, source: sources[x.id], status: x.status }));

  replaced = () => {
    sim.stop();
    store.set = async () => {};
    ui.banner('A new island', 'This island was replaced by a new one in another tab. Reload to play it.', 'judgment', 3600);
  };

  function startSim(quarantine: string[] = []) {
    // a new island starts at 07:00 (or ?at=HH:MM), so the first day is a full one
    let clock = localNow();
    const [hh, mm] = (params.get('at') ?? '07:00').split(':').map(Number);
    if (!worldJson) clock = clock - (clock % 86_400_000) + ((hh || 0) * 60 + (mm || 0)) * 60_000;
    sim.start({
      save: worldJson, seed, modules: modulesFor(world), clockMs: clock, realMs: Date.now(),
      timescale: Math.max(1, Number(params.get('timescale')) || GAME_TIMESCALE), quarantine, reveal: params.has('reveal'), invincible: devMode && params.has('god'),
      skip: devMode ? Number(params.get('skip')) || 0 : 0,
      // ?terrain=off: a procedural island even when the terraformer has saved one; ?terrain=default: the
      // terraformer's defaults (floating isles, for riding a flyer up to one) whatever is saved
      terrain: worldJson || params.get('terrain') === 'off' ? null : params.get('terrain') === 'default' ? { ...DEFAULT_SETTINGS } : savedTerrain(),
    });
  }

  // ---------- the gods ----------
  const pipeline = new CreationPipeline({
    provider: platform.provider,
    loadPending: () => store.get(KEYS.pending),
    savePending: (json) => store.set(KEYS.pending, json),
    snapshotWorld,
    sources: () => ({ ...sources }),
    chronicle: () => chronicle,
    pending: () => hud?.pendingCreations ?? [],
    domainHistory: () => hud?.domainHistory ?? { human: [], monster: [] },
    log: godLog,
    validate: (req, onStage) => runValidation(req, onStage),
    install,
    failed: (night) => sim.post({ type: 'creationFailed', night }),
    onCreated: (rec) => {
      readyCreation = rec;
      ui.setCreationReady(true);
    },
    onChange: () => ui.setGodStatus(pipeline?.status ?? '', pipeline?.trace ?? [], pipeline?.live ?? null, pipeline?.traceVersion ?? 0),
    isHidden: () => document.hidden,
  });
  await pipeline.load();
  setInterval(() => ui.setGodStatus(pipeline.status, pipeline.trace, pipeline.live, pipeline.traceVersion), 500);

  // ---------- the look target, interact, swings ----------
  const ALTAR_R = 4.5 / M + 0.15; // tiles from the altar's center (§2)
  function nearAltar(): boolean {
    const L = renderer.layout;
    if (!L) return false;
    return Math.hypot(L.villageAltar.x + 0.5 - controller.x, L.villageAltar.z + 0.5 - controller.z) < ALTAR_R;
  }
  function lookingAtAltar(): boolean {
    const L = renderer.layout;
    if (!L || !nearAltar()) return false;
    const b = Math.atan2(L.villageAltar.x + 0.5 - controller.x, L.villageAltar.z + 0.5 - controller.z);
    let d = b - controller.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) < 0.7 && controller.pitch < 0.3;
  }

  let look: { id: number; t: number; h: number; s: number; f: number } | null = null;
  const champId = () => hud?.champion?.id ?? null;
  /**
   * Is a target in reach of E and F? The sim's own test (champion.ts, near): within INTERACT_M (3 m) of its body (its
   * axis, less its radius) and, on a terraformer island, less than 3 m above or below the feet. Less 0.4 m: walking up
   * to it, the sim's champion is a moment behind, and a prompt must never promise what E then calls too far.
   */
  const inReach = (id: number) => {
    const v = renderer.ents.views.get(id);
    if (!v) return false;
    if (renderer.terrain.grid.base && Math.abs(v.pos.y - controller.feetY) >= 3) return false;
    const arch = renderer.ents.arch(id);
    const body = {
      kind: v.flags & F_HUMAN ? 'human' : 'thing', scale: v.scale, yaw: v.yaw, x: v.pos.x / M, z: v.pos.z / M,
      monster: v.flags & F_MONSTER && arch ? { archetype: arch } : undefined, animal: v.flags & F_ANIMAL ? { species: v.shape } : undefined,
    } as unknown as Entity;
    return (axisDist(body, controller.x, controller.z) - bodyR(body)) * M <= 3.0 - 0.4;
  };

  function doSwingContact() {
    // on a body: the blow lands where you hang (docs/climbing-phase4-plan.md, Part B)
    if (controller.mode === 'mount' && controller.mount) {
      const m = controller.mount, pl = m.place();
      const arch = renderer.ents.arch(m.id);
      const zone = arch ? capZone(arch, m.cap) : null;
      if (pl) {
        renderer.particles.burst('blood', pl.p[0], pl.p[1], pl.p[2]);
        audio.play('hit', { x: pl.p[0], y: pl.p[1], z: pl.p[2] });
      }
      renderer.view.hitstop(zone === 'head' ? 0.09 : 0.06);
      renderer.kick(-0.02, (Math.random() - 0.5) * 0.02);
      hudView.hitMarker(zone);
      input({ type: 'swing', yaw: controller.yaw, pitch: controller.pitch, targetId: m.id, zone });
      return;
    }
    const { eye, dir } = renderer.lookRay();
    const hit = renderer.ents.pick(eye, dir, reachM(), champId());
    let targetId: number | null = null, zone: Zone | null = null;
    if (hit) {
      const v = renderer.ents.views.get(hit.id);
      if (v && (v.flags & (F_MONSTER | F_HITTABLE)) && !(v.flags & (F_DOWNED | F_BOUND))) {
        targetId = hit.id;
        const arch = renderer.ents.arch(hit.id);
        zone = arch ? zoneFor(arch, hit.h, hit.s, hit.f) : null;
        // immediate local feedback (F7)
        const p = eye.clone().addScaledVector(dir, hit.t);
        renderer.particles.burst('blood', p.x, p.y, p.z);
        if (zone === 'head') renderer.particles.burst('blood', p.x, p.y, p.z);
        audio.play('hit', { x: p.x, y: p.y, z: p.z });
        // weight: freeze the blade a beat, jolt the view, mark the hit
        renderer.view.hitstop(zone === 'head' ? 0.09 : 0.06);
        renderer.kick(zone === 'head' ? -0.03 : -0.018, (Math.random() - 0.5) * 0.02);
        hudView.hitMarker(zone);
      }
    }
    if (targetId === null) audio.play('whiff');
    input({ type: 'swing', yaw: controller.yaw, pitch: controller.pitch, targetId, zone });
  }

  // in hand: the sword, or a spear to thrust (left mouse) and throw (R); the shield goes with either
  let wield: 'sword' | 'spear' = 'sword', wieldAt = -1e9;
  function setWield(w: 'sword' | 'spear', send = true) {
    if (send) wieldAt = performance.now();
    if (w === wield) return;
    wield = w;
    renderer.view.weapon = w;
    if (w === 'spear') hudView.hintOnce('spear'); // however it came to hand (2, a pickup)
    if (send) input({ type: 'wield', weapon: w });
  }
  /** how far a blow reaches from the eye: the sim's SWORD_M or SPEAR_M, plus a body's depth */
  const reachM = () => (wield === 'spear' ? 3.4 : 2.4) + 2.5;

  let throwReady = 0;
  // R held: the spear drawn back (since `at`, s); let go (`release`) and it flies once the draw is done
  let draw: { at: number; release: boolean } | null = null;
  const DRAW_T = 0.3;
  const endDraw = () => {
    draw = null;
    renderer.view.drawSpear(false);
  };
  function throwSpear(now: number, drawn = false) {
    const c = hud?.champion;
    if (!c || ctrlReason !== 'player' || c.dragging || now < throwReady) return;
    if (c.spears <= 0) {
      ui.toast('No spears. Pick one up where it fell, or take one from the village rack.', 'info', 3);
      return;
    }
    throwReady = now + 0.8;
    // aim: whatever hittable thing is under the crosshair, out to 100 m
    const { eye, dir } = renderer.lookRay();
    const hit = renderer.ents.pick(eye, dir, 100, champId());
    let targetId: number | null = null, zone: Zone | null = null;
    const v = hit ? renderer.ents.views.get(hit.id) : undefined;
    if (hit && v && (v.flags & (F_MONSTER | F_HITTABLE)) && !(v.flags & (F_DOWNED | F_BOUND))) {
      targetId = hit.id;
      const arch = renderer.ents.arch(hit.id);
      zone = arch ? zoneFor(arch, hit.h, hit.s, hit.f) : null;
    }
    renderer.view.throwSpear(drawn);
    audio.play('swing');
    input({ type: 'throw', yaw: controller.yaw, pitch: controller.pitch, targetId, zone });
    // that was the last one: the sword again (the sim does the same)
    if (c.spears <= 1) setWield('sword');
  }

  function interact() {
    const dragging = !!hud?.champion?.dragging;
    if (lookingAtAltar() || (dragging && nearAltar())) {
      controls.exitLock();
      ui.openAltar();
      return;
    }
    if (dragging) return input({ type: 'interact', id: null });
    if (look) input({ type: 'interact', id: look.id });
  }

  function targetInfo(id: number): TargetInfo | null {
    const v = renderer.ents.views.get(id);
    if (!v) return null;
    const n = names.get(id);
    const monster = (v.flags & F_MONSTER) !== 0;
    const state = v.flags & F_DOWNED ? 'downed' : v.flags & F_BOUND ? 'bound' : v.flags & F_TELEGRAPH ? 'winding up!' : '';
    return {
      name: n?.name ?? (monster ? 'Something' : '…'),
      title: n?.title ?? '',
      hp: monster && v.seen ? v.hp : (v.flags & F_HUMAN) ? v.hp : null,
      state,
      hostile: monster && !(v.flags & (F_DOWNED | F_BOUND)),
      downed: (v.flags & F_DOWNED) !== 0,
    };
  }

  function promptFor(): string {
    const b = settings.bindings;
    const E = `[${keyLabel(b.interact)}]`, F = `[${keyLabel(b.finish)}]`;
    if (ctrlReason === 'downed') return '';
    const c = hud?.champion;
    if (c?.dragging) return nearAltar() ? `${E} Offer ${c.dragging.name.split(' ')[0]} on the altar (+${c.dragging.value})` : `${E} Let go of ${c.dragging.name.split(' ')[0]}`;
    if (lookingAtAltar()) return `${E} Altar of the Most High`;
    if (!look) return '';
    const v = renderer.ents.views.get(look.id);
    if (!v) return '';
    const n = names.get(look.id)?.name ?? 'it';
    const close = inReach(look.id);
    if (v.flags & F_DOWNED && v.flags & F_MONSTER) return close ? `${E} Bind ${n} · ${F} Finish it` : `${n} is down: get closer`;
    if ((v.flags & F_BOUND) || (v.flags & F_CORPSE)) return close ? `${E} Drag ${n}` : '';
    if (v.flags & F_HUMAN && look.t < 6) return `${E} Talk to ${n.split(' ')[0]}`;
    if (v.flags & F_ITEM && close) return c && c.spears >= c.spearCap ? `You carry all the spears you can (${c.spears})` : `${E} Take the spear (${c?.spears ?? 0}/${c?.spearCap ?? 3})`;
    return '';
  }

  // the body you ride fighting back (docs/climbing-phase4-plan.md, Part D): say so, the first few times
  let tellShake = false, tellGrab = false, shakeTold = 0, grabTold = 0, gripUntil = 0;
  // dev: ?autogrip=1 holds on through each shudder (headless rides can't time the right mouse)
  const autoGrip = devMode && params.has('autogrip');
  function ridingTells() {
    const v = controller.mount ? renderer.ents.views.get(controller.mount.id) : undefined;
    const shaking = !!v && (v.flags & F_SHAKE) !== 0, grabbing = !!v && (v.flags & F_TELEGRAPH) !== 0;
    if (autoGrip) {
      if (shaking) gripUntil = performance.now() + 300;
      controls.mouseR = performance.now() < gripUntil;
    }
    if (climbLog && shaking && !tellShake) console.info('[climb] it shudders');
    if (climbLog && grabbing && !tellGrab) console.info('[climb] it reaches for you');
    if (shaking && !tellShake) {
      renderer.kick(0.01, (Math.random() - 0.5) * 0.03);
      hudView.hintOnce('hold');
      if (shakeTold++ < 3) ui.toast(`It shudders: hold on! [right mouse]`, 'info', 1.2);
    }
    if (grabbing && !tellGrab) {
      hudView.hintOnce('grab');
      if (grabTold++ < 3) ui.toast('It reaches for you: get out of its reach!', 'info', 1.2);
    }
    tellShake = shaking;
    tellGrab = grabbing;
  }

  // ---------- the frame loop ----------
  let lastHud = 0;
  let lastNow = performance.now() / 1000;
  function frame() {
    const now = performance.now() / 1000;
    const fdt = Math.min(0.05, Math.max(0.001, now - lastNow));
    hudView.tickFps(now * 1000);
    lastNow = now;
    const busy = screenOpen();
    // one-shot actions
    if (controls.active && !busy && !paused) {
      // on a wall, Space jumps off or lunges up and the dodge key lets go
      if (controls.take('jump')) {
        if (controller.climbing) controller.wallJump(now);
        else controller.tryJump(now);
      }
      if (controls.take('dodge')) {
        if (controller.climbing) controller.letGo(now);
        else if (controller.tryDodge(now)) {
          renderer.view.dodge();
          renderer.particles.burst('dust', controller.x * M, controller.eyeY - EYE_H + 0.2, controller.z * M);
        }
      }
      if (controls.mouseL && (!controller.climbing || controller.mode === 'mount')) {
        if (hud?.champion?.dragging) {
          if (controls.takeClick()) ui.toast(`${keyLabel(settings.bindings.interact)} to let go`, 'info', 2);
        } else if (!pendingSwing && !draw && controller.trySwing(now, wield === 'spear' ? 0.8 : 0.6)) {
          if (wield === 'spear') renderer.view.thrust();
          else renderer.view.swing();
          audio.play('swing');
          pendingSwing = { at: now + 0.12 };
        }
      }
      controls.takeClick();
      controller.setBlocking(controls.mouseR);
      if (controls.take('interact') && !controller.climbing) interact();
      if (controls.take('finish') && look && !controller.climbing) {
        const v = renderer.ents.views.get(look.id);
        if (v && v.flags & F_DOWNED) input({ type: 'finish', id: look.id });
      }
      if (controls.take('torch')) input({ type: 'torch', on: !hud?.champion?.torch });
      // the mouse wheel cycles weapons, as in Counter-Strike: either way it's the other one (with no spears, the sword)
      if (controls.takeWheel() && (wield === 'spear' || (hud?.champion?.spears ?? 0) > 0)) {
        setWield(wield === 'sword' ? 'spear' : 'sword');
        if (wield === 'spear') hudView.hintOnce('spear');
      }
      // 1 and 2: the sword (and shield), or a spear
      if (controls.take('sword')) setWield('sword');
      if (controls.take('spear')) {
        if ((hud?.champion?.spears ?? 0) > 0) {
          setWield('spear');
          hudView.hintOnce('spear');
        } else ui.toast('No spears. Pick one up where it fell, or take one from the village rack.', 'info', 3);
      }
      // R: hold to draw the spear in hand back over the shoulder, let go to throw it (not from a wall or a body: there
      // the spear thrusts)
      if (controls.take('throw') && !controller.climbing) {
        if (wield !== 'spear') ui.toast(`Take up a spear (${keyLabel(settings.bindings.spear)}) to throw it.`, 'info', 2.5);
        else if (!draw && now >= throwReady && ctrlReason === 'player' && !hud?.champion?.dragging) {
          draw = { at: now, release: false };
          renderer.view.drawSpear(true);
        }
      }
      if (draw && !controls.down('throw')) draw.release = true;
      if (controls.take('inspect') && look) sim.post({ type: 'inspect', id: look.id });
    } else if (controller.blocking) controller.setBlocking(false);
    controls.clearFrame();
    // the drawn spear flies once let go and fully drawn (a tap is a whole throw); whatever takes it out of hand, or
    // the pointer away, ends the draw without a throw
    if (draw) {
      if (!controls.active || busy || paused || wield !== 'spear' || controller.climbing || ctrlReason !== 'player' || hud?.champion?.dragging) endDraw();
      else if (draw.release && now >= draw.at + DRAW_T) {
        endDraw();
        throwSpear(now, true);
      }
    }
    if (pendingSwing && now >= pendingSwing.at && !paused) {
      pendingSwing = null;
      doSwingContact();
    }

    // the bodies move first, so a champion riding one is placed on this frame's pose
    renderer.animate(champId(), settings.thirdPerson && ctrlReason !== 'dead');
    // camera
    let cam: { x: number; y: number; z: number; yaw: number; pitch: number };
    let roll = 0;
    let champPose: { x: number; y: number; z: number; yaw: number } | null = null;
    // paused, nothing moves: the champion (or the spectator) holds where it was, mid-fall or on a wall included
    if (paused) controls.readLook();
    if (ctrlReason === 'dead') {
      // spectator fly-cam (F31)
      const [dy, dp] = controls.readLook();
      spectator.yaw += dy;
      spectator.pitch = Math.max(-1.4, Math.min(1.4, spectator.pitch + dp));
      const sp = paused ? 0 : (controls.down('sprint') ? 40 : 15) * fdt;
      const fz = (controls.down('forward') ? 1 : 0) - (controls.down('back') ? 1 : 0), fx = (controls.down('left') ? 1 : 0) - (controls.down('right') ? 1 : 0);
      const s = Math.sin(spectator.yaw), co = Math.cos(spectator.yaw);
      spectator.x += (fz * s + fx * co) * sp;
      spectator.z += (fz * co - fx * s) * sp;
      spectator.y += fz * Math.sin(spectator.pitch) * sp;
      spectator.y = Math.max(renderer.terrain.y(spectator.x / M, spectator.z / M) + 2, spectator.y);
      cam = { ...spectator };
    } else {
      if (!paused) {
        controller.solids = [];
        const L = renderer.layout;
        if (L) controller.solids.push({ x: L.villageAltar.x + 0.5, z: L.villageAltar.z + 0.5, r: 1.3 / M }, { x: L.highAltar.x + 0.5, z: L.highAltar.z + 0.5, r: 1.9 / M });
        renderer.ents.each((v) => {
          if (!(v.flags & F_MONSTER) || v.flags & (F_DOWNED | F_BOUND | F_CORPSE)) return;
          if (v.pos.y - renderer.terrain.y(v.pos.x / M, v.pos.z / M) > 3) return; // flying overhead
          const box = renderer.ents.boxOf(v);
          // only bodies at your height: a monster at the foot of a cliff doesn't shove you around on top of it
          if (v.pos.y > controller.feetY + 1.8 || v.pos.y + box.hgt < controller.feetY) return;
          // a body you can climb is its trunk (the sim's radius), so its legs are in reach; others keep the hit box
          const r = (CLIMB[v.shape] ? BODY[v.shape].r * SHAPE_M * v.scale : box.wid) / M;
          const half = Math.max(0, box.len - box.wid) / M;
          // two circles along a long body (F12)
          for (const k of half > 0 ? [-half, half] : [0]) controller.solids.push({ x: v.pos.x / M + Math.sin(v.yaw) * k, z: v.pos.z / M + Math.cos(v.yaw) * k, r });
        });
        controller.rain = renderer.particles.weather === 'rain';
        controller.update(fdt, now);
        renderer.view.vy = controller.air ? controller.vy : 0;
        // the weapon comes down on a wall, not on a monster (you fight from its body)
        renderer.view.climbing = controller.climbing && controller.mode !== 'mount';
        ridingTells();
      }
      if (controller.ctrl === 'sim' && hud?.champion && ctrlReason !== 'hold') {
        const cv = renderer.ents.views.get(hud.champion.id);
        if (cv) {
          controller.x = cv.pos.x / M;
          controller.z = cv.pos.z / M;
        }
      }
      cam = { x: controller.x * M, y: controller.eyeY, z: controller.z * M, yaw: controller.yaw, pitch: controller.pitch + controller.tiltP };
      roll = controller.tiltR;
      if (ctrlReason === 'downed') roll = 0.35;
      if (settings.thirdPerson) {
        champPose = { x: cam.x, y: cam.y - EYE_H, z: cam.z, yaw: cam.yaw };
        cam = shoulderCam(cam);
        roll = 0;
      }
    }
    if (!viewReady && sawFrame && (settleT += fdt) > 0.5) {
      viewReady = true;
      updateLockUi(); // still at the click-to-play card: hold the world there
    }
    renderer.render(cam, {
      champId: champId(), sightTiles: hud?.champion?.sight ?? 12, torch: !!hud?.champion?.torch, fold: hud?.fold ?? 0,
      lairsHome: new Set(hud?.lairsHome ?? []), viewModel: !champPose && (ctrlReason === 'player' || ctrlReason === 'hold' || ctrlReason === 'autopilot'), champPose,
      moveSpeed: controller.moveSpeed, sprinting: controller.sprinting, blocking: controller.blocking, dragging: !!hud?.champion?.dragging, roll,
    });

    // the minimap, every frame: it turns with the view. Creatures only in sight, as on the M map
    {
      const dead = ctrlReason === 'dead';
      const at = dead ? { x: spectator.x / M, z: spectator.z / M } : { x: controller.x, z: controller.z };
      const sight = (hud?.champion?.sight ?? 10) * M, reach = Math.min(sight, minimap.range + 10);
      const dots: MinimapDot[] = [];
      renderer.ents.each((v) => {
        if (v.id === champId() || v.flags & F_CORPSE || !(v.flags & (F_MONSTER | F_HUMAN))) return;
        if (Math.hypot(v.pos.x - at.x * M, v.pos.z - at.z * M) > reach) return;
        dots.push({ x: v.pos.x / M, z: v.pos.z / M, kind: v.flags & F_MONSTER ? 'monster' : 'villager' });
      });
      minimap.draw(renderer.terrain, at, dead ? spectator.yaw : controller.yaw, landmarks, dots);
    }

    // look target and HUD
    const { eye, dir } = renderer.lookRay();
    look = ctrlReason === 'dead' ? null : renderer.ents.pick(eye, dir, 40, champId());
    const info = look ? targetInfo(look.id) : null;
    if (info && look && info.hostile && !info.downed && look.t <= reachM()) {
      const arch = renderer.ents.arch(look.id);
      info.zone = arch ? zoneFor(arch, look.h, look.s, look.f) : null;
    }
    hudView.setTarget(info, promptFor());
    if (look && info?.downed) hudView.hintOnce('downed');
    audio.listener({ x: eye.x, y: eye.y, z: eye.z }, dir.x, dir.y, dir.z);
    const shore = renderer.terrain.tileAt(controller.x, controller.z) === 'sand' ? 1 : 0;
    audio.ambience(renderer.sky.night, shore, renderer.structures.fires[0]?.pos ?? null);

    // wind-up arcs toward anything winding up near you (F20)
    const arcs: { rel: number; prog: number }[] = [];
    renderer.ents.each((v) => {
      if (!(v.flags & F_TELEGRAPH)) return;
      const d = Math.hypot(v.pos.x - cam.x, v.pos.z - cam.z);
      if (d > 14) return;
      let rel = Math.atan2(v.pos.x - cam.x, v.pos.z - cam.z) - cam.yaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      arcs.push({ rel, prog: Math.min(1, Math.max(0, v.windup) + (performance.now() - v.windupAt) / 800 + 0.25) });
    });
    if (arcs.length) hudView.hintOnce('windup');
    hudView.drawFx(arcs, hud?.champion ? hud.champion.hp / hud.champion.maxHp : 1);

    // the compass turns with the view every frame; its markers are rebuilt with the rest of the HUD below
    hudView.turnCompass(ctrlReason === 'dead' ? spectator.yaw : controller.yaw);
    if (performance.now() - lastHud > 100) {
      lastHud = performance.now();
      if (hud) hudView.setHud(hud, controller.stamina, controller.winded, wield);
      hudView.setDowned(ctrlReason === 'downed' ? 'You are beaten down. Crawl away (WASD) — you will rise in a few seconds.' : ctrlReason === 'captive' ? 'You are being carried to the High Place!' : null);
      const L = renderer.layout;
      const marks: CompassMarker[] = [];
      if (L) {
        marks.push({ x: L.gates[0].x + 0.5, z: L.gates[0].z + 0.5, icon: '⌂', label: 'Village gate' });
        marks.push({ x: L.villageAltar.x + 0.5, z: L.villageAltar.z + 0.5, icon: '🔥', cls: hud?.champion?.dragging ? 'altar-hot' : '', label: 'Altar of the Most High' });
        marks.push({ x: L.highAltar.x + 0.5, z: L.highAltar.z + 0.5, icon: '▲', label: 'The High Place' });
        for (const mc of monsterCards) {
          if (!mc.lairFound) continue;
          const p = L.lairs[REGION_NAMES.indexOf(mc.region)];
          if (p) marks.push({ x: p.x + 0.5, z: p.z + 0.5, icon: mc.dead ? '✝' : '☠', cls: mc.dead ? 'dead' : '', label: `${mc.name}'s lair` });
        }
      }
      for (const s of screams) marks.push({ x: s.x, z: s.z, icon: '!', cls: 'scream', label: 'A scream' });
      if (creationMarker && performance.now() < creationMarker.until) marks.push({ x: creationMarker.x, z: creationMarker.z, icon: '✦', label: creationMarker.label });
      landmarks = marks;
      const dead = ctrlReason === 'dead';
      hudView.setCompass(dead ? spectator.yaw : controller.yaw, dead ? spectator.x / M : controller.x, dead ? spectator.z / M : controller.z, marks);
      if (map.open) {
        const kindOf = (icon: string): MapMarker['kind'] => (icon === '⌂' ? 'village' : icon === '🔥' ? 'altar' : icon === '▲' ? 'high' : icon === '☠' ? 'lair' : icon === '✝' ? 'lair-dead' : icon === '!' ? 'scream' : 'creation');
        const mm: MapMarker[] = marks.map((m) => ({ x: m.x, z: m.z, kind: kindOf(m.icon), label: m.icon === '☠' || m.icon === '✝' ? m.label : undefined }));
        // only what you can actually see right now
        const sight = (hud?.champion?.sight ?? 10) * M;
        renderer.ents.each((v) => {
          if (v.id === champId()) return;
          const d = Math.hypot(v.pos.x - controller.x * M, v.pos.z - controller.z * M);
          if (d > sight) return;
          if (v.flags & F_MONSTER && !(v.flags & F_CORPSE)) mm.push({ x: v.pos.x / M, z: v.pos.z / M, kind: 'monster' });
          else if (v.flags & F_HUMAN) mm.push({ x: v.pos.x / M, z: v.pos.z / M, kind: 'villager' });
        });
        mm.push({ x: controller.x, z: controller.z, kind: 'champion', yaw: controller.yaw });
        map.draw(mm, now);
      }
    }
  }

  // ---------- lifecycle ----------
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sim.setPaused(true);
    else {
      sim.setPaused(paused);
      // a paused island waited for you: there's no time away to catch up
      if (!paused) sim.post({ type: 'catchUp', clockMs: localNow(), realMs: Date.now() });
      pipeline.kick();
    }
  });
  window.addEventListener('pagehide', () => sim.post({ type: 'requestSave' }));
  setInterval(() => sim.post({ type: 'requestSave' }), 30_000);

  // ---------- go ----------
  startSim();
  if (params.has('nogod')) pipeline.stop();
  pipeline.kick();
  updateLockUi();
  if (devMode && params.get('devinstall')) setTimeout(() => devInstall(params.get('devinstall')!), 1500);
  const panel = devMode ? params.get('panel') : null;
  if (panel) setTimeout(() => (panel === 'altar' ? ui.openAltar() : panel === 'map' ? map.toggle(true, { x: controller.x, z: controller.z }) : ui.openSheet(panel)), 2500);
  if (devMode && params.has('pitch')) setInterval(() => (controller.pitch = (Number(params.get('pitch')) * Math.PI) / 180), 200);
  if (devMode && params.has('yaw')) setInterval(() => (controller.yaw = (Number(params.get('yaw')) * Math.PI) / 180), 200);
  if (climbLog) setInterval(() => console.info(`[climb] ${controller.mode} ${controller.x.toFixed(2)},${controller.z.toFixed(2)} feet ${controller.feetY.toFixed(1)} ground ${renderer.terrain.y(controller.x, controller.z).toFixed(1)} st ${controller.stamina.toFixed(0)} yaw ${controller.yaw.toFixed(2)} ${ctrlReason} ${controller.ctrl} tile ${renderer.terrain.tileAt(controller.x, controller.z)}${controller.mount ? ` on ${controller.mount.id} cap ${controller.mount.cap}${controller.perched ? ' perched' : ''}` : ''}${nearestClimbable()}`), 1000);
  /** the nearest climbable monster and how far the hands are from its body (docs/climbing-phase3-plan.md) */
  function nearestClimbable() {
    let best = '', bd = Infinity;
    renderer.ents.each((v) => {
      if (!(v.flags & F_MONSTER) || !CLIMB[v.shape]) return;
      const d = Math.hypot(v.pos.x - controller.x * M, v.pos.z - controller.z * M);
      if (d >= bd) return;
      bd = d;
      const caps = bodyCaps(v);
      const hands = caps ? bodyDist(caps, new THREE.Vector3(controller.x * M, controller.feetY + 1.3, controller.z * M)).toFixed(2) : 'none';
      best = ` | ${v.shape} ${d.toFixed(1)} m${v.flags & F_DOWNED ? ' downed' : ''}, ${(v.pos.y - controller.feetY).toFixed(1)} m up, hands ${hands} m from its body`;
    });
    return best;
  }
  // dev: ?hold=forward:2000:9000,jump:9000:9500 — hold actions from/to ms after the world is ready (headless
  // climbing checks; loading takes a varying few seconds)
  function startHolds() {
    if (devMode && params.get('hold')) for (const spec of params.get('hold')!.split(',')) {
      const [a, from, to] = spec.split(':');
      // the mouse buttons: grip (right: block, or hold on to a body) and attack (left)
      const button = a === 'grip' ? 'mouseR' : a === 'attack' ? 'mouseL' : null;
      if (button) {
        setTimeout(() => (controls[button] = true), Number(from) || 0);
        setTimeout(() => (controls[button] = false), Number(to) || 1e9);
        continue;
      }
      const code = settings.bindings[a as keyof typeof settings.bindings];
      if (!code) continue;
      // one-shot actions (jump) are pressed again every 250 ms while held and not climbing, so a run can keep
      // trying to get on something, then stay on it
      const press = () => (controls as unknown as { pressed: Set<string> }).pressed.add(a);
      let again = 0;
      setTimeout(() => {
        controls.keys.add(code);
        press();
        again = window.setInterval(() => !controller.climbing && press(), 250);
      }, Number(from) || 0);
      setTimeout(() => {
        controls.keys.delete(code);
        clearInterval(again);
      }, Number(to) || 1e9);
    }
  }
  // dev: ?fly=m — fly mode at m meters above the sea (screenshots of the whole island)
  const flyAt = devMode ? Number(params.get('fly')) : 0;
  if (flyAt) setTimeout(() => {
    controller.setFlying(true);
    (controller as any).flyY = flyAt;
  }, 1500);
  const judge = devMode ? params.get('judge') : null;
  if (judge) setTimeout(() => {
    const [g, n] = judge.split(':');
    sim.post({ type: 'devJudge', human: g === 'human' ? Number(n) || 300 : 0, monster: g === 'monster' ? Number(n) || 300 : 0 });
  }, 1500);
  renderer.renderer.setAnimationLoop(frame);
  (window as any).__hm = { sim, pipeline, renderer, store, controller, audio, minimap, hud: () => hud, chronicle: () => chronicle };
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('ui')!.innerHTML = `<pre style="color:#fff;padding:20px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
