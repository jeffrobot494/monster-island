import { FX } from '../protocol';
import { hostNow, hostPost, hostSetTimeout } from './harden';
import { Island, type SavedWorld } from '../sim/island';
import { ENT_STRIDE, F_ANIMAL, F_BOUND, F_CHAMPION, F_CORE_SHAPE, F_CORPSE, F_DOWNED, F_DRAGGED, F_HITTABLE, F_HUMAN, F_INHABITANT, F_ITEM, F_MONSTER, F_SHAKE, F_TELEGRAPH, type Hud, type InspectInfo, type MainToSim, type MonsterCard, type NameInfo, type SimToMain, type VillagerInfo } from '../protocol';
import { TICKS_PER_SECOND, HOUR_MS, MS_PER_REAL_TICK, fmtClock } from '../sim/clock';
import type { Entity } from '../sim/types';
import { visibleMonsters, championSight } from '../sim/vision';
import { telegraphRadius, monsterActive, windupProgress, raiding, startRaid } from '../sim/monster-ai';
import { spearsOf, spearCap } from '../sim/spears';
import { crown, issueOrder, cs, ctrlReason, isPlayerCtrl, champSpeedMul } from '../sim/champion';
import { M as MPT } from '../sim/ground';
import { frontPoint } from '../sim/body';
import { shapeForJob } from '../sim/populate';
import { DAY_MS } from '../sim/clock';
import { offerDragged, offerLamb, offerVillager, offeringValue, nearAltar, judgment } from '../sim/favor';
import { kill, xpToNext, firstName } from '../sim/combat';
import { resolveAway } from '../sim/offline';
import { ARCH } from '../sim/monsters-gen';
import { REGION_NAMES } from '../sim/island-gen';
import { SIZE } from '../sim/world';

const post = (m: SimToMain, transfer?: Transferable[]) => hostPost(m, transfer);
// capture before hardening removes them
const listen = self.addEventListener.bind(self);
const realNow = Date.now.bind(Date);


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

let saveReason: string | null = null;

function sendDefs(force = false) {
  const sim = island!.sim;
  const key = `${sim.grid.defsVersion}:${sim.shapes.size}:${sim.emitters.size}`;
  if (!force && key === defsKey) return;
  defsKey = key;
  shapeIndex = [...sim.shapes.keys()];
  shapeLookup = new Map(shapeIndex.map((s, i) => [s, i]));
  post({ type: 'defs', shapes: [...sim.shapes], emitters: [...sim.emitters], tiles: [...sim.grid.defs.values()], shapeIndex });
}

const RANGE = 80; // tiles (640 m)
const CORE_ROLES = /^(house|village-altar|high-altar|fold|granary|lair:)/;
/** dev: put every living monster in the HUD (devShowMonsters) */
let showMonsters = false;
const prevPos = new Map<number, { x: number; z: number; v: number }>();
const sentNames = new Map<number, string>();

/** Where the viewer is: the champion, or the village while there is none. */
function eye(): { x: number; z: number } {
  const sim = island!.sim;
  const c = sim.champion();
  return c ? { x: c.x, z: c.z } : { x: sim.layout.village.x + 0.5, z: sim.layout.village.z + 0.5 };
}

function rendered(e: Entity, vis: Set<number>, ex: number, ez: number, sight: number): boolean {
  const sim = island!.sim;
  if (e.hidden) return false;
  if (e.kind === 'structure' && e.role && CORE_ROLES.test(e.role)) return false; // drawn as static geometry
  const d = Math.hypot(e.x - ex, e.z - ez);
  if (e.kind === 'monster' || e.unit) {
    if (sim.revealAll) return true;
    if (e.state === 'bound' || e.id === sim.dragging) return true;
    // a resting monster is inside its lair unless you're at the mouth (F11)
    if (e.state === 'rest' && d > 5) return false;
    return d <= sight * 1.25 || (sim.light > 0.5 && d <= RANGE) || (vis.has(e.id) && d <= RANGE && sim.light > 0.3);
  }
  return d <= RANGE;
}

function animOf(e: Entity, speed: number): number {
  const sim = island!.sim;
  if (e.kind === 'corpse') return 10;
  if (e.carriedBy !== undefined || e.state === 'captive') return 9;
  if (e.state === 'downed') return 7;
  if (e.state === 'bound') return 8;
  if (e.state === 'sleep') return 11;
  if (e.monster) {
    if (e.monster.windup >= 0) return 4;
    if (e.monster.strikeAt !== undefined && sim.tick - e.monster.strikeAt <= 3) return 5;
    if (e.state === 'feed') return 3;
  }
  if (e.state === 'flee' && speed > 0.05) return 6;
  if (speed > 0.075) return 2; // > 6 m/s
  if (speed > 0.012) return 1;
  if (e.state === 'work' || e.state === 'fight') return 3;
  return 0;
}

function zoneMask(e: Entity): number {
  if (!e.zones) return 0;
  const order = ['head', 'torso', 'armL', 'armR', 'legL', 'legR', 'sig'] as const;
  let m = 0;
  order.forEach((z, k) => {
    const st = e.zones![z]?.state;
    if (st === 'crippled') m |= 1 << k;
    if (st === 'severed') m |= (1 << k) | (1 << (8 + k));
  });
  return m;
}

function titleOf(e: Entity): NameInfo | null {
  if(e.unit) return {name:e.name ?? e.unit.type,title:'Dagon’s escort'};
  if (e.kind === 'human') {
    const job = e.human!.job;
    return { name: e.name ?? 'Villager', title: e.tags.includes('elder') ? `the elder · ${job}` : job };
  }
  if (e.kind === 'monster') {
    const M = e.monster!;
    return M.seen ? { name: e.name!, title: `${ARCH[M.archetype].display} · level ${e.level}` } : { name: 'Something', title: '???' };
  }
  if (e.kind === 'corpse' && e.corpse) {
    const sp = e.corpse.species;
    return { name: e.corpse.name ? `Body of ${e.corpse.name.split(' ')[0]}` : `Carcass of a ${ARCH[sp]?.display ?? sp}`, title: e.corpse.bones ? 'bones' : 'carcass' };
  }
  if (e.kind === 'animal') return { name: `Wild ${e.animal!.species}`, title: 'beast' };
  if (e.kind === 'spear') return { name: 'Spear', title: e.spear?.st === 'rack' ? 'in the village rack' : 'bronze-tipped' };

  return null;
}

function packEnts(): Float32Array {
  const sim = island!.sim;
  const vis = visibleMonsters(sim);
  const { x: ex, z: ez } = eye();
  const c = sim.champion();
  const sight = c ? championSight(sim, c) : 10;
  const list = [...sim.ents.values()].filter((e) => rendered(e, vis, ex, ez, sight));
  const arr = new Float32Array(list.length * ENT_STRIDE);
  const names: [number, NameInfo][] = [];
  let o = 0;
  for (const e of list) {
    let flags = 0;
    if (e.inhabitant) flags |= F_INHABITANT;
    if (e.kind === 'monster') flags |= F_MONSTER;
    if (e.kind === 'human') flags |= F_HUMAN;
    if (e.kind === 'animal') flags |= F_ANIMAL;
    if (e.kind === 'corpse') flags |= F_CORPSE;
    if (e.monster && e.monster.windup >= 0) flags |= F_TELEGRAPH;
    if (e.monster?.ride && e.monster.ride.shakeAt >= 0) flags |= F_SHAKE;
    if (e.state === 'downed') flags |= F_DOWNED;
    if (e.state === 'bound') flags |= F_BOUND;
    if (e.id === sim.championId) flags |= F_CHAMPION;
    if (e.id === sim.dragging) flags |= F_DRAGGED;
    if (e.tags.includes('hittable')) flags |= F_HITTABLE;
    if (e.kind === 'spear' && e.spear?.st !== 'flying') flags |= F_ITEM;
    const core = e.kind === 'monster' ? e.monster!.archetype : e.kind === 'human' ? shapeForJob(e.human!.job) : e.kind === 'animal' ? e.animal!.species : e.kind === 'corpse' ? e.corpse?.species === 'human' ? null : e.corpse?.species : null;
    if ((core && (e.shape === core || (core === 'guard' && e.shape === 'guard-bare'))) || (e.kind === 'corpse' && ['human', 'shepherd', 'guard', 'champion'].includes(e.shape)) || (e.kind === 'corpse' && e.shape === e.corpse?.species)) flags |= F_CORE_SHAPE;
    const pp = prevPos.get(e.id);
    const moved = pp ? Math.hypot(e.x - pp.x, e.z - pp.z) : 0;
    const v = pp ? pp.v * 0.5 + moved * 0.5 : 0;
    prevPos.set(e.id, { x: e.x, z: e.z, v });
    let y = sim.ground.y(e.x, e.z);
    if (e.monster?.flies && e.zones?.sig?.state === 'ok') {
      const t = sim.grid.get(Math.floor(e.x), Math.floor(e.z));
      y += Math.max(e.monster.alt ?? 0, t === 'wall' || t === 'house' ? 5 : 0);
    } else if (e.monster?.alt) y += e.monster.alt; // falling out of the sky
    if (e.human?.alt) y += e.human.alt; // a climber
    arr[o++] = e.id;
    arr[o++] = shapeLookup.get(e.shape) ?? -1;
    arr[o++] = e.x;
    arr[o++] = y;
    arr[o++] = e.z;
    arr[o++] = e.yaw;
    arr[o++] = parseInt(e.tint.slice(1), 16);
    arr[o++] = e.scale;
    arr[o++] = flags;
    arr[o++] = e.lift;
    arr[o++] = e.roll;
    arr[o++] = e.squash;
    arr[o++] = e.monster && e.monster.windup >= 0 ? telegraphRadius(e) * MPT : 0;
    arr[o++] = animOf(e, v);
    arr[o++] = zoneMask(e);
    arr[o++] = e.inhabitant ? Math.max(0, Math.min(1, e.hp / sim.maxHp(e))) : 1;
    arr[o++] = e.monster ? (e.monster.seen ? 1 : 0) : 1;
    arr[o++] = e.monster ? windupProgress(sim, e) : -1;
    arr[o++] = Math.max(0, FX.indexOf(e.fx?.at(-1)?.id ?? ''));
    const ni = titleOf(e);
    if (ni) {
      const key = ni.name + '|' + ni.title;
      if (sentNames.get(e.id) !== key) {
        sentNames.set(e.id, key);
        names.push([e.id, ni]);
      }
    }
  }
  if (sim.tick % 50 === 0) for (const id of prevPos.keys()) if (!sim.ents.has(id)) { prevPos.delete(id); sentNames.delete(id); }
  if (names.length) post({ type: 'names', names });
  return arr;
}

let costKey = '';
function sendWalkCost(force = false) {
  const sim = island!.sim;
  const c = sim.champion();
  const key = `${sim.grid.defsVersion}:${sim.rulesVersion}:${sim.tileEpoch}:${c ? Math.floor(c.x) + ',' + Math.floor(c.z) : ''}`;
  if (!force && key === costKey) return;
  costKey = key;
  post({ type: 'walkCost', cost: sim.champCost() });
}

function sendFullState() {
  const sim = island!.sim;
  sendDefs(true);
  sentNames.clear();
  prevPos.clear();
  const ents = packEnts();
  post({ type: 'fullState', seq: ++seq, tick: sim.tick, tiles: [...sim.grid.types], elev: sim.grid.elev.slice(), explored: sim.explored.slice(), ents, attached: [...sim.attached].map(([id, s]) => [id, [...s]]), atmosphere: { ...sim.atmosphere }, layout: sim.layout, epoch: cs(sim).epoch, walkCost: sim.champCost(),
    terrain: sim.terrain && sim.grid.base && sim.grid.orig ? { settings: sim.terrain, base: sim.grid.base.slice(), orig: sim.grid.orig.slice() } : null }, [ents.buffer]);
  sim.grid.changed.clear();
  sim.exploredChanged.length = 0;
  flushOut();
  sendHud();
  sendVillagers();
}

function save(reason: string) {
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
      speedMul: champSpeedMul(sim), blocking: cs(sim).blocking, torch: cs(sim).torch, sight: championSight(sim, c),
      spears: spearsOf(c), spearCap: spearCap(sim, c), wield: cs(sim).wield,
    } : null,
    championPendingDawn: sim.championPendingDawn,
    favor: { human: Math.round(sim.favor.human), monster: Math.round(sim.favor.monster) },
    food: sim.food, foodCap: sim.foodCap, fold: sim.fold,
    pop: sim.humans().filter((h) => h.id !== sim.championId).length,
    monstersAlive: sim.monsters().length,
    alarm: sim.alarmUntil > sim.tick,
    raid: raiding(sim),
    events: sim.director.list(),
    eventHistory: sim.events.history.map(h => ({...h, title: sim.director.definition(h.def).title})),
    gameOver: sim.gameOver,
    stats: sim.stats,
    dangerNear,
    judgmentInMs: sim.director.realMsUntil(Math.floor(sim.clockMs / DAY_MS) * DAY_MS + DAY_MS),
    lairsHome: sim.monsters().filter((m) => m.state === 'rest' && sim.byRole(`lair:${m.monster!.region}`)?.tags.includes('found')).map((m) => m.monster!.region),
    devMonsters: showMonsters ? sim.monsters().map((m) => {
      const t = m.target >= 0 ? sim.ents.get(m.target) : undefined;
      return { id: m.id, name: firstName(m), x: m.x, z: m.z, state: m.state, target: t ? (t.id === sim.championId ? 'you' : firstName(t)) : null };
    }) : undefined,
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
    if (m?.name) r.name = m.name;
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
  const S = cs(sim);
  const c = sim.champion();
  const { x: ex, z: ez } = eye();
  const screams: { id: number; x: number; z: number }[] = [];
  for (const h of sim.ents.values()) {
    if (h.kind !== 'human' || h.state !== 'captive' || h.id === sim.championId || h.carriedBy === undefined) continue;
    if (Math.hypot(h.x - ex, h.z - ez) <= 19) screams.push({ id: h.carriedBy, x: h.x, z: h.z });
  }
  if (sim.tick % 6 === 0) {
    // footfalls of monsters close to you (F20)
    for (const m of sim.monsters()) {
      const d = Math.hypot(m.x - ex, m.z - ez);
      if (d < 30 / MPT && (prevPos.get(m.id)?.v ?? 0) > 0.01 && (m.id + sim.tick) % 12 === 0) out.sounds.push({ kind: 'thud', x: m.x, z: m.z, size: m.scale });
    }
  }
  const hear = { roar: 50, scream: 19 } as Record<string, number>;
  const sounds = out.sounds.filter((snd) => Math.hypot(snd.x - ex, snd.z - ez) <= (hear[snd.kind] ?? 15));
  const reason = ctrlReason(sim);
  const actionError = sim.actionError;
  sim.actionError = null;
  post({
    type: 'frame', seq: ++seq, tick: sim.tick, ents, tiles, explored, emitterOps: out.emitterOps, emotes: out.emotes, atmosphere: out.atmosphereDirty ? { ...sim.atmosphere } : undefined,
    ctrl: isPlayerCtrl(reason) ? 'player' : 'sim', ctrlReason: reason, epoch: S.epoch, champ: c ? { x: c.x, z: c.z, yaw: c.yaw, ...(c.human?.alt ? { alt: c.human.alt } : {}) } : null,
    correction: S.correction ?? undefined, screams, sounds, combat: S.combat.splice(0), toasts: out.toasts, hurt: out.hurt ?? 0, actionError,
  }, [ents.buffer]);
  S.correction = null;
  sendWalkCost();
  if (sim.tick % 5 === 0) sendHud();
  if (sim.tick % 5 === 0 && inspectId !== null) sendInspect();
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
    if (e.state === 'downed') lines.push('Downed! E to bind it, F to finish it.');
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
    lines.push('Bring offerings here. Press E beside it.');
  } else if (e.role === 'high-altar') {
    title = 'The High Place';
    lines.push("Dagon's altar. The monsters bring their captives here.");
  } else if (e.kind === 'animal') {
    title = `Wild ${e.animal!.species}`;
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

/** Catch up a gap (R1): short gaps tick by tick, long gaps through the resolver. */
function catchUp(clockNow: number, realMs: number) {
  const sim = island!.sim;
  if (sim.gameOver) return;
  const realGap = sim.lastRealMs ? Math.max(0, realMs - sim.lastRealMs) : 0;
  // on a fast clock a long absence would span weeks of game days (and a judgment each): resolve at most one day
  const gapClock = Math.min(realGap * sim.timescale, DAY_MS);
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
          island = await Island.load(world);
          // the game speed is the client's to set: older saves ran on the real clock
          island.sim.timescale = msg.timescale;
          island.sim.msPerTick = MS_PER_REAL_TICK * msg.timescale;
        } else {
          island = Island.create(msg.seed, msg.clockMs, msg.timescale, msg.terrain ?? null);
          island.sim.lastRealMs = msg.realMs;
        }
        island.sim.revealAll = !!msg.reveal;
        island.sim.invincible = !!msg.invincible;
        if (msg.reveal) island.sim.explored.fill(1);
        for (let i = 0; i < (msg.skip ?? 0); i++) island.step();
        busy = false;
        if (msg.save) catchUp(msg.clockMs, msg.realMs);
        sendFullState();
        if (!msg.save) save('init');
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
      case 'input':
        if (island) island.sim.inputs.push(msg.input);
        break;
      case 'action': {
        if (!island) break;
        const sim = island.sim;
        const a = msg.action;
        let err: string | null = null;
        if (a.kind === 'offerLamb') err = offerLamb(sim);
        else if (a.kind === 'offerDragged') err = offerDragged(sim);
        else if (a.kind === 'offerVillager') err = offerVillager(sim, a.id);
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
      case 'devShowMonsters': {
        showMonsters = msg.on;
        sendHud();
        break;
      }
      case 'devRaid': {
        startRaid(island!.sim);
        flushOut();
        sendHud();
        break;
      }
      case 'devEvent': {
        const sim = island!.sim;
        if (msg.op === 'fire' && msg.id) sim.director.fire(msg.id);
        if (msg.op === 'end' && msg.iid !== undefined) sim.director.end(msg.iid);
        flushOut(); sendHud(); save('dev-event');
        break;
      }
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
        cs(sim).epoch++;
        if (msg.name.startsWith('place:')) {
          const [x, z] = msg.name.slice(6).split(',').map(Number);
          if (Number.isFinite(x) && Number.isFinite(z)) {
            const p = sim.nearestWalkable(c, x, z, 6);
            if (p) { c.x = p.x + 0.5; c.z = p.z + 0.5; }
            sim.stop(c);
          }
        } else if (msg.name === 'fight' || msg.name === 'downed' || msg.name === 'drag') {
          put(c, m.x + 1.6, m.z + 0.6);
          c.yaw = Math.atan2(m.x - c.x, m.z - c.z);
          m.yaw = Math.atan2(c.x - m.x, c.z - m.z);
          if (msg.name === 'fight') {
            m.target = c.id;
            m.state = 'fight';
            m.monster!.seen = true;
          } else {
            m.hp = sim.maxHp(m) * 0.15;
            m.state = 'downed';
            m.roll = 1;
            m.monster!.downedAt = sim.tick;
            if (msg.name === 'drag') {
              m.state = 'bound';
              sim.dragging = m.id;
            }
          }
        } else if (/^(nephil|ziz|saraph)(-downed)?$/.test(msg.name)) {
          // climbing on (docs/climbing-phase3-plan.md, phase 4 for the flyers): the nearest one a tile ahead, landed,
          // standing still and leaving you be, or down
          const arch = msg.name.replace('-downed', '');
          const n = sim.monsters().filter((e) => e.monster!.archetype === arch).sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
          if (n) {
            put(n, c.x + Math.sin(c.yaw) * 1.2, c.z + Math.cos(c.yaw) * 1.2);
            n.yaw = Math.atan2(c.x - n.x, c.z - n.z);
            sim.toast(`${n.name} is ${(Math.hypot(n.x - c.x, n.z - c.z) * 8).toFixed(1)} m ahead.`);
            n.target = -1;
            n.monster!.ignoreChampUntil = sim.clockMs + 3_600_000;
            n.monster!.alt = 0;
            if (!msg.name.endsWith('-downed')) {
              // feeding: it stays put, landed (a flyer at rest by day takes off on its rounds)
              n.state = 'feed';
              n.stateUntil = sim.tick + 36_000;
            }
            else {
              n.hp = sim.maxHp(n) * 0.15;
              n.state = 'downed';
              n.roll = 1;
              n.monster!.downedAt = sim.tick;
            }
          } else sim.toast(`No ${arch} on this island.`);
        } else if (msg.name === 'carry') {
          const v = sim.humans().find((h) => h.id !== c.id && !h.hidden)!;
          put(v, c.x + 3, c.z + 1.5);
          put(m, v.x + 0.5, v.z);
          m.monster!.prey = v.id;
          m.monster!.huntUntil = sim.clockMs + 3_600_000;
          m.state = 'stalk';
        }
        sendFullState();
        break;
      }
      case 'devCrown': {
        // crown the next champion now instead of waiting for dawn
        const sim = island!.sim;
        if (!sim.championPendingDawn) sim.toast('Your champion is still alive.');
        else {
          crown(sim);
          if (sim.championPendingDawn) sim.toast('No villager is free to take up the sword.');
        }
        flushOut();
        sendFullState();
        sendHud();
        save('dev-crown');
        break;
      }
      case 'devKillChampion': {
        const sim = island!.sim;
        const c = sim.champion();
        if (c) kill(sim, c, { amount: c.hp, type: 'dev', sourceId: -1, sourceKind: 'none' });
        flushOut();
        sendFullState();
        sendHud();
        save('dev-kill');
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
