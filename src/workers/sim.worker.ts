import { harden, hostCreateBlobUrl, hostNow, hostPost, hostRevokeUrl, hostSetTimeout } from './harden';
import { Island, importDefault, type SavedWorld } from '../sim/island';
import { ENT_STRIDE, type MainToSim, type ModuleStat, type SimToMain } from '../protocol';
import type { FaultInfo, VisibleEffect } from '../sim/module-runtime';
import { TICKS_PER_SECOND } from '../sim/time';

const post = (m: SimToMain, transfer?: Transferable[]) => hostPost(m, transfer);
// capture before hardening removes them
const listen = self.addEventListener.bind(self);
harden();

let island: Island | null = null;
let speed = 1;
let paused = false;
let seq = 0;
let shapeIndex: string[] = [];
let shapeLookup = new Map<string, number>();
let defsKey = '';
let inspectId: number | null = null;
let busy = false;
let lastLoop = 0;
let acc = 0;

const loader = async (_id: string, source: string) => {
  const url = hostCreateBlobUrl(source);
  try {
    return await importDefault(url);
  } finally {
    hostRevokeUrl(url);
  }
};

const runtimeOpts = {
  now: hostNow,
  onFault: (f: FaultInfo) => post({ type: 'moduleFault', id: f.id, hook: f.hook, error: f.error, stack: f.line ? `line ${f.line}` : undefined }),
  onQuarantine: (id: string, reason: string) => {
    post({ type: 'quarantined', id, reason });
    queueSave('quarantine');
  },
  onVisible: (id: string, v: VisibleEffect) => post({ type: 'visible', id, x: v.x, z: v.z, what: v.what }),
};

let saveReason: string | null = null;
function queueSave(reason: string) {
  saveReason = reason;
}

function sendDefs(force = false) {
  const sim = island!.sim;
  const key = `${sim.defsVersion}:${sim.grid.defsVersion}:${sim.shapes.size}:${sim.emitters.size}`;
  if (!force && key === defsKey) return;
  defsKey = key;
  shapeIndex = [...sim.shapes.keys()];
  shapeLookup = new Map(shapeIndex.map((s, i) => [s, i]));
  post({ type: 'defs', shapes: [...sim.shapes], emitters: [...sim.emitters], tiles: [...sim.grid.defs.values()], shapeIndex });
}

function packEnts(): Float32Array {
  const sim = island!.sim;
  const list = [...sim.ents.values()].filter((e) => !e.hidden);
  const arr = new Float32Array(list.length * ENT_STRIDE);
  let o = 0;
  for (const e of list) {
    const tx = Math.floor(e.x), tz = Math.floor(e.z);
    arr[o++] = e.id;
    arr[o++] = shapeLookup.get(e.shape) ?? -1;
    arr[o++] = e.x;
    arr[o++] = sim.grid.height(tx, tz);
    arr[o++] = e.z;
    arr[o++] = e.yaw;
    arr[o++] = parseInt(e.tint.slice(1), 16);
    arr[o++] = e.scale;
    arr[o++] = e.inhabitant ? 1 : 0;
  }
  return arr;
}

function sendFullState() {
  const sim = island!.sim;
  sendDefs(true);
  const ents = packEnts();
  post({ type: 'fullState', seq: ++seq, tick: sim.tick, tiles: [...sim.grid.types], elev: sim.grid.elev.slice(), ents, attached: [...sim.attached].map(([id, s]) => [id, [...s]]), atmosphere: { ...sim.atmosphere } }, [ents.buffer]);
  sim.grid.changed.clear();
  sim.drainOut();
}

function save(reason: string) {
  island!.runtime.enforceStateCaps();
  post({ type: 'save', world: JSON.stringify(island!.serialize()), tick: island!.sim.tick, reason });
}

function tickOnce() {
  const sim = island!.sim;
  island!.step();
  if (sim.time.dayTick === 0) {
    post({ type: 'dawn', day: sim.time.day });
    queueSave('dawn');
  }
  sendDefs();
  const out = sim.drainOut();
  const tiles = sim.grid.drainChanged().map((i) => [i, sim.grid.types[i]] as [number, string]);
  const ents = packEnts();
  post({ type: 'frame', seq: ++seq, tick: sim.tick, ents, tiles, emitterOps: out.emitterOps, emotes: out.emotes, atmosphere: out.atmosphereDirty ? { ...sim.atmosphere } : undefined, pops: [sim.inhabitants('monster').length, sim.inhabitants('human').length] }, [ents.buffer]);
  if (out.events.length) post({ type: 'events', events: out.events });
  if (sim.tick % 5 === 0 && inspectId !== null) sendInspect();
  if (sim.tick % 30 === 0) sendStats();
  if (saveReason) {
    const r = saveReason;
    saveReason = null;
    save(r);
  }
}

function sendInspect() {
  const sim = island!.sim;
  const e = inspectId === null ? undefined : sim.ents.get(inspectId);
  if (!e) {
    post({ type: 'inspect', info: null });
    return;
  }
  post({
    type: 'inspect',
    info: { id: e.id, name: e.name, kind: e.kind, faction: e.faction, hunger: e.hunger, hp: e.hp, maxHp: sim.stat(e, 'maxHp'), behavior: e.behavior, tags: [...e.tags], data: structuredClone(e.data) },
  });
}

function sendStats() {
  const stats: ModuleStat[] = island!.runtime.mods.map((m) => {
    const s = { id: m.id, status: m.status, faultsToday: m.faultDay === island!.sim.time.day ? m.faultCount : 0, msPerTick: m.timeMs / 30 };
    m.timeMs = 0;
    return s;
  });
  post({ type: 'moduleStats', stats });
}

function loop() {
  const now = hostNow();
  const dt = Math.min(500, now - lastLoop);
  lastLoop = now;
  if (island && !paused && !busy) {
    acc += (dt / 1000) * TICKS_PER_SECOND * speed;
    let n = 0;
    while (acc >= 1 && n < 4) {
      acc -= 1;
      n++;
      tickOnce();
    }
    if (acc > 4) acc = 0; // fell behind: drop time rather than spiral
  }
  hostSetTimeout(loop, 1000 / TICKS_PER_SECOND / Math.max(1, speed) / 2);
}

listen('message', async (ev: MessageEvent<MainToSim>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        busy = true;
        speed = msg.speed;
        paused = msg.paused;
        if (msg.save) {
          const world = JSON.parse(msg.save) as SavedWorld;
          const sources = Object.fromEntries(msg.modules.map((m) => [m.id, m.source]));
          island = await Island.load(world, sources, loader, runtimeOpts, msg.quarantine ?? []);
        } else {
          island = Island.create(msg.seed, runtimeOpts);
        }
        for (let i = 0; i < (msg.skip ?? 0); i++) island.step(); // dev: fast-forward
        busy = false;
        sendFullState();
        const ev0 = island.sim.drainOut().events;
        if (ev0.length) post({ type: 'events', events: ev0 });
        if (msg.quarantine?.length || !msg.save) save('init');
        lastLoop = hostNow();
        break;
      }
      case 'control':
        if (msg.speed !== undefined) speed = msg.speed;
        if (msg.paused !== undefined) paused = msg.paused;
        break;
      case 'install': {
        busy = true;
        try {
          const def = await loader(msg.id, msg.source);
          island!.install(msg.id, def);
          post({ type: 'installed', id: msg.id, ok: true });
          sendDefs(true);
          save('activation');
        } catch (err) {
          post({ type: 'installed', id: msg.id, ok: false, error: (err as Error).message });
        } finally {
          busy = false;
        }
        break;
      }
      case 'setModuleStatus':
        island!.runtime.setStatus(msg.id, msg.status);
        island!.syncManifest();
        save('status');
        break;
      case 'requestSave':
        if (island) save('requested');
        break;
      case 'resync':
        if (island) sendFullState();
        break;
      case 'inspect':
        inspectId = msg.id;
        if (island) sendInspect();
        break;
    }
  } catch (err) {
    busy = false;
    post({ type: 'error', error: `${(err as Error).message}\n${(err as Error).stack ?? ''}` });
  }
});

loop();
