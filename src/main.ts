import * as THREE from 'three';
import { Renderer } from './render/renderer';
import { SimClient } from './sim-client';
import { Ui } from './ui/ui';
import { pickPlatform } from './platform';
import { KEYS } from './persist/save-store';
import { CreationPipeline } from './god/pipeline';
import { runValidation } from './god/validation-host';
import type { SavedWorld } from './sim/island';
import type { ChronicleEvent, CreationRecord } from './sim/types';
import { F_BOUND, F_CHAMPION, F_DOWNED, F_INHABITANT, F_MONSTER, type Hud, type SimToMain } from './protocol';
import type { Alert } from './sim/sim';
import type { Order } from './sim/champion';
import houndsSrc from './god/reference-modules/war-hounds.js?raw';
import fogSrc from './god/reference-modules/poison-fog.js?raw';
import { HOUR_MS } from './sim/clock';

const params = new URLSearchParams(location.search);
const devMode = import.meta.env.DEV;
const REF: Record<string, string> = { 'war-hounds': houndsSrc, 'poison-fog': fogSrc };

if (params.has('debug')) {
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;left:8px;top:120px;max-width:70vw;max-height:40vh;overflow:hidden;z-index:9;font:10px monospace;color:#fff;background:rgba(0,0,0,.6);padding:6px;white-space:pre-wrap;pointer-events:none';
  document.body.append(pre);
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[k].bind(console);
    console[k] = (...a: unknown[]) => {
      orig(...a);
      pre.textContent = (pre.textContent + `\n[${k}] ` + a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).slice(-3000);
    };
  }
  addEventListener('error', (e) => console.error('uncaught', e.message, e.filename, e.lineno));
}

/** Local wall time as epoch ms (see sim/clock.ts). */
function localNow(): number {
  return Date.now() - new Date().getTimezoneOffset() * 60_000;
}

let audio: AudioContext | null = null;
function shofar() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    const g = audio.createGain();
    const f = audio.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.15);
    g.gain.setValueAtTime(0.18, t + 0.9);
    g.gain.linearRampToValueAtTime(0, t + 1.6);
    for (const [a, b] of [[196, 294], [198, 296]]) {
      const o = audio.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(a, t);
      o.frequency.linearRampToValueAtTime(b, t + 0.5);
      o.connect(f);
      o.start(t);
      o.stop(t + 1.7);
    }
    f.connect(g).connect(audio.destination);
  } catch {
    /* no audio */
  }
}

async function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  let ui!: Ui;
  const autoSource = (prompt: string) => {
    const name = params.get('manualsrc');
    const id = prompt.match(/Its id MUST be '([^']+)'/)?.[1];
    if (!devMode || !name || !id || !REF[name]) return null;
    return REF[name].replace(/id: '(war-hounds|poison-fog)'/, `id: '${id}'`);
  };
  const platform = await pickPlatform(params, (p) => ui.askSource(p), autoSource);
  const store = platform.store;
  if (params.get('fresh') === '1') {
    await store.clear?.();
    params.delete('fresh');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }

  // ---------- persisted state ----------
  let worldJson = await store.get(KEYS.world);
  let world: SavedWorld | null = worldJson ? JSON.parse(worldJson) : null;
  if (world && world.core?.v !== 2) {
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
  let hud: Hud | null = null;
  let chronicleDirty = false;
  let saveWaiters: ((w: string) => void)[] = [];
  let installWaiter: ((r: { ok: boolean; error?: string }) => void) | null = null;
  let scream: { ent: number; until: number; text: string } | null = null;
  let readyCreation: CreationRecord | null = null;
  let safeSince = 0;
  const firstVisible = new Map<string, { x: number; z: number }>();
  let panelOpen = false;
  let gameOverShown = false;
  let revealed = params.has('reveal');
  let lastOrderTarget: number | null = null;

  const pushEvents = (events: ChronicleEvent[]) => {
    if (params.has('debug')) for (const e of events) console.info(`[chronicle] D${e.day}: ${e.text}`);
    chronicle.push(...events);
    if (chronicle.length > 200) chronicle = chronicle.slice(-200);
    chronicleDirty = true;
    ui.setChronicle(chronicle);
  };
  const godLog = (text: string, importance: number) => pushEvents([{ tick: hud?.tick ?? 0, clockMs: hud?.clockMs ?? localNow(), day: hud?.day ?? 1, text, importance, source: 'god' }]);

  const order = (o: Order) => sim.post({ type: 'order', order: o });

  ui = new Ui({
    action: (a) => sim.post({ type: 'action', action: a }),
    finish: () => {
      const t = hud?.champion?.downedTarget;
      if (t) order({ type: 'finish', id: t.id });
    },
    drop: () => order({ type: 'drop' }),
    goAltar: () => {
      if (hud?.champion?.nearAltar) ui.openAltar();
      else order({ type: 'altar' });
    },
    toggleMap: () => {
      renderer.mapMode = !renderer.mapMode;
    },
    closeInspector: () => {
      renderer.selectedId = null;
      sim.post({ type: 'inspect', id: null });
      ui.setInspector(null);
    },
    newIsland: async () => {
      sim.setPaused(true);
      await store.clear?.();
      const p = new URLSearchParams(location.search);
      p.delete('seed');
      location.search = p.toString();
    },
    showCreation: () => showCreation(),
    dev: (cmd) => {
      if (cmd === 'judge-human') sim.post({ type: 'devJudge', human: 300, monster: 0 });
      else if (cmd === 'judge-monster') sim.post({ type: 'devJudge', human: 0, monster: 300 });
      else if (cmd === 'skip-8') sim.post({ type: 'devSkipHours', hours: 8 });
      else if (cmd.startsWith('install-')) devInstall(cmd.slice(8));
      else if (cmd === 'reveal') {
        revealed = !revealed;
        renderer.setReveal(revealed);
      }
    },
    panelChanged: (open) => {
      panelOpen = open;
    },
  }, devMode);
  if (platform.warning) ui.toast(platform.warning, 'info', 10);
  ui.setChronicle(chronicle);
  if (revealed) renderer.setReveal(true);

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
    if (p) renderer.flyTo(p.x, p.z, 30, 2);
    ui.genesis(rec);
  }

  function handleAlert(a: Alert) {
    switch (a.kind) {
      case 'scream':
        ui.toast(a.text, 'scream', 8);
        if (a.ent !== undefined) scream = { ent: a.ent, until: performance.now() + 60_000, text: a.text };
        break;
      case 'champion':
        ui.toast(a.text, 'champion', 8);
        if (a.ent !== undefined) scream = { ent: a.ent, until: performance.now() + 60_000, text: a.text };
        break;
      case 'shofar':
        ui.toast(a.text, 'shofar', 6);
        shofar();
        break;
      case 'judgment':
        ui.banner('Judgment', a.text, 'judgment', 9);
        break;
      case 'lair':
        ui.banner('A lair', a.text, 'lair', 6);
        break;
      case 'altar':
        if (!panelOpen) ui.openAltar();
        break;
      case 'gameover':
        break;
      default:
        ui.toast(a.text, a.kind, 6);
    }
  }

  let firstFull = true;
  sim.onMessage = (m: SimToMain) => {
    switch (m.type) {
      case 'defs':
        renderer.onDefs(m);
        break;
      case 'fullState':
        renderer.onFullState(m);
        if (firstFull) {
          firstFull = false;
          const cam = params.get('cam')?.split(',').map(Number);
          if (cam?.length === 3) {
            renderer.followId = null;
            renderer.target.set(cam[0], 0, cam[1]);
            renderer.dist = cam[2];
          }
        }
        break;
      case 'frame':
        renderer.onFrame(m);
        break;
      case 'hud': {
        hud = m.hud;
        renderer.hour = hud.hour;
        renderer.light = hud.light;
        if (!params.get('cam')) renderer.followId = hud.champion?.id ?? null;
        ui.setHud(hud);
        if (hud.gameOver && !gameOverShown) {
          gameOverShown = true;
          ui.gameOver(hud.gameOver.winner, hud);
        }
        // creation card waits until the champion is out of danger (R31)
        if (hud.dangerNear) safeSince = performance.now();
        if (readyCreation && !panelOpen && performance.now() - safeSince > 10_000) showCreation();
        if (pipeline && hud.pendingCreations.length) pipeline.kick();
        break;
      }
      case 'villagers':
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
        if (m.summary.hours >= 0.25) ui.away(m.summary);
        break;
      case 'inspect':
        ui.setInspector(m.info);
        if (!m.info) renderer.selectedId = null;
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

  function startSim(quarantine: string[] = []) {
    let clock = localNow();
    const at = params.get('at');
    if (at && !worldJson) {
      const [hh, mm] = at.split(':').map(Number);
      clock = clock - (clock % 86_400_000) + ((hh || 0) * 60 + (mm || 0)) * 60_000;
    }
    sim.start({
      save: worldJson, seed, modules: modulesFor(world), clockMs: clock, realMs: Date.now(),
      timescale: Math.max(1, Number(params.get('timescale')) || 1), quarantine, reveal: params.has('reveal'), invincible: devMode && params.has('god'),
      skip: devMode ? Number(params.get('skip')) || 0 : 0,
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

  // ---------- input: tap to move, tap to attack, long-press to inspect, pinch/wheel to zoom ----------
  const pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  let pinch: { d: number; dist: number } | null = null;
  let longTimer = 0;
  let longFired = false;
  const SKIP = new Set(['blood', 'part-limb', 'part-head', 'part-horn', 'part-wing', 'corpse-lower']);
  const shapeName = (idx: number) => renderer.shapes.shapeIds[idx] ?? '';
  const anyPick = (v: { shapeIdx: number; flags: number }) => !SKIP.has(shapeName(v.shapeIdx)) && !(v.flags & F_CHAMPION);

  function inspectAt(x: number, y: number) {
    const id = renderer.pickAt(x, y, anyPick, 1.1);
    renderer.selectedId = id;
    sim.post({ type: 'inspect', id });
    if (id === null) ui.setInspector(null);
  }

  function tapAt(x: number, y: number) {
    if (renderer.mapMode) {
      renderer.mapMode = false;
      const g = renderer.groundAt(x, y);
      if (g) renderer.flyTo(g.x, g.z, renderer.dist, 0.6);
      return;
    }
    if (!hud?.champion) return inspectAt(x, y);
    const id = renderer.pickAt(x, y, anyPick, 0.9);
    const v = id !== null ? renderer.shapes.ents.get(id) : undefined;
    if (v) {
      const shape = shapeName(v.shapeIdx);
      if (v.flags & F_MONSTER) {
        if (v.flags & F_BOUND) order({ type: 'drag', id: v.id });
        else if (v.flags & F_DOWNED) order({ type: 'bind', id: v.id });
        else {
          order({ type: 'attack', id: v.id });
          lastOrderTarget = v.id;
          renderer.targetId = v.id;
        }
        return;
      }
      if (shape === 'village-altar') return ui.cb.goAltar();
      if (v.flags & F_INHABITANT || shape.startsWith('lair-') || shape === 'high-altar' || shape === 'house' || shape === 'house-lit' || shape === 'goat' || shape === 'ox' || shape === 'fold' || shape === 'granary') return inspectAt(x, y);
      // a body (corpse/bones of anything): pick it up and drag it
      const isCreatureShape = !!shape && !shape.startsWith('lair') && renderer.shapes.ents.get(v.id) && !(v.flags & F_INHABITANT);
      if (isCreatureShape && (shape === 'bones' || shape === 'corpse-upper' || ['human', 'champion', 'guard', 'shepherd', 'nephil', 'saraph', 'seir', 'lilit', 'rahab', 'anak', 'reem', 'tannin'].includes(shape))) {
        order({ type: 'drag', id: v.id });
        return;
      }
      return inspectAt(x, y);
    }
    const g = renderer.groundAt(x, y);
    if (!g) return;
    renderer.targetId = null;
    lastOrderTarget = null;
    renderer.markTap(g.x, g.z);
    order({ type: 'move', x: g.x, z: g.z });
    ui.cb.closeInspector();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: renderer.dist };
      clearTimeout(longTimer);
    } else if (pointers.size === 1) {
      longFired = false;
      longTimer = window.setTimeout(() => {
        const p = pointers.get(e.pointerId);
        if (p && Math.hypot(p.x - p.sx, p.y - p.sy) < 10) {
          longFired = true;
          inspectAt(p.x, p.y);
        }
      }, 500);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      renderer.dist = Math.min(64, Math.max(12, pinch.dist * (pinch.d / Math.max(20, d))));
    } else if (pointers.size === 1 && (renderer.followId === null || renderer.mapMode) && Math.hypot(p.x - p.sx, p.y - p.sy) > 10) {
      // free camera only during the interregnum, in map mode or with ?cam
      const k = (renderer.mapMode ? 150 : renderer.dist) / innerHeight;
      renderer.target.x -= dx * k;
      renderer.target.z -= dy * k;
    }
  });
  const up = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    clearTimeout(longTimer);
    if (pointers.size < 2) pinch = null;
    if (!p || longFired) return;
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 10 && performance.now() - p.t < 500 && pointers.size === 0) tapAt(e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
  });
  canvas.addEventListener('wheel', (e) => {
    renderer.zoom(e.deltaY > 0 ? 1.1 : 0.9);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- lifecycle ----------
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sim.setPaused(true);
    else {
      sim.setPaused(false);
      sim.post({ type: 'catchUp', clockMs: localNow(), realMs: Date.now() });
      pipeline.kick();
    }
  });
  addEventListener('pagehide', () => sim.post({ type: 'requestSave' }));
  setInterval(() => sim.post({ type: 'requestSave' }), 30_000);

  // arrow toward a screaming captive (or the monster carrying the champion)
  const v3 = new THREE.Vector3();
  setInterval(() => {
    if (!scream || performance.now() > scream.until) {
      scream = null;
      ui.setArrow(0, 0, 0, false);
      return;
    }
    const p = renderer.shapes.positionOf(scream.ent);
    if (!p) {
      ui.setArrow(0, 0, 0, false);
      return;
    }
    v3.copy(p).project(renderer.camera);
    const W = innerWidth, H = innerHeight;
    let sx = (v3.x * 0.5 + 0.5) * W, sy = (-v3.y * 0.5 + 0.5) * H;
    if (v3.z > 1) { sx = W - sx; sy = H - sy; }
    const on = sx > 30 && sx < W - 30 && sy > 90 && sy < H - 120 && v3.z <= 1;
    const cx = W / 2, cy = H / 2;
    const ang = Math.atan2(sy - cy, sx - cx);
    if (on) ui.setArrow(sx, sy - 40, Math.PI / 2, true, scream.text);
    else {
      const k = Math.min((W / 2 - 30) / Math.abs(Math.cos(ang) || 1e-6), (H / 2 - 110) / Math.abs(Math.sin(ang) || 1e-6));
      ui.setArrow(cx + Math.cos(ang) * k, cy + Math.sin(ang) * k, ang, true, scream.text);
    }
  }, 100);

  // ---------- go ----------
  startSim();
  if (params.has('nogod')) pipeline.stop();
  pipeline.kick();
  if (devMode && params.get('devinstall')) setTimeout(() => devInstall(params.get('devinstall')!), 1500);
  const scenario = devMode ? params.get('script') : null;
  if (scenario) setTimeout(() => sim.post({ type: 'devScenario', name: scenario }), 1200);
  const judge = devMode ? params.get('judge') : null;
  if (judge) setTimeout(() => {
    const [g, n] = judge.split(':');
    sim.post({ type: 'devJudge', human: g === 'human' ? Number(n) || 300 : 0, monster: g === 'monster' ? Number(n) || 300 : 0 });
  }, 1500);
  renderer.renderer.setAnimationLoop(() => renderer.render());
  (window as any).__hm = { sim, pipeline, renderer, store, hud: () => hud, chronicle: () => chronicle };
  void lastOrderTarget;
  void HOUR_MS;
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('ui')!.innerHTML = `<pre style="color:#fff;padding:20px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
