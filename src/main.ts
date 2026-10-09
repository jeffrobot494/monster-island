import { Renderer } from './render/renderer';
import { SimClient } from './sim-client';
import { Ui } from './ui/ui';
import { pickPlatform } from './platform';
import { KEYS } from './persist/save-store';
import { GodPipeline, type Job } from './god/pipeline';
import { runValidation } from './god/validation-host';
import type { SavedWorld } from './sim/island';
import type { ChronicleEvent } from './sim/types';
import type { ModuleStat, SimToMain } from './protocol';
import firefliesSrc from './god/reference-modules/fireflies.js?raw';
import wadingSrc from './god/reference-modules/wading.js?raw';
import { DEV_BROKEN } from './god/reference-modules/dev-broken';
import { TICKS_PER_DAY } from './sim/time';

const params = new URLSearchParams(location.search);
const devMode = import.meta.env.DEV;

if (params.has('debug')) {
  // mirror logs onto the page (for headless screenshots)
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;left:8px;bottom:60px;max-width:60vw;max-height:45vh;overflow:hidden;z-index:9;font:11px monospace;color:#fff;background:rgba(0,0,0,.6);padding:6px;white-space:pre-wrap;pointer-events:none';
  document.body.append(pre);
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[k].bind(console);
    console[k] = (...a: unknown[]) => {
      orig(...a);
      pre.textContent = (pre.textContent + `\n[${k}] ` + a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).slice(-4000);
    };
  }
  addEventListener('error', (e) => console.error('uncaught', e.message, e.filename, e.lineno));
}

async function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  let ui!: Ui;
  // dev autopilot: ?manualsrc=fireflies|wading answers the manual god with a reference module (id rewritten)
  const autoSource = (prompt: string) => {
    const name = params.get('manualsrc');
    const id = prompt.match(/Its id MUST be '([^']+)'/)?.[1];
    if (!devMode || !name || !id) return null;
    const src = name === 'fireflies' ? firefliesSrc : name === 'wading' ? wadingSrc : DEV_BROKEN[name] ?? null;
    return src ? src.replace(/id: '(fireflies|wading|hang|thrower)'/, `id: '${id}'`) : null;
  };
  const platform = await pickPlatform(params, (p) => ui.askSource(p), autoSource);
  const store = platform.store;
  if (params.get('fresh') === '1') {
    await platform.store.clear?.();
    params.delete('fresh');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }

  // ---------- persisted state ----------
  let worldJson = await store.get(KEYS.world);
  let world: SavedWorld | null = worldJson ? JSON.parse(worldJson) : null;
  let chronicle: ChronicleEvent[] = JSON.parse((await store.get(KEYS.chronicle)) ?? '[]');
  const sources: Record<string, string> = {};
  for (const m of world?.manifest ?? []) {
    const s = await store.get(KEYS.mod(m.id));
    if (s !== null) sources[m.id] = s;
  }
  const seed = Number(params.get('seed')) || world?.core.seed || (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0);

  // ---------- live state ----------
  const sim = new SimClient();
  let tick = world?.core.tick ?? 0;
  let userPaused = false;
  let shrineId: number | null = null;
  let shrineStage = -1;
  let stats: ModuleStat[] = [];
  let reveal: { id: string; untilTick: number; pos: { x: number; z: number } | null } | null = null;
  const firstVisible = new Map<string, { x: number; z: number }>();
  let saveWaiters: ((w: string) => void)[] = [];
  let installWaiter: ((r: { ok: boolean; error?: string }) => void) | null = null;
  let chronicleDirty = false;

  const pushEvents = (events: ChronicleEvent[]) => {
    if (params.has('debug')) for (const e of events) console.info(`[chronicle] day ${e.day + 1}: ${e.text}`);
    chronicle.push(...events);
    if (chronicle.length > 150) chronicle = chronicle.slice(-150);
    chronicleDirty = true;
    ui.setChronicle(chronicle);
    for (const e of events) if (e.importance >= 3 && e.source !== 'god') ui.showBanner(e.text, false);
  };
  const godLog = (text: string, importance: number) => pushEvents([{ tick, day: Math.floor(tick / TICKS_PER_DAY), text, importance, source: 'god' }]);

  const applyPause = () => {
    const paused = userPaused || pipeline.choosing || document.hidden;
    sim.setControl({ paused });
    renderer.paused = paused;
    ui.setSpeed(sim.speed, paused);
  };

  const titles = () => Object.fromEntries((world?.manifest ?? []).map((m) => [m.id, m.title]));

  const doReveal = (pos: { x: number; z: number }) => {
    if (ui.isPanelOpen() || pipeline.choosing) {
      reveal!.pos = pos;
      ui.showBanner('The god’s work stirs somewhere on the island.', true, 12);
    } else {
      renderer.flyTo(pos.x, pos.z, 22);
      reveal = null;
    }
  };

  ui = new Ui({
    onSpeed: (s) => {
      userPaused = false;
      sim.setControl({ speed: s });
      renderer.speed = s;
      applyPause();
    },
    onPause: () => {
      userPaused = !userPaused;
      applyPause();
    },
    onChoose: (i, whisper) => {
      pipeline.choose(i, whisper).then(applyPause);
    },
    onShowMe: () => {
      if (reveal?.pos) renderer.flyTo(reveal.pos.x, reveal.pos.z, 22);
      reveal = null;
    },
    onCloseInspector: () => {
      renderer.selectedId = null;
      sim.post({ type: 'inspect', id: null });
      ui.setInspector(null);
    },
    onToggleModule: (id, active) => sim.post({ type: 'setModuleStatus', id, status: active ? 'active' : 'quarantined' }),
    onDevInstall: async (name) => {
      const src = name === 'fireflies' ? firefliesSrc : name === 'wading' ? wadingSrc : DEV_BROKEN[name];
      if (sources[name]) return ui.showBanner(`${name} is already installed.`, false);
      const r = await install(name, src);
      ui.showBanner(r.ok ? `Installed ${name}.` : `Install failed: ${r.error}`, false);
    },
    onPanelChange: () => {},
  }, `${platform.name} · ${platform.provider.name}`, devMode);
  if (platform.warning) ui.showBanner(platform.warning, false, 12);
  ui.setChronicle(chronicle);

  // ---------- sim worker ----------
  const snapshotWorld = () =>
    new Promise<string>((resolve) => {
      saveWaiters.push(resolve);
      sim.post({ type: 'requestSave' });
    });

  async function install(id: string, source: string): Promise<{ ok: boolean; error?: string }> {
    await store.set(KEYS.mod(id), source); // immutable once written; before the world that lists it
    sources[id] = source;
    const r = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      installWaiter = resolve;
      sim.post({ type: 'install', id, source });
    });
    if (!r.ok) {
      delete sources[id];
      await store.remove(KEYS.mod(id));
    }
    return r;
  }

  let dbgFrames = 0;
  sim.onMessage = (m: SimToMain) => {
    if (params.has('debug') && (m.type !== 'frame' || dbgFrames++ % 100 === 0) && m.type !== 'moduleStats' && m.type !== 'events') console.info(`[sim→main] ${m.type}${m.type === 'frame' ? ` tick ${m.tick} ents ${m.ents.length / 9}` : ''}`);
    switch (m.type) {
      case 'defs':
        renderer.onDefs(m);
        break;
      case 'fullState':
        renderer.onFullState(m);
        tick = m.tick;
        shrineStage = -1;
        findShrine();
        break;
      case 'frame': {
        renderer.onFrame(m);
        tick = m.tick;
        ui.setTime(tick);
        if (shrineId === null) findShrine();
        if (reveal && !reveal.pos && tick > reveal.untilTick) {
          const s = shrineId !== null ? renderer.shapes.positionOf(shrineId) : null;
          reveal.untilTick = Infinity;
          if (s) doReveal({ x: s.x, z: s.z });
        }
        if (tick % 10 === 0) ui.setPops(m.pops[0], m.pops[1]);
        break;
      }
      case 'events':
        pushEvents(m.events);
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
        if (reveal?.id === m.id && !reveal.pos) doReveal({ x: m.x, z: m.z });
        break;
      case 'dawn':
        pipeline.onDawn();
        break;
      case 'moduleFault':
        console.warn(`[module ${m.id}] ${m.hook}: ${m.error}${m.stack ? ` (${m.stack})` : ''}`);
        break;
      case 'quarantined':
        console.warn(`[module ${m.id}] quarantined: ${m.reason}`);
        break;
      case 'moduleStats':
        stats = m.stats;
        ui.setModuleStats(stats, titles());
        break;
      case 'inspect':
        ui.setInspector(m.info);
        if (!m.info) renderer.selectedId = null;
        break;
      case 'error':
        console.error('[sim]', m.error);
        break;
    }
  };

  function findShrine() {
    const idx = renderer.shapes.shapeIds.indexOf('shrine');
    for (const v of renderer.shapes.ents.values()) if (v.shapeIdx === idx) shrineId = v.id;
    shrineStage = -1;
    updateShrine();
  }

  function updateShrine() {
    ui.setShrine(pipeline.status, pipeline.stage);
    if (shrineId === null || pipeline.stage === shrineStage) return;
    for (const s of [1, 2, 3]) renderer.particles.detach(shrineId, `shrine-${s}`);
    if (pipeline.stage > 0) renderer.particles.attach(shrineId, `shrine-${pipeline.stage}`);
    shrineStage = pipeline.stage;
  }

  sim.onHang = () => {
    // Watchdog: restart from the last save with the most recently activated module quarantined (Phase 1).
    const active = (world?.manifest ?? []).filter((m) => m.status === 'active');
    const culprit = active[active.length - 1];
    godLog(culprit ? `The island froze. The god stills "${culprit.title}".` : 'The island trembled and froze for a moment.', 2);
    sim.start({ save: worldJson, seed, modules: modulesFor(world), quarantine: culprit ? [culprit.id] : [] });
    applyPause();
  };

  const modulesFor = (w: SavedWorld | null) => (w?.manifest ?? []).filter((m) => sources[m.id] !== undefined).map((m) => ({ id: m.id, source: sources[m.id], status: m.status }));

  // ---------- the god ----------
  const pipeline = new GodPipeline({
    provider: platform.provider,
    loadPending: () => store.get(KEYS.pending),
    savePending: (json) => store.set(KEYS.pending, json),
    snapshotWorld,
    sources: () => ({ ...sources }),
    chronicle: () => chronicle,
    log: godLog,
    validate: (req, onStage) => runValidation(req, onStage),
    install,
    onActivated: (job: Job) => {
      const seen = firstVisible.get(job.id);
      reveal = { id: job.id, untilTick: tick + TICKS_PER_DAY, pos: null };
      if (seen) doReveal(seen);
    },
    onChange: () => {
      if (devMode && params.has('auto') && pipeline.choosing) setTimeout(() => pipeline.choose(0), 800);
      updateShrine();
      ui.showOmens(pipeline.choosing ? pipeline.state.omens : null);
      applyPause();
    },
    isHidden: () => document.hidden,
    pick: (n) => Math.floor(Math.random() * n),
  });
  await pipeline.load();

  // ---------- input ----------
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const id = renderer.pickAt(e.clientX, e.clientY);
    renderer.selectedId = id;
    sim.post({ type: 'inspect', id });
    if (id === null) ui.setInspector(null);
  });
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      userPaused = !userPaused;
      applyPause();
      e.preventDefault();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sim.post({ type: 'requestSave' });
    applyPause();
  });
  setInterval(() => sim.post({ type: 'requestSave' }), 30_000);

  // ---------- go ----------
  if (params.get('speed')) {
    sim.speed = renderer.speed = Number(params.get('speed'));
  }
  sim.start({ save: worldJson, seed, modules: modulesFor(world), skip: devMode ? Number(params.get('skip')) || 0 : 0 });
  if (params.has('nogod')) pipeline.stop();
  const cam = params.get('cam')?.split(',').map(Number);
  if (cam?.length === 3) renderer.flyTo(cam[0], cam[1], cam[2], 0.01);
  ui.showOmens(pipeline.choosing ? pipeline.state.omens : null);
  applyPause();
  pipeline.kick();
  const devInstall = devMode ? params.get('devinstall') : null;
  if (devInstall) setTimeout(() => ui.cb.onDevInstall(devInstall), 1500);
  renderer.renderer.setAnimationLoop(() => renderer.render());
  (window as any).__mi = { sim, pipeline, renderer, store, chronicle: () => chronicle };
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('ui')!.innerHTML = `<pre style="color:#fff;padding:20px">${String(err?.stack ?? err)}</pre>`;
});
