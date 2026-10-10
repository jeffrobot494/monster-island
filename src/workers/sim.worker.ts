import { harden, hostCreateBlobUrl, hostNow, hostPost, hostRevokeUrl, hostSetTimeout } from './harden';
import { Island, importDefault, type SavedWorld } from '../sim/island';
import { ENT_STRIDE, F_BOUND, F_CHAMPION, F_DOWNED, F_DRAGGED, F_INHABITANT, F_MONSTER, F_TELEGRAPH, type Hud, type InspectInfo, type MainToSim, type ModuleStat, type MonsterCard, type SimToMain, type VillagerInfo } from '../protocol';
import type { FaultInfo, VisibleEffect } from '../sim/module-runtime';
import { TICKS_PER_SECOND, HOUR_MS, fmtClock } from '../sim/clock';
import type { Entity } from '../sim/types';
import { visibleMonsters } from '../sim/vision';
import { telegraphRadius, monsterActive } from '../sim/monster-ai';
import { issueOrder, cs } from '../sim/champion';
import { offerDragged, offerLamb, offerVillager, offeringValue, setPrayer, nearAltar, judgment } from '../sim/favor';
import { xpToNext, firstName } from '../sim/combat';
import { resolveAway } from '../sim/offline';
import { ARCH } from '../sim/monsters-gen';
import { REGION_NAMES } from '../sim/island-gen';
import { SIZE } from '../sim/world';

const post = (m: SimToMain, transfer?: Transferable[]) => hostPost(m, transfer);
// capture before hardening removes them
const listen = self.addEventListener.bind(self);
const realNow = Date.now.bind(Date);
harden();

let island: Island | null = null;
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
    saveReason = 'quarantine';
  },
  onVisible: (id: string, v: VisibleEffect) => post({ type: 'visible', id, x: v.x, z: v.z, what: v.what }),
};

let saveReason: string | null = null;

function sendDefs(force = false) {
  const sim = island!.sim;
  const key = `${sim.defsVersion}:${sim.grid.defsVersion}:${sim.shapes.size}:${sim.emitters.size}`;
  if (!force && key === defsKey) return;
  defsKey = key;
  shapeIndex = [...sim.shapes.keys()];
  shapeLookup = new Map(shapeIndex.map((s, i) => [s, i]));
  post({ type: 'defs', shapes: [...sim.shapes], emitters: [...sim.emitters], tiles: [...sim.grid.defs.values()], shapeIndex });
}

function rendered(e: Entity, vis: Set<number>): boolean {
  const sim = island!.sim;
  if (e.hidden) return false;
  if (e.kind === 'human') return true;
  if (e.kind === 'monster') return vis.has(e.id) || e.state === 'bound' || sim.revealAll;
  const i = Math.floor(e.z) * SIZE + Math.floor(e.x);
  if (!sim.explored[i] && !sim.revealAll) return false;
  if (e.role?.startsWith('lair:') && !e.tags.includes('found') && !sim.revealAll) return false;
  return true;
}

function packEnts(): Float32Array {
  const sim = island!.sim;
  const vis = visibleMonsters(sim);
  const list = [...sim.ents.values()].filter((e) => rendered(e, vis));
  const arr = new Float32Array(list.length * ENT_STRIDE);
  let o = 0;
  for (const e of list) {
    const tx = Math.floor(e.x), tz = Math.floor(e.z);
    let flags = 0;
    if (e.inhabitant) flags |= F_INHABITANT;
    if (e.kind === 'monster') flags |= F_MONSTER;
    if (e.monster && e.monster.windup >= 0) flags |= F_TELEGRAPH;
    if (e.state === 'downed') flags |= F_DOWNED;
    if (e.state === 'bound') flags |= F_BOUND;
    if (e.id === sim.championId) flags |= F_CHAMPION;
    if (e.id === sim.dragging) flags |= F_DRAGGED;
    arr[o++] = e.id;
    arr[o++] = shapeLookup.get(e.shape) ?? -1;
    arr[o++] = e.x;
    arr[o++] = sim.grid.height(tx, tz);
    arr[o++] = e.z;
    arr[o++] = e.yaw;
    arr[o++] = parseInt(e.tint.slice(1), 16);
    arr[o++] = e.scale;
    arr[o++] = flags;
    arr[o++] = e.lift;
    arr[o++] = e.roll;
    arr[o++] = e.squash;
    arr[o++] = e.monster && e.monster.windup >= 0 ? telegraphRadius(e) : 0;
  }
  return arr;
}

function sendFullState() {
  const sim = island!.sim;
  sendDefs(true);
  const ents = packEnts();
  post({ type: 'fullState', seq: ++seq, tick: sim.tick, tiles: [...sim.grid.types], elev: sim.grid.elev.slice(), explored: sim.explored.slice(), ents, attached: [...sim.attached].map(([id, s]) => [id, [...s]]), atmosphere: { ...sim.atmosphere } }, [ents.buffer]);
  sim.grid.changed.clear();
  sim.exploredChanged.length = 0;
  flushOut();
  sendHud();
  sendVillagers();
}

function save(reason: string) {
  island!.runtime.enforceStateCaps();
  island!.sim.lastRealMs = realNow();
  post({ type: 'save', world: JSON.stringify(island!.serialize()), tick: island!.sim.tick, reason });
}

function flushOut() {
  const out = island!.sim.drainOut();
  if (out.events.length) post({ type: 'events', events: out.events });
  if (out.alerts.length) post({ type: 'alerts', alerts: out.alerts });
  return out;
}

function sendHud() {
  const sim = island!.sim;
  const c = sim.champion();
  let dragging: NonNullable<Hud['champion']>['dragging'] = null;
  const d = sim.ents.get(sim.dragging);
  if (d) dragging = { name: d.name ?? d.corpse?.species ?? d.kind, value: offeringValue(sim, d), kind: d.kind };
  let downedTarget: { id: number; name: string } | null = null;
  if (c) for (const m of sim.monsters()) if (m.state === 'downed' && Math.hypot(m.x - c.x, m.z - c.z) < 2.5) downedTarget = { id: m.id, name: firstName(m) };
  let dangerNear = false;
  if (c) for (const m of sim.monsters()) if (m.state !== 'downed' && m.state !== 'bound' && Math.hypot(m.x - c.x, m.z - c.z) < 15) dangerNear = true;
  const hud: Hud = {
    tick: sim.tick, clockMs: sim.clockMs, day: sim.day, hour: sim.hour, light: sim.light, timescale: sim.timescale,
    champion: c ? {
      id: c.id, name: c.name!, hp: c.hp, maxHp: sim.maxHp(c), level: c.level, xp: c.xp, xpNext: xpToNext(c), state: c.state, x: c.x, z: c.z,
      dragging, nearAltar: nearAltar(sim), downedTarget, weaponMul: cs(sim).weapon.mul,
    } : null,
    championPendingDawn: sim.championPendingDawn,
    favor: { human: Math.round(sim.favor.human), monster: Math.round(sim.favor.monster) },
    food: sim.food, foodCap: sim.foodCap, fold: sim.fold,
    pop: sim.humans().filter((h) => h.id !== sim.championId).length,
    monstersAlive: sim.monsters().length,
    alarm: sim.alarmUntil > sim.tick,
    prayer: sim.prayer,
    pendingCreations: sim.pendingCreations,
    creations: sim.creations,
    domainHistory: sim.domainHistory,
    missingSystems: sim.missingSystems,
    gameOver: sim.gameOver,
    stats: sim.stats,
    dangerNear,
  };
  post({ type: 'hud', hud });
}

let monsterRoster: { id: number; name: string; archetype: string; region: number }[] = [];

function sendVillagers() {
  const sim = island!.sim;
  const V = sim.layout.village;
  const villagers: VillagerInfo[] = sim.humans().filter((h) => h.id !== sim.championId).map((h) => ({
    id: h.id, name: h.name!, job: h.human!.job, nextJob: h.human!.nextJob, shift: h.human!.shift, level: h.level, hp: h.hp, maxHp: sim.maxHp(h),
    state: h.state, bio: h.human!.bio, elder: h.tags.includes('elder'), inVillage: Math.hypot(h.x - V.x, h.z - V.z) < sim.layout.wallRadius + 1,
  }));
  if (!monsterRoster.length) monsterRoster = sim.monsters().map((m) => ({ id: m.id, name: m.name!, archetype: m.monster!.archetype, region: m.monster!.region }));
  const monsters: MonsterCard[] = monsterRoster.map((r) => {
    const m = sim.ents.get(r.id);
    const lair = sim.byRole(`lair:${r.region}`);
    const alive = !!m && m.kind === 'monster';
    const M = alive ? m!.monster! : null;
    return {
      id: r.id, name: M?.seen || !alive ? r.name : 'Unknown', archetype: r.archetype, display: M?.seen || !alive ? ARCH[r.archetype].display : '???',
      region: REGION_NAMES[r.region], lairFound: !!lair?.tags.includes('found'), seen: !!M?.seen || !alive,
      level: M?.seen ? m!.level : null, hp: M?.seen && visibleMonsters(sim).has(r.id) ? Math.round(m!.hp) : null, maxHp: M?.seen ? Math.round(sim.maxHp(m!)) : null,
      seenHours: M ? [...M.seenHours].sort((a, b) => a - b) : [], enraged: !!M && M.enragedUntil > sim.clockMs,
      special: ARCH[r.archetype].special, dead: !alive,
    };
  });
  post({ type: 'villagers', villagers, monsters });
}

function tickOnce() {
  const sim = island!.sim;
  island!.step();
  sim.lastRealMs = realNow();
  sendDefs();
  const out = flushOut();
  const tiles = sim.grid.drainChanged().map((i) => [i, sim.grid.types[i]] as [number, string]);
  const explored = sim.exploredChanged.splice(0);
  const ents = packEnts();
  post({ type: 'frame', seq: ++seq, tick: sim.tick, ents, tiles, explored, emitterOps: out.emitterOps, emotes: out.emotes, atmosphere: out.atmosphereDirty ? { ...sim.atmosphere } : undefined }, [ents.buffer]);
  if (sim.tick % 5 === 0) sendHud();
  if (sim.tick % 5 === 0 && inspectId !== null) sendInspect();
  if (sim.tick % 30 === 0) sendStats();
  if (sim.tick % 25 === 0) sendVillagers();
  if (sim.tick % 300 === 0) saveReason ??= 'autosave';
  if (saveReason) {
    const r = saveReason;
    saveReason = null;
    save(r);
  }
}

function inspectLines(e: Entity): InspectInfo {
  const sim = island!.sim;
  const lines: string[] = [];
  let title = e.name ?? e.kind;
  if (e.kind === 'human') {
    const H = e.human!;
    title = e.name!;
    lines.push(`${e.id === sim.championId ? 'Champion' : H.job[0].toUpperCase() + H.job.slice(1)} · level ${e.level} · ${H.shift} shift`);
    lines.push(H.bio);
    lines.push(`Now: ${e.state}`);
    const hurt = Object.entries(e.zones ?? {}).filter(([, z]) => z && z.state !== 'ok').map(([k, z]) => `${k} ${z!.state}`);
    if (hurt.length) lines.push(`Wounds: ${hurt.join(', ')}`);
  } else if (e.kind === 'monster') {
    const M = e.monster!;
    title = e.name!;
    lines.push(`${ARCH[M.archetype].display} · level ${e.level}${M.enragedUntil > sim.clockMs ? ' · ENRAGED' : ''}`);
    lines.push(ARCH[M.archetype].special);
    lines.push(`Now: ${e.state}${monsterActive(sim, e) ? ' (active hours)' : ''}`);
    if (M.seenHours.length) lines.push(`Seen active at: ${[...M.seenHours].sort((a, b) => a - b).map((h) => `${h}:00`).join(', ')}`);
    const hurt = Object.entries(e.zones ?? {}).filter(([, z]) => z && z.state !== 'ok').map(([k, z]) => `${k === 'sig' ? ARCH[M.archetype].sig : k} ${z!.state}`);
    if (hurt.length) lines.push(`Wounds: ${hurt.join(', ')}`);
    if (e.state === 'downed') lines.push('Downed! Tap to bind it, or Finish it.');
    if (e.state === 'bound') lines.push(`Bound. Worth ${offeringValue(sim, e)} favor alive at the altar.`);
  } else if (e.kind === 'corpse' && e.corpse) {
    title = e.corpse.name ? `Body of ${e.corpse.name}` : `Carcass (${e.corpse.species})`;
    const v = offeringValue(sim, e);
    lines.push(e.corpse.bones ? 'Bones. Worthless on the altar.' : `${e.corpse.deathType}. Worth ${v} favor as a burnt offering today.`);
    if (e.corpse.species === 'human' && !e.corpse.bones) lines.push('Offering a villager is forbidden.');
  } else if (e.role?.startsWith('lair:')) {
    const r = e.region ?? 0;
    title = REGION_NAMES[r] + ' lair';
    lines.push(e.tags.includes('empty') ? 'Empty. Its master is dead.' : 'Something lives here.');
  } else if (e.role === 'village-altar') {
    title = 'Altar of the Most High';
    lines.push('Bring offerings here. Tap again when close to open it.');
  } else if (e.role === 'high-altar') {
    title = 'The High Place';
    lines.push("Dagon's altar. The monsters bring their captives here.");
  } else if (e.kind === 'animal') {
    title = `Wild ${e.animal!.species}`;
  } else if (e.owner) {
    const m = island!.manifest.find((x) => x.id === e.owner);
    title = e.kind;
    if (m) lines.push(`A creation: ${m.title}`);
  }
  return { id: e.id, name: e.name, kind: e.kind, title, lines, hp: e.inhabitant ? e.hp : undefined, maxHp: e.inhabitant ? sim.maxHp(e) : undefined };
}

function sendInspect() {
  const sim = island!.sim;
  const e = inspectId === null ? undefined : sim.ents.get(inspectId);
  if (!e) {
    post({ type: 'inspect', info: null });
    inspectId = null;
    return;
  }
  post({ type: 'inspect', info: inspectLines(e) });
}

function sendStats() {
  const stats: ModuleStat[] = island!.runtime.mods.map((m) => {
    const s = { id: m.id, status: m.status, faultsToday: m.faultDay === island!.sim.day ? m.faultCount : 0, msPerTick: m.timeMs / 30 };
    m.timeMs = 0;
    return s;
  });
  post({ type: 'moduleStats', stats });
}

/** Catch up a gap (R1): short gaps tick by tick, long gaps through the resolver. */
function catchUp(clockNow: number, realMs: number) {
  const sim = island!.sim;
  if (sim.gameOver) return;
  const realGap = sim.lastRealMs ? Math.max(0, realMs - sim.lastRealMs) : 0;
  const gapClock = realGap * sim.timescale;
  void clockNow;
  if (gapClock <= sim.msPerTick * 2) return; // negative drift: the clock simply holds (R2)
  const ticks = Math.floor(gapClock / sim.msPerTick);
  if (ticks <= 600) {
    for (let i = 0; i < ticks; i++) island!.step();
    sim.lastRealMs = realMs;
    flushOut();
    sendFullState();
    return;
  }
  island!.runtime.schedules = [];
  const summary = resolveAway(sim, gapClock, realGap || gapClock / sim.timescale);
  sim.lastRealMs = realMs;
  post({ type: 'away', summary });
  sendFullState();
  save('catch-up');
}

function loop() {
  const now = hostNow();
  const dt = Math.min(500, now - lastLoop);
  lastLoop = now;
  if (island && !paused && !busy) {
    acc += (dt / 1000) * TICKS_PER_SECOND;
    let n = 0;
    while (acc >= 1 && n < 4) {
      acc -= 1;
      n++;
      tickOnce();
    }
    if (acc > 4) acc = 0;
  }
  hostSetTimeout(loop, 1000 / TICKS_PER_SECOND / 2);
}

listen('message', async (ev: MessageEvent<MainToSim>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        busy = true;
        paused = false;
        if (msg.save) {
          const world = JSON.parse(msg.save) as SavedWorld;
          const sources = Object.fromEntries(msg.modules.map((m) => [m.id, m.source]));
          island = await Island.load(world, sources, loader, runtimeOpts, msg.quarantine ?? []);
        } else {
          island = Island.create(msg.seed, msg.clockMs, msg.timescale, runtimeOpts);
          island.sim.lastRealMs = msg.realMs;
        }
        island.sim.revealAll = !!msg.reveal;
        island.sim.invincible = !!msg.invincible;
        if (msg.reveal) island.sim.explored.fill(1);
        for (let i = 0; i < (msg.skip ?? 0); i++) island.step();
        busy = false;
        if (msg.save) catchUp(msg.clockMs, msg.realMs);
        sendFullState();
        if (msg.quarantine?.length || !msg.save) save('init');
        lastLoop = hostNow();
        break;
      }
      case 'control':
        paused = msg.paused;
        if (paused && island) save('paused');
        break;
      case 'catchUp':
        if (island && !busy) catchUp(msg.clockMs, msg.realMs);
        break;
      case 'order':
        if (island) issueOrder(island.sim, msg.order);
        break;
      case 'action': {
        if (!island) break;
        const sim = island.sim;
        const a = msg.action;
        let err: string | null = null;
        if (a.kind === 'offerLamb') err = offerLamb(sim);
        else if (a.kind === 'offerDragged') err = offerDragged(sim);
        else if (a.kind === 'offerVillager') err = offerVillager(sim, a.id);
        else if (a.kind === 'pray') setPrayer(sim, a.text);
        else if (a.kind === 'setJob') {
          const v = sim.ents.get(a.id);
          if (v?.human && v.id !== sim.championId) v.human.nextJob = a.job === v.human.job ? undefined : a.job;
        }
        post({ type: 'actionResult', error: err });
        flushOut();
        sendHud();
        sendVillagers();
        saveReason = 'action';
        break;
      }
      case 'install': {
        busy = true;
        const sim = island!.sim;
        try {
          const def = await loader(msg.id, msg.source);
          island!.install(msg.id, def);
          sim.creations.push(msg.record);
          sim.domainHistory[msg.record.god].push({ night: msg.night, domain: msg.record.domain });
          if (msg.record.domain === 'fundamental') {
            const hit = sim.missingSystems.find((s) => msg.record.title.toLowerCase().includes(s.split(' ')[0].toLowerCase()));
            sim.missingSystems = sim.missingSystems.filter((s) => s !== hit);
          }
          sim.pendingCreations = sim.pendingCreations.filter((r) => r.night !== msg.night);
          sim.log(msg.record.announcement, 3, 'god', 'creation');
          post({ type: 'installed', id: msg.id, ok: true });
          sendDefs(true);
          save('creation');
        } catch (err) {
          post({ type: 'installed', id: msg.id, ok: false, error: (err as Error).message });
        } finally {
          busy = false;
        }
        sendHud();
        break;
      }
      case 'creationFailed': {
        const sim = island!.sim;
        sim.pendingCreations = sim.pendingCreations.filter((r) => r.night !== msg.night);
        sendHud();
        save('creation-failed');
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
      case 'devJudge': {
        const sim = island!.sim;
        sim.favor = { human: msg.human, monster: msg.monster };
        sim.nightIndex++;
        judgment(sim);
        flushOut();
        sendHud();
        save('dev-judge');
        break;
      }
      case 'devScenario': {
        const sim = island!.sim;
        const c = sim.champion();
        if (!c) break;
        const ms = sim.monsters().filter((m) => m.monster!.region !== 6).sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
        const m = ms[0];
        const put = (e: Entity, x: number, z: number) => {
          const p = sim.nearestWalkable(e, x, z, 4);
          if (p) { e.x = p.x + 0.5; e.z = p.z + 0.5; }
          sim.stop(e);
        };
        if (msg.name === 'fight' || msg.name === 'downed' || msg.name === 'drag') {
          put(c, m.x + 2.5, m.z + 1);
          if (msg.name === 'fight') issueOrder(sim, { type: 'attack', id: m.id });
          else {
            m.hp = sim.maxHp(m) * 0.15;
            m.state = 'downed';
            m.roll = 1;
            m.monster!.downedAt = sim.tick;
            if (msg.name === 'drag') {
              m.state = 'bound';
              sim.dragging = m.id;
              const A = sim.layout.villageAltar;
              issueOrder(sim, { type: 'move', x: A.x + 0.5, z: A.z + 1.5 });
            }
          }
        } else if (msg.name === 'carry') {
          const v = sim.humans().find((h) => h.id !== c.id && !h.hidden)!;
          put(v, c.x + 6, c.z + 3);
          put(m, v.x + 1, v.z);
          m.monster!.prey = v.id;
          m.monster!.huntUntil = sim.clockMs + 3_600_000;
          m.state = 'stalk';
        }
        sendFullState();
        break;
      }
      case 'devSkipHours': {
        const sim = island!.sim;
        const summary = resolveAway(sim, msg.hours * HOUR_MS, msg.hours * HOUR_MS);
        post({ type: 'away', summary });
        sendFullState();
        break;
      }
    }
  } catch (err) {
    busy = false;
    post({ type: 'error', error: `${(err as Error).message}\n${(err as Error).stack ?? ''}` });
  }
});

void fmtClock;
loop();
