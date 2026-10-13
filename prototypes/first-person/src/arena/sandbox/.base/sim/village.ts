// Village sim (§5): shifts, work sites and drift, food, sleep, flight, guards, the shofar, growth.
import { dropSpears, guardFetch, guardThrow, setSpears, spearsOf } from './spears';
import { axisDist, bodyR } from './body';
import type { Sim } from './sim';
import type { Entity, Job } from './types';
import { DAY_MS, HOUR_MS, inWindow } from './clock';
import { SIZE } from './world';
import { applyDamage, armFactor, gainXp, heal, legFactor, setDowned } from './combat';
import { spawnAnimal, spawnHuman } from './populate';
import { calDay } from './clock';

export const PRODUCTION: Record<Job, number> = { champion: 0, shepherd: 1, vinedresser: 1, woodcutter: 0, fisherman: 1.5, farmer: 2, guard: 0 };
const SITE_TILES: Partial<Record<Job, string[]>> = {
  shepherd: ['grass', 'scrub'], vinedresser: ['olive', 'vineyard'], woodcutter: ['cedar'], fisherman: ['sand'], farmer: ['wheat'],
};
export const POP_CAP = 40;
/** villagers notice and run from monsters within their (light-dependent) sight */
const fleeR = (sim: Sim) => 5 + 3 * sim.light;

/** transient site lists per job (rebuilt when tiles change) */
const siteCache = new WeakMap<Sim, { key: number; lists: Map<Job, number[]> }>();

function siteList(sim: Sim, job: Job): number[] {
  let c = siteCache.get(sim);
  const key = sim.grid.defsVersion * 7919 + (sim as any).tileEpoch;
  if (!c || c.key !== key) siteCache.set(sim, (c = { key, lists: new Map() }));
  let list = c.lists.get(job);
  if (list) return list;
  list = [];
  const types = SITE_TILES[job] ?? [];
  const L = sim.layout;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const t = sim.grid.types[i];
    if (!types.includes(t)) continue;
    const x = i % SIZE, z = (i / SIZE) | 0;
    if (Math.hypot(x - L.village.x, z - L.village.z) < L.wallRadius + 1.5) continue;
    if (job === 'fisherman') {
      let wet = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (sim.grid.get(x + dx, z + dz).endsWith('water')) wet = true;
      if (!wet) continue;
    }
    list.push(i);
  }
  c.lists.set(job, list);
  return list;
}

export function onShift(sim: Sim, e: Entity): boolean {
  const h = sim.hour;
  return e.human!.shift === 'day' ? inWindow(h, 6, 18) : inWindow(h, 18, 6);
}

export function humanSpeed(sim: Sim, e: Entity): number {
  let s = sim.stat(e, 'speed') * legFactor(e);
  if (e.state === 'flee') s *= 1.4;
  return s;
}

/** Pick the nearest work tile that still has stock (sites near the village run out first → drift outward). */
export function pickSite(sim: Sim, e: Entity): number {
  const job = e.human!.job;
  if (job === 'guard') {
    const guards = sim.humans().filter((h) => h.human!.job === 'guard').sort((a, b) => a.id - b.id);
    const k = Math.max(0, guards.indexOf(e)) % sim.layout.guardPosts.length;
    const p = sim.layout.guardPosts[k];
    return sim.grid.idx(p.x, p.z);
  }
  const list = siteList(sim, job);
  if (!list.length) return -1;
  const occ = new Map<number, number>();
  for (const h of sim.ents.values()) if (h.human && h !== e && h.human.site >= 0) occ.set(h.human.site, (occ.get(h.human.site) ?? 0) + 1);
  const V = sim.layout.village;
  let best = -1, bd = Infinity;
  for (let k = 0; k < Math.min(400, list.length); k++) {
    const i = list.length <= 400 ? list[k] : list[sim.rng.int(0, list.length - 1)];
    if (sim.stock[i] < 0.34 || (occ.get(i) ?? 0) >= 2) continue;
    const d = Math.hypot((i % SIZE) - V.x, ((i / SIZE) | 0) - V.z) + sim.rng.next() * 4;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function nearestThreat(sim: Sim, e: Entity, r: number): Entity | null {
  let best: Entity | null = null, bd = r;
  for (const m of sim.ents.values()) {
    if (m.kind !== 'monster' || m.state === 'downed' || m.state === 'bound') continue;
    const d = Math.hypot(m.x - e.x, m.z - e.z);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

function home(sim: Sim, e: Entity): Entity | undefined {
  return sim.ents.get(e.human!.homeId);
}

/** The walkable spot in front of a house's door (F24); houses themselves are solid tiles. */
export function doorOf(sim: Sim, h: { x: number; z: number }): { x: number; z: number } {
  const L = sim.layout;
  const hx = Math.floor(h.x), hz = Math.floor(h.z);
  const k = L.houses.findIndex((p) => p.x === hx && p.z === hz);
  const d = k >= 0 && L.doors ? L.doors[k] : { x: hx, z: hz + 1 };
  return { x: d.x + 0.5, z: d.z + 0.5 };
}

/** Where a villager walks to get home. */
function homeDoor(sim: Sim, e: Entity): { x: number; z: number } | undefined {
  const h = home(sim, e);
  return h ? doorOf(sim, h) : undefined;
}

function enterHouse(sim: Sim, e: Entity, state: 'sleep' | 'hide') {
  const h = home(sim, e);
  if (h) { e.x = h.x; e.z = h.z; }
  sim.stop(e);
  e.hidden = true;
  e.state = state;
  if (h) updateHouseLight(sim, h);
}

function leaveHouse(sim: Sim, e: Entity) {
  if (!e.hidden) return;
  e.hidden = false;
  const h = home(sim, e);
  if (h) {
    const d = doorOf(sim, h);
    e.x = d.x;
    e.z = d.z;
    e.yaw = Math.atan2(d.x - h.x, d.z - h.z);
    updateHouseLight(sim, h);
  }
}

export function updateHouseLight(sim: Sim, h: Entity) {
  let n = 0;
  for (const e of sim.ents.values()) if (e.human?.homeId === h.id && e.hidden) n++;
  const lit = n > 0 && sim.light < 0.6;
  h.shape = lit ? 'house-lit' : 'house';
}

function atHome(sim: Sim, e: Entity) {
  const d = homeDoor(sim, e);
  return !!d && Math.hypot(e.x - d.x, e.z - d.z) < 0.8;
}

export function stepHuman(sim: Sim, e: Entity) {
  const H = e.human!;
  if (e.state === 'captive') return;
  if (e.state === 'downed') {
    if (sim.tick - H.downedAt > 600) {
      e.state = 'flee';
      e.roll = 0;
      e.hp = Math.max(e.hp, sim.maxHp(e) * 0.25);
    }
    return;
  }
  const V = sim.layout.village;
  const nearVillage = Math.hypot(e.x - V.x, e.z - V.z) < 35;
  const alarm = sim.alarmUntil > sim.tick && nearVillage;

  // guards: fight monsters near their post, sound the shofar
  if (H.job === 'guard' && !e.hidden) {
    const post = H.site >= 0 ? { x: (H.site % SIZE) + 0.5, z: ((H.site / SIZE) | 0) + 0.5 } : e;
    const m = nearestThreat(sim, e, 9);
    if (m && Math.hypot(m.x - V.x, m.z - V.z) < 14 && sim.alarmCooldownUntil <= sim.tick) soundShofar(sim, e, m);
    // a spear thrown at whatever comes near the walls, before it closes
    if (m && spearsOf(e) > 0 && sim.tick >= H.attackReadyAt && Math.hypot(m.x - V.x, m.z - V.z) < sim.layout.wallRadius + 6) {
      const d = Math.hypot(m.x - e.x, m.z - e.z);
      if (d > 0.6 && d < 5.5 && guardThrow(sim, e, m)) {
        sim.stop(e);
        e.state = 'fight';
        H.attackReadyAt = sim.tick + 15;
        if (m.monster && m.target < 0) m.target = e.id;
        return;
      }
    }
    if (m && Math.hypot(m.x - V.x, m.z - V.z) < sim.layout.wallRadius + 3 && e.hp > sim.maxHp(e) * 0.3) {
      e.state = 'fight';
      guardFight(sim, e, m);
      return;
    }
    // unarmed: fetch a spear (a lying one, else one from the rack)
    if (guardFetch(sim, e)) return;
  }

  // flee from close monsters
  if (!e.hidden && H.job !== 'guard') {
    const m = nearestThreat(sim, e, fleeR(sim));
    if (m) {
      if (e.state !== 'flee') {
        e.state = 'flee';
        sim.stop(e);
        sim.emote(e, '😱', 2);
      }
      e.stateUntil = sim.tick + 80;
    }
  }
  if (e.state === 'flee') {
    if (sim.tick > e.stateUntil && !alarm) {
      e.state = 'idle';
      sim.stop(e);
    } else {
      if (homeBreached(sim, e)) return scatter(sim, e);
      if (atHome(sim, e)) return enterHouse(sim, e, 'hide');
      const h = homeDoor(sim, e);
      if (h && !sim.moving(e)) sim.goTo(e, h.x, h.z);
      sim.advancePath(e, humanSpeed(sim, e));
      return;
    }
  }

  // help the champion drag a monster home
  if (sim.dragging >= 0 && !e.hidden && H.job !== 'guard') {
    const c = sim.champion();
    const d = sim.ents.get(sim.dragging);
    if (c && d?.kind === 'monster' && Math.hypot(c.x - e.x, c.z - e.z) < 8) {
      e.state = 'help-drag';
      // 1.5 m beside the rope, halfway between the champion and the body (F5)
      const mx = (c.x + d.x) / 2, mz = (c.z + d.z) / 2;
      const ax = c.x - d.x, az = c.z - d.z, al = Math.hypot(ax, az) || 1;
      const side = e.id % 2 ? 1 : -1, back = ((e.id >> 1) % 3) * 0.12;
      const tx = mx - (az / al) * side * (1.5 / 8) - (ax / al) * back, tz = mz + (ax / al) * side * (1.5 / 8) - (az / al) * back;
      if (Math.hypot(tx - e.x, tz - e.z) > 0.05) sim.moveToward(e, tx, tz, Math.min(humanSpeed(sim, e) * 1.2, Math.hypot(tx - e.x, tz - e.z) * 10));
      e.yaw = Math.atan2(c.x - e.x, c.z - e.z);
      return;
    }
  }
  if (e.state === 'help-drag') e.state = 'idle';

  // alarm: everyone near the village goes inside
  if (alarm && H.job !== 'guard') {
    if (e.hidden) return;
    if (homeBreached(sim, e)) return scatter(sim, e);
    if (atHome(sim, e)) return enterHouse(sim, e, 'hide');
    e.state = 'go-home';
    const h = homeDoor(sim, e);
    if (h && !sim.moving(e)) sim.goTo(e, h.x, h.z);
    sim.advancePath(e, humanSpeed(sim, e));
    return;
  }

  // the shofar (or a raid) calls every guard to the walls, on shift or not
  const called = H.job === 'guard' && (alarm || sim.raidUntil > sim.clockMs);
  if (onShift(sim, e) || called) {
    if (e.hidden) leaveHouse(sim, e);
    if (H.site < 0 || sim.stock[H.site] < 0.34 && H.job !== 'guard') {
      H.site = pickSite(sim, e);
      H.workedMs = 0;
      sim.stop(e);
    }
    if (H.site < 0) return wander(sim, e);
    const sx = (H.site % SIZE) + 0.5, sz = ((H.site / SIZE) | 0) + 0.5;
    const d = Math.hypot(sx - e.x, sz - e.z);
    if (d > 2.2) {
      e.state = 'commute';
      if (!sim.moving(e) && !sim.goTo(e, sx, sz)) H.site = -1;
      sim.advancePath(e, humanSpeed(sim, e));
    } else {
      e.state = 'work';
      if (H.job === 'guard') {
        if (d > 0.3 && !sim.moving(e)) sim.goTo(e, sx, sz);
        else e.yaw = Math.atan2(e.x - V.x, e.z - V.z);
      } else if (!sim.moving(e) && e.idleUntil < sim.tick) {
        const x = Math.floor(sx + sim.rng.int(-1, 1)), z = Math.floor(sz + sim.rng.int(-1, 1));
        if (sim.walkableFor(e, x, z)) sim.goTo(e, x, z);
        e.idleUntil = sim.tick + sim.rng.int(60, 240);
      }
      sim.advancePath(e, humanSpeed(sim, e) * 0.6);
    }
    return;
  }
  // off shift: go home and sleep
  if (e.state === 'sleep' || e.state === 'hide') {
    if (e.state === 'hide') e.state = 'sleep';
    if (sim.food > 0) heal(sim, e, (5 * sim.msPerTick) / HOUR_MS);
    return;
  }
  if (homeBreached(sim, e)) return scatter(sim, e);
  if (atHome(sim, e)) return enterHouse(sim, e, 'sleep');
  e.state = 'go-home';
  const h = homeDoor(sim, e);
  if (h && !sim.moving(e)) sim.goTo(e, h.x, h.z);
  sim.advancePath(e, humanSpeed(sim, e));
}

// ---------- raids: monsters break into houses ----------

export function houseBreached(sim: Sim, h: Entity): boolean {
  return ((h.data.core?.breachedUntil as number | undefined) ?? 0) > sim.tick;
}

function homeBreached(sim: Sim, e: Entity): boolean {
  const h = home(sim, e);
  return !!h && houseBreached(sim, h);
}

/** Who is hiding in a house. */
export function occupants(sim: Sim, h: Entity): Entity[] {
  return sim.humans().filter((e) => e.human!.homeId === h.id && e.hidden && e.id !== sim.championId);
}

/** A monster has broken the door in: everyone inside bolts, and the house is no shelter for a while. */
export function breachHouse(sim: Sim, h: Entity) {
  (h.data.core ??= {}).breachedUntil = sim.tick + 1200;
  const out = occupants(sim, h);
  for (const e of out) {
    leaveHouse(sim, e);
    e.state = 'flee';
    e.stateUntil = sim.tick + 120;
    sim.emote(e, '😱', 2);
  }
  updateHouseLight(sim, h);
  if (out.length) sim.log(`A monster smashes into a house; ${out.length === 1 ? `${out[0].name} flees` : `${out.length} villagers flee`} into the night.`, 2, 'core', 'raid');
}

/** No shelter: run from the nearest monster, toward the champion when there is one. */
function scatter(sim: Sim, e: Entity) {
  e.state = 'flee';
  if (!sim.moving(e) || sim.tick % 20 === e.id % 20) {
    const m = nearestThreat(sim, e, 20);
    const c = sim.champion();
    let tx: number, tz: number;
    if (c && c.state !== 'downed' && c.state !== 'captive' && (!m || Math.hypot(m.x - c.x, m.z - c.z) > 3)) {
      tx = c.x; tz = c.z;
    } else if (m) {
      const dx = e.x - m.x, dz = e.z - m.z, d = Math.hypot(dx, dz) || 1;
      tx = e.x + (dx / d) * 8; tz = e.z + (dz / d) * 8;
    } else {
      tx = e.x; tz = e.z;
    }
    const n = sim.nearestWalkable(e, tx, tz, 4);
    if (n) sim.goTo(e, n.x, n.z);
  }
  sim.advancePath(e, humanSpeed(sim, e));
}

function wander(sim: Sim, e: Entity) {
  e.state = 'idle';
  if (!sim.moving(e) && e.idleUntil < sim.tick) {
    const h = homeDoor(sim, e) ?? e;
    const x = Math.floor(h.x + sim.rng.int(-4, 4)), z = Math.floor(h.z + sim.rng.int(-4, 4));
    if (sim.walkableFor(e, x, z)) sim.goTo(e, x, z);
    e.idleUntil = sim.tick + sim.rng.int(50, 200);
  }
  sim.advancePath(e, humanSpeed(sim, e) * 0.7);
}

function guardFight(sim: Sim, e: Entity, m: Entity) {
  const armed = spearsOf(e) > 0;
  const reach = (armed ? 2.6 : 1.4) / 8; // spear or knife, meters → tiles (§2)
  const d = axisDist(m, e.x, e.z) - bodyR(m);
  e.yaw = Math.atan2(m.x - e.x, m.z - e.z);
  if (d > reach) {
    if (Math.hypot(m.x - e.x, m.z - e.z) < 2) {
      sim.stop(e);
      sim.moveToward(e, m.x, m.z, Math.min(humanSpeed(sim, e), (d - reach * 0.8) * 10 + 0.05));
    } else {
      if (!sim.moving(e) || sim.tick % 10 === 0) sim.goTo(e, m.x, m.z);
      sim.advancePath(e, humanSpeed(sim, e));
    }
    return;
  }
  sim.stop(e);
  const H = e.human!;
  if ((m.monster?.alt ?? 0) > 3) return; // out of reach overhead
  if (sim.tick >= H.attackReadyAt) {
    H.attackReadyAt = sim.tick + 12;
    applyDamage(sim, m, (armed ? 6 : 4) * armFactor(e) * sim.stat(e, 'strength'), { type: armed ? 'pierce' : 'slash', sourceId: e.id });
    if (m.monster && m.state !== 'downed' && m.state !== 'bound' && m.target < 0) m.target = e.id;
  }
}

export function soundShofar(sim: Sim, guard: Entity, m: Entity) {
  sim.alarmUntil = sim.tick + 1200;
  sim.alarmCooldownUntil = sim.tick + 1200;
  sim.emote(guard, '📯', 3);
  sim.alert({ kind: 'shofar', text: `The shofar sounds! ${m.monster?.seen ? m.name!.split(' ')[0] : 'Something'} is at the walls.` });
  sim.log(`The shofar sounds: a monster at the walls.`, 2, 'core', 'alarm');
}

// ---------- economy ----------

export function foodTick(sim: Sim) {
  const dt = sim.msPerTick;
  let eaters = 0;
  for (const e of sim.ents.values()) {
    if (e.kind !== 'human') continue;
    if (e.id !== sim.championId) eaters++;
    const H = e.human!;
    if (e.state !== 'work' || H.site < 0) continue;
    const rate = PRODUCTION[H.job] * productionMul(sim, H.job);
    sim.food += (rate * dt) / HOUR_MS;
    if (H.job === 'woodcutter') sim.timber += dt / HOUR_MS;
    if (H.job === 'guard') continue;
    H.workedMs += dt;
    if (H.workedMs >= HOUR_MS) {
      H.workedMs = 0;
      sim.stock[H.site] = Math.max(0, sim.stock[H.site] - 0.34);
    }
  }
  sim.food -= (eaters * 10 * dt) / DAY_MS;
  if (sim.food > sim.foodCap) sim.food = sim.foodCap;
  if (sim.food <= 0) {
    sim.food = 0;
    // starvation: 4 HP per game hour
    if (sim.tick % 10 === 0) for (const e of sim.humans()) if (e.id !== sim.championId) applyDamage(sim, e, (4 * dt * 10) / HOUR_MS, { type: 'hunger', noRules: true, deathType: 'slain' });
  }
}

export function productionMul(sim: Sim, job: Job): number {
  let m = 1;
  for (const r of (sim as any).productionRules ?? []) {
    let v: number | undefined;
    try {
      v = r.fn(job);
    } catch {
      v = undefined;
    }
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) m *= Math.min(5, v);
  }
  return m;
}

export function villageHour(sim: Sim) {
  const h = Math.round(sim.hour) % 24;
  // job changes take effect at shift starts
  if (h === 6 || h === 18) for (const e of sim.humans()) {
    if (e.human!.nextJob && e.id !== sim.championId) changeJob(sim, e, e.human!.nextJob);
  }
  for (const house of sim.ents.values()) if (house.role === 'house') updateHouseLight(sim, house);
}

export function changeJob(sim: Sim, e: Entity, job: Job) {
  const H = e.human!;
  H.nextJob = undefined;
  H.job = job;
  H.site = -1;
  e.shape = job === 'guard' ? 'guard' : job === 'shepherd' ? 'shepherd' : 'human';
  e.tint = ({ shepherd: '#e6dcc4', vinedresser: '#7a3a5a', woodcutter: '#6a4a2a', fisherman: '#3a6a8a', farmer: '#c8a050', guard: '#8a2a2a' } as Record<string, string>)[job] ?? e.tint;
  // only guards (and the champion) bear spears: a new guard fetches one, a former guard leaves his on the ground
  if (job === 'guard') setSpears(e, spearsOf(e));
  else dropSpears(sim, e);
}

export function villageMidnight(sim: Sim) {
  const today = calDay(sim.clockMs);
  // corpses → bones; bones and parts age away; blood washes away
  for (const e of [...sim.ents.values()]) {
    if (e.kind === 'corpse' && e.corpse) {
      if (!e.corpse.bones) {
        e.corpse.bones = true;
        e.shape = 'bones';
        e.roll = 0;
        e.squash = 1;
        e.scale = e.scale > 1.3 ? 1.4 : 1;
        sim.detach(e, 'smoke');
      } else if (++e.corpse.bonesNights >= 3 && sim.dragging !== e.id) sim.remove(e);
    } else if (e.kind === 'blood') sim.remove(e);
    else if (e.kind === 'part' && (e.expireCalDay ?? 0) <= today) sim.remove(e);
  }
  // fields and pastures regrow
  for (let i = 0; i < sim.stock.length; i++) if (sim.stock[i] < 1) sim.stock[i] = Math.min(1, sim.stock[i] + 0.2);
  sim.fold = Math.min(6, sim.fold + 1);
  // surviving another day
  for (const e of sim.humans()) gainXp(sim, e, 10);
  // growth: one newcomer every 2 days when the granary is over half full
  const humans = sim.humans();
  if (sim.day % 2 === 0 && sim.food > sim.foodCap / 2 && humans.length < POP_CAP && humans.length > 1) addNewcomer(sim);
  // wild animals respawn (R12)
  const animals = [...sim.ents.values()].filter((e) => e.kind === 'animal');
  if (animals.length < 10) {
    const opts = [[1, 'goat'], [4, 'goat'], [2, 'ox'], [5, 'ox']] as const;
    for (const [r, sp] of [sim.rng.pick(opts)!, sim.rng.pick(opts)!]) {
      for (let k = 0; k < 40; k++) {
        const x = sim.rng.int(3, SIZE - 4), z = sim.rng.int(3, SIZE - 4);
        if (sim.grid.regionAt(x, z) !== r || !sim.walkableFor('animal', x, z)) continue;
        spawnAnimal(sim, sp, { x, z });
        break;
      }
    }
  }
}

export function addNewcomer(sim: Sim, o: { job?: Job; level?: number } = {}): Entity | null {
  const humans = sim.humans();
  if (humans.length >= POP_CAP) return null;
  const counts = new Map<Job, number>();
  for (const h of humans) counts.set(h.human!.job, (counts.get(h.human!.job) ?? 0) + 1);
  const want: Record<string, number> = { shepherd: 4, vinedresser: 3, woodcutter: 3, fisherman: 3, farmer: 4, guard: 3 };
  let job = o.job;
  if (!job) {
    let best: Job = 'farmer', gap = -Infinity;
    for (const [j, n] of Object.entries(want)) {
      const g = n - (counts.get(j as Job) ?? 0) + sim.rng.next() * 0.5;
      if (g > gap) { gap = g; best = j as Job; }
    }
    job = best;
  }
  const houses = [...sim.ents.values()].filter((e) => e.role === 'house');
  const occ = (h: Entity) => humans.filter((x) => x.human!.homeId === h.id).length;
  houses.sort((a, b) => occ(a) - occ(b));
  const nightNeed = { shepherd: 2, fisherman: 1, guard: 1 } as Record<string, number>;
  const nightNow = humans.filter((h) => h.human!.job === job && h.human!.shift === 'night').length;
  const shift = (nightNeed[job] ?? 0) > nightNow ? 'night' : 'day';
  const e = spawnHuman(sim, job, houses[0], o.level ?? 1, shift);
  const g = sim.layout.gates[0];
  e.x = g.x + 0.5;
  e.z = g.z + 0.5;
  sim.log(`A wanderer, ${e.name}, joins the village as a ${job}.`, 2, 'core', 'growth');
  return e;
}

void setDowned;
