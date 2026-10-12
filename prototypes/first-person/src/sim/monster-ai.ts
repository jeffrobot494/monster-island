// Monster AI (§6 + R6–R14): hours, pre-rolled hunts, prowling, stalking, grabbing, carrying, sacrifice, fighting,
// roars and responses, visits, feeding, fleeing, downed.
import type { Sim } from './sim';
import type { Entity } from './types';
import { DAY_MS, HOUR_MS, inWindow } from './clock';
import { applyDamage, armFactor, dropCarried, firstName, gainXp, heal, kill, legFactor, regionName, sigLost } from './combat';
import { rollRestless } from './populate';
import { offerFavor } from './favor';
import { SIZE } from './world';
import { M as MPT } from './ground';
import { bodyR, champReachable, feetY, frontPoint, heightM, reachT } from './body';
import { cs, releaseOnChampion } from './champion';
import { breachHouse, doorOf, houseBreached, occupants } from './village';

const DOWNED_TICKS = 1200;

export function boldness(sim: Sim) {
  return Math.max(0, sim.day - 1);
}

export function monsterWindows(sim: Sim, m: Entity): [number, number][] {
  const M = m.monster!;
  const w = Math.min(6, boldness(sim) * 0.5);
  switch (M.hours) {
    case 'day': return [[7 - w, 17 + w]];
    case 'night': return [[19 - w, 5 + w]];
    case 'dusk-dawn': return [[4 - w, 8 + w], [16 - w, 21 + w]];
    default: return M.restless.map(([a, b]) => [a - w, b + w] as [number, number]);
  }
}

export function isEnraged(sim: Sim, m: Entity) {
  return m.monster!.enragedUntil > sim.clockMs;
}

/** Tonight every monster marches on the village. */
export function raiding(sim: Sim) {
  return sim.raidUntil > sim.clockMs;
}

/** Enraged or raiding: the walls are no protection. */
function bold(sim: Sim, m: Entity) {
  return isEnraged(sim, m) || raiding(sim);
}

// ---------- flight ----------

/** Soaring height (m): high enough to look over the whole of a region. */
export const CRUISE_M = 45;
const CLIMB_M = 0.5; // per tick (5 m/s)
const STOOP_M = 1.4; // per tick (14 m/s)

export function canFly(m: Entity) {
  return !!m.monster?.flies && m.zones?.sig?.state === 'ok';
}

const altOf = (m: Entity) => m.monster?.alt ?? 0;
/** Too high to strike or grab. */
const aloft = (m: Entity) => altOf(m) > 3;

/** Can m reach t vertically? Only a climbing champion on a terraformer island can be out of reach. */
export function vReachOk(sim: Sim, m: Entity, t: Entity): boolean {
  if (t.id !== sim.championId || !sim.grid.base) return true;
  return champReachable(sim.ground, m, t);
}

/** Up where m can't follow (D7): on a cliff tile or off the ground, on a tile m can't walk; or up on the feature
 *  mesh (an arch span) out of m's reach, whatever the tile under it. */
function upCliff(sim: Sim, m: Entity, t: Entity): boolean {
  if (t.id !== sim.championId || !sim.grid.base || canFly(m)) return false;
  const alt = t.human?.alt ?? 0;
  const onCliff = sim.grid.get(Math.floor(t.x), Math.floor(t.z)) === 'cliff';
  if ((onCliff || alt > 0.5) && !sim.walkableFor(m, t.x, t.z)) return true;
  return alt > 3 && !champReachable(sim.ground, m, t);
}

/** Gave up on the champion a while ago and leaves them be. */
const ignoring = (sim: Sim, m: Entity, t: Entity | undefined) => !!t && t.id === sim.championId && (m.monster!.ignoreChampUntil ?? 0) > sim.clockMs;

function clearBesiege(m: Entity) {
  const M = m.monster!;
  if (M.besiegeUntil !== undefined) delete M.besiegeUntil;
  if (M.besiegeSince !== undefined) delete M.besiegeSince;
}

function targetAlt(sim: Sim, m: Entity): number {
  const M = m.monster!;
  if (!canFly(m)) return 0;
  switch (m.state) {
    case 'rest': case 'downed': case 'bound': case 'sacrifice': case 'feed': case 'batter': return 0;
    case 'carry': return 7;
    case 'fight': case 'stalk': case 'grab': case 'raid': {
      // stoop on the quarry: lower the closer it is
      const t = sim.ents.get(m.state === 'fight' || m.state === 'raid' ? m.target : M.prey);
      if (!t) return m.state === 'raid' ? CRUISE_M : 0;
      const stoop = Math.min(CRUISE_M, Math.max(0, (Math.hypot(t.x - m.x, t.z - m.z) - 1.2) * 7));
      // a climber: come down (or up) to its height
      if (t.id === sim.championId && (t.human?.alt ?? 0) > 0) return Math.min(120, Math.max(stoop, feetY(sim.ground, t) - sim.ground.y(m.x, m.z)));
      return stoop;
    }
  }
  // coming home: glide down onto the lair
  const dl = Math.hypot(m.x - M.lairX, m.z - M.lairZ);
  if (m.state === 'return' || m.state === 'flee') return Math.min(CRUISE_M, Math.max(0, (dl - 0.8) * 9));
  return CRUISE_M;
}

function updateAltitude(sim: Sim, m: Entity) {
  const M = m.monster!;
  if (!M.flies && !M.alt) return;
  const a = M.alt ?? 0, want = targetAlt(sim, m);
  // a crippled wing drops it out of the sky
  const fall = !canFly(m) || m.state === 'downed' || m.state === 'bound' ? 3 : STOOP_M;
  M.alt = want > a ? Math.min(want, a + CLIMB_M) : Math.max(want, a - fall);
}

/** Active hours (clock windows, widened by boldness) and the light rule (R8). */
export function monsterActive(sim: Sim, m: Entity, hour = sim.hour, light = sim.light): boolean {
  const M = m.monster!;
  if (isEnraged(sim, m) || raiding(sim)) return true;
  if (M.hours === 'night' && light < 0.3) return true;
  if (M.hours === 'day' && light <= 0.4) return false;
  return monsterWindows(sim, m).some(([a, b]) => inWindow(hour, a, b));
}

/** Pre-roll today's hunt times uniformly inside the monster's active windows (R6). */
export function rollHunts(sim: Sim, m: Entity) {
  const M = m.monster!;
  const n = 1 + Math.floor(boldness(sim) / 4) + (isEnraged(sim, m) ? 1 : 0);
  const dayStart = sim.clockMs - (((sim.clockMs % DAY_MS) + DAY_MS) % DAY_MS);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    for (let tries = 0; tries < 60; tries++) {
      const t = dayStart + sim.rng.next() * DAY_MS;
      if (t <= sim.clockMs) continue;
      const h = (((t % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS;
      if (monsterWindows(sim, m).some(([a, b]) => inWindow(h, a, b)) || isEnraged(sim, m)) {
        out.push(t);
        break;
      }
    }
  }
  M.huntAt = out.sort((a, b) => a - b);
}

export function monsterMidnight(sim: Sim) {
  rollRestless(sim);
  for (const m of sim.monsters()) {
    const M = m.monster!;
    if (M.enragedUntil && M.enragedUntil <= sim.clockMs) {
      M.enragedUntil = 0;
      if (M.seen) sim.log(`${firstName(m)}'s fury cools.`, 1);
    }
    rollHunts(sim, m);
    M.visit = null;
    const alive = M.neighbors.filter((id) => sim.ents.get(id)?.kind === 'monster');
    if (alive.length && sim.rng.chance(0.3)) {
      const hours: number[] = [];
      for (let h = 0; h < 24; h++) if (monsterWindows(sim, m).some(([a, b]) => inWindow(h + 0.5, a, b))) hours.push(h);
      if (hours.length) M.visit = { atHour: sim.rng.pick(hours)!, to: sim.rng.pick(alive)!, done: false };
    }
  }
}

export function monsterSpeed(sim: Sim, m: Entity): number {
  let s = sim.stat(m, 'speed') * legFactor(m);
  if (m.hp < sim.maxHp(m) * 0.3) s *= 0.8;
  if (m.state === 'carry') s *= 0.7;
  if (m.state === 'stalk') s *= 0.85;
  if (m.state === 'grab') s *= 1.2;
  if (m.state === 'respond') s *= 1.3;
  if (m.state === 'prowl' || m.state === 'rest') s *= 0.6;
  return s;
}

function sightOf(sim: Sim, m: Entity) {
  // flyers soaring high see a long way: 320 m by day, 160 m by night
  if (altOf(m) > 15) return (sim.light > 0.4 ? 40 : 20) * sim.stat(m, 'sight');
  const base = sim.light > 0.4 ? 10 : m.monster!.archetype === 'lilit' ? 10 : 7;
  return base * sim.stat(m, 'sight');
}

const lair = (m: Entity) => ({ x: m.monster!.lairX, z: m.monster!.lairZ });

function go(sim: Sim, m: Entity, x: number, z: number, every = 0) {
  if (!sim.moving(m) || (every && sim.tick % every === 0)) {
    if (!sim.goTo(m, x, z)) return false;
  }
  sim.advancePath(m, monsterSpeed(sim, m));
  return true;
}

function setState(sim: Sim, m: Entity, s: string) {
  if (m.state === s) return;
  m.state = s;
  sim.stop(m);
}

export function roar(sim: Sim, m: Entity) {
  const M = m.monster!;
  if (sim.tick - M.roarAt < 100) return;
  M.roarAt = sim.tick;
  sim.burstOn('roar', m, 'head');
  sim.sound('roar', m.x, m.z, m.scale);
  sim.emote(m, '💢', 1.5);
  for (const id of M.neighbors) {
    const n = sim.ents.get(id);
    if (!n || n.kind !== 'monster') continue;
    if (['downed', 'bound', 'carry', 'sacrifice', 'fight', 'respond'].includes(n.state)) continue;
    if (Math.hypot(n.x - m.x, n.z - m.z) > 50) continue;
    n.monster!.respondTo = { x: m.x, z: m.z, at: sim.tick + sim.rng.int(0, 20) };
  }
}

/** Score a potential victim (R13: hidden villagers are safe). */
export function insideWalls(sim: Sim, p: { x: number; z: number }, pad = 0.5) {
  const V = sim.layout.village;
  return Math.hypot(p.x - V.x - 0.5, p.z - V.z - 0.5) < sim.layout.wallRadius + pad;
}

function preyScore(sim: Sim, m: Entity, h: Entity): number {
  if (h.kind !== 'human' || h.hidden || h.state === 'captive' || h.carriedBy !== undefined) return -Infinity;
  if (!bold(sim, m) && insideWalls(sim, h, 1.5)) return -Infinity;
  const isChamp = h.id === sim.championId;
  if (isChamp && h.state !== 'downed' && h.hp > sim.maxHp(h) * 0.4) return -Infinity;
  if (isChamp && upCliff(sim, m, h)) return -Infinity;
  const d = Math.hypot(h.x - m.x, h.z - m.z);
  if (d > sightOf(sim, m)) return -Infinity;
  let lone = true;
  for (const o of sim.ents.values()) if (o !== h && o.kind === 'human' && !o.hidden && Math.hypot(o.x - h.x, o.z - h.z) < 4) { lone = false; break; }
  return h.level * 2 + (lone ? 3 : 0) + (h.state === 'downed' ? 5 : 0) + (isChamp ? 6 : 0) - d / 10;
}

function findPrey(sim: Sim, m: Entity): Entity | null {
  let best: Entity | null = null, bs = -Infinity;
  for (const h of sim.ents.values()) {
    if (h.kind !== 'human') continue;
    const s = preyScore(sim, m, h);
    if (s > bs) { bs = s; best = h; }
  }
  return best;
}

function pickGround(sim: Sim, m: Entity): { x: number; z: number } {
  const M = m.monster!;
  const V = sim.layout.village;
  if (isEnraged(sim, m)) return { x: sim.layout.gates[0].x + 0.5, z: sim.layout.gates[0].z + 0.5 };
  const roam = Math.min(90, 30 + 4 * boldness(sim));
  const cands: { x: number; z: number; w: number }[] = [];
  for (const h of sim.ents.values()) {
    if (h.kind !== 'human' || h.hidden) continue;
    if (Math.hypot(h.x - V.x, h.z - V.z) < sim.layout.wallRadius) continue;
    if (Math.hypot(h.x - M.lairX, h.z - M.lairZ) > roam) continue;
    const dv = Math.hypot(h.x - V.x, h.z - V.z);
    cands.push({ x: h.x, z: h.z, w: (1 + h.level) * Math.min(2, Math.max(0.15, (dv - 10) / 15)) });
  }
  if (!cands.length) {
    const a = sim.rng.next() * Math.PI * 2, r = 6 + sim.rng.next() * roam * 0.5;
    const n = sim.nearestWalkable(m, M.lairX + Math.cos(a) * r, M.lairZ + Math.sin(a) * r, 5);
    return n ? { x: n.x + 0.5, z: n.z + 0.5 } : lair(m);
  }
  let total = 0;
  for (const c of cands) total += c.w;
  let r = sim.rng.next() * total;
  for (const c of cands) if ((r -= c.w) <= 0) return c;
  return cands[0];
}

export function stepMonster(sim: Sim, m: Entity) {
  stepMonsterAI(sim, m);
  if (sim.ents.has(m.id) && m.monster) updateAltitude(sim, m);
}

function stepMonsterAI(sim: Sim, m: Entity) {
  const M = m.monster!;
  const max = sim.maxHp(m);
  const champ = sim.champion();

  switch (m.state) {
    case 'downed':
      if (sim.tick % 100 === 0) roar(sim, m);
      if (sim.tick - M.downedAt > DOWNED_TICKS) {
        m.state = 'flee';
        m.roll = 0;
        m.hp = Math.max(m.hp, max * 0.3);
        sim.emote(m, '💢', 2);
      }
      return;
    case 'bound':
      if (sim.dragging !== m.id && m.stateUntil && sim.tick > m.stateUntil) {
        m.state = 'downed';
        m.stateUntil = 0;
        M.downedAt = sim.tick;
      }
      return;
    case 'carry': return carry(sim, m);
    case 'sacrifice': return sacrifice(sim, m);
    case 'feed':
      if (sim.tick > m.stateUntil) setState(sim, m, 'return');
      return;
  }

  // fighting: a current target (whoever attacked it), or the champion when close
  const t = m.target >= 0 ? sim.ents.get(m.target) : undefined;
  // raiders don't chase a runaway across the island: they stay on the village
  const strayed = !!t && raiding(sim) && Math.hypot(t.x - sim.layout.village.x, t.z - sim.layout.village.z) > sim.layout.wallRadius + 12;
  if (t && !strayed && !ignoring(sim, m, t) && t.kind === 'human' && t.state !== 'captive' && !t.hidden && Math.hypot(t.x - m.x, t.z - m.z) < 14 && (bold(sim, m) || !insideWalls(sim, t, 1))) {
    if (t.state === 'downed' && !raiding(sim)) {
      m.target = -1;
      M.prey = t.id;
      setState(sim, m, 'stalk');
    } else {
      // flee from guards when badly hurt; never from the champion (R9)
      if (m.hp < max * 0.3 && t.id !== sim.championId) {
        m.target = -1;
        return startFlee(sim, m);
      }
      setState(sim, m, 'fight');
      return fight(sim, m, t);
    }
  } else if (m.target >= 0) {
    m.target = -1;
    clearBesiege(m);
    if (m.state === 'fight') setState(sim, m, raiding(sim) ? 'raid' : 'return');
  }
  if (champ && !ignoring(sim, m, champ) && champ.state !== 'downed' && champ.state !== 'captive' && Math.hypot(champ.x - m.x, champ.z - m.z) < (m.state === 'rest' ? 3.5 : 5) && !['flee'].includes(m.state) && (bold(sim, m) || !insideWalls(sim, champ, 1))) {
    m.target = champ.id;
    setState(sim, m, 'fight');
    return fight(sim, m, champ);
  }

  if (m.state === 'flee') {
    if (Math.hypot(m.x - M.lairX, m.z - M.lairZ) < 1.5) setState(sim, m, 'rest');
    else go(sim, m, M.lairX, M.lairZ);
    return;
  }

  // answering a neighbor's roar
  if (M.respondTo && sim.tick >= M.respondTo.at && !['downed', 'bound', 'carry', 'sacrifice'].includes(m.state)) {
    setState(sim, m, 'respond');
    const r = M.respondTo;
    if (Math.hypot(r.x - m.x, r.z - m.z) < 3) {
      M.respondTo = null;
      if (champ && !ignoring(sim, m, champ) && Math.hypot(champ.x - m.x, champ.z - m.z) < sightOf(sim, m)) {
        m.target = champ.id;
        setState(sim, m, 'fight');
      } else setState(sim, m, 'return');
      return;
    }
    go(sim, m, r.x, r.z, 30);
    return;
  }

  // the raid: every monster on the island comes for the village
  if (raiding(sim)) return raid(sim, m);
  if (m.state === 'raid' || m.state === 'batter') setState(sim, m, 'return');

  const active = monsterActive(sim, m) && (M.satedUntil ?? 0) <= sim.clockMs;
  // wounded monsters heal at the lair
  if (Math.hypot(m.x - M.lairX, m.z - M.lairZ) < 3 && m.hp < max && sim.tick % 10 === 0) heal(sim, m, (max * 0.1 * sim.msPerTick * 10) / HOUR_MS);

  // anak (and the hungry, after a kill) eat the dead
  if ((M.archetype === 'anak' || sim.tick < M.feedAt) && sim.tick % 20 === 0 && m.state !== 'stalk' && m.state !== 'grab' && !raiding(sim)) {
    const c = nearestCorpse(sim, m, M.archetype === 'anak' ? 10 : 2);
    if (c) {
      if (Math.hypot(c.x - m.x, c.z - m.z) < 1.5) return startFeed(sim, m, c);
      setState(sim, m, 'return');
      sim.goTo(m, c.x, c.z);
    }
  }

  if (m.state === 'hunt' || m.state === 'stalk' || m.state === 'grab') {
    if (!active && m.state === 'hunt' && sim.clockMs > M.huntUntil) setState(sim, m, 'return');
    else return hunt(sim, m);
  }
  if (m.state === 'visit') {
    const host = sim.ents.get(M.visit?.to ?? -1);
    if (!host || !M.visit) return setState(sim, m, 'return');
    const hl = lair(host);
    if (Math.hypot(hl.x - m.x, hl.z - m.z) > 2.5) {
      go(sim, m, hl.x + 1, hl.z + 1);
      m.stateUntil = sim.tick + 3000;
    } else if (sim.tick > m.stateUntil) {
      M.visit.done = true;
      setState(sim, m, 'return');
    }
    return;
  }

  if (active) {
    // a hunt is due
    if (M.huntAt.length && M.huntAt[0] <= sim.clockMs) {
      M.huntAt.shift();
      M.ground = pickGround(sim, m);
      M.huntUntil = sim.clockMs + Math.max(2 * HOUR_MS, 120_000 * sim.timescale); // long enough to walk to the village on a fast clock
      M.prey = -1;
      setState(sim, m, 'hunt');
      return;
    }
    if (M.visit && !M.visit.done && Math.floor(sim.hour) === M.visit.atHour) {
      setState(sim, m, 'visit');
      m.stateUntil = sim.tick + 3000;
      return;
    }
    // prowl the territory
    m.state = 'prowl';
    if (canFly(m) && !sim.moving(m)) {
      // soar in wide circles over the territory
      M.circle = (M.circle ?? sim.rng.next() * Math.PI * 2) + 0.7;
      const r = 12 + sim.rng.next() * 14;
      const n = sim.nearestWalkable(m, M.lairX + Math.cos(M.circle) * r, M.lairZ + Math.sin(M.circle) * r, 3);
      if (n) sim.goTo(m, n.x + 0.5, n.z + 0.5);
    } else if (!sim.moving(m) && m.idleUntil < sim.tick) {
      const a = sim.rng.next() * Math.PI * 2, r = 2 + sim.rng.next() * 10;
      const n = sim.nearestWalkable(m, M.lairX + Math.cos(a) * r, M.lairZ + Math.sin(a) * r, 3);
      if (n) sim.goTo(m, n.x, n.z);
      m.idleUntil = sim.tick + sim.rng.int(100, 500);
    }
    sim.advancePath(m, monsterSpeed(sim, m));
    // opportunistic grab of anyone wandering close
    if (sim.tick % 15 === 0) {
      const p = M.huntAt.length ? findPrey(sim, m) : null;
      if (p && Math.hypot(p.x - m.x, p.z - m.z) < (altOf(m) > 15 ? sightOf(sim, m) : 7)) {
        if (altOf(m) > 15) screech(sim, m);
        M.huntAt.shift(); // an opportunistic grab spends one of today's hunts
        M.prey = p.id;
        M.huntUntil = sim.clockMs + Math.max(HOUR_MS, 60_000 * sim.timescale);
        setState(sim, m, 'stalk');
      }
    }
    return;
  }

  // inactive: go home and rest
  if (Math.hypot(m.x - M.lairX, m.z - M.lairZ) > 2) {
    m.state = 'return';
    go(sim, m, M.lairX, M.lairZ);
  } else {
    m.state = 'rest';
    if (!sim.moving(m) && m.idleUntil < sim.tick) {
      const n = sim.nearestWalkable(m, M.lairX + sim.rng.int(-2, 2), M.lairZ + sim.rng.int(-2, 2), 2);
      if (n) sim.goTo(m, n.x, n.z);
      m.idleUntil = sim.tick + sim.rng.int(300, 900);
    }
    sim.advancePath(m, monsterSpeed(sim, m));
  }
}

// ---------- the raid ----------

export const RAID_CHANCE = 0.3;

/** Each evening at 20:00 there is a 30 % chance the monsters raid the village until 05:00. */
export function raidHour(sim: Sim, h: number) {
  if (h === 20 && !raiding(sim) && !sim.gameOver && sim.monsters().length && sim.rng.chance(RAID_CHANCE)) startRaid(sim);
  if (h === 5 && sim.raidUntil && !raiding(sim)) {
    sim.raidUntil = 0;
    if (sim.monsters().length) sim.log('Dawn grays the sky. The monsters slink back to their lairs.', 2, 'core', 'raid');
  }
}

export function startRaid(sim: Sim, hours = 9) {
  sim.raidUntil = sim.clockMs + hours * HOUR_MS;
  for (const m of sim.monsters()) {
    const M = m.monster!;
    M.batterId = undefined;
    M.respondTo = null;
    clearBesiege(m);
    if (['downed', 'bound', 'carry', 'sacrifice'].includes(m.state)) continue;
    M.prey = -1;
    m.target = -1;
    sim.stop(m);
    sim.sound('roar', m.x, m.z, m.scale);
  }
  sim.alert({ kind: 'shofar', text: 'Roars from every hill: tonight all the monsters are coming for the village!' });
  sim.log('Night falls, and every monster on the island marches on the village.', 3, 'core', 'raid');
}

/** A flyer that spots prey from high up gives a scream before it stoops. */
function screech(sim: Sim, m: Entity) {
  const M = m.monster!;
  if (sim.tick - M.roarAt < 100) return;
  M.roarAt = sim.tick;
  sim.sound('screech', m.x, m.z, m.scale);
}

const RAID_SIGHT = 13; // tiles: inside the fight check's 14-tile leash

function raid(sim: Sim, m: Entity) {
  const M = m.monster!;
  const V = sim.layout.village;
  if (m.state !== 'raid' && m.state !== 'batter') setState(sim, m, 'raid');
  // anyone in the open close by: kill them
  if (sim.tick % 5 === m.id % 5) {
    let best: Entity | null = null, bd = RAID_SIGHT;
    for (const h of sim.humans()) {
      if (h.hidden || h.state === 'captive' || h.carriedBy !== undefined || ignoring(sim, m, h)) continue;
      const d = Math.hypot(h.x - m.x, h.z - m.z) + (h.id === sim.championId ? 4 : 0);
      if (d < bd) { bd = d; best = h; }
    }
    if (best) {
      M.batterId = undefined;
      m.target = best.id;
      setState(sim, m, 'fight');
      return fight(sim, m, best);
    }
  }
  if (m.state === 'batter') return batter(sim, m);
  // march on the village
  if (Math.hypot(m.x - V.x - 0.5, m.z - V.z - 0.5) > sim.layout.wallRadius + 1) {
    const n = sim.nearestWalkable(m, V.x + 0.5, V.z + 0.5, 5);
    if (n) go(sim, m, n.x + 0.5, n.z + 0.5, 50);
    return;
  }
  // inside: break into a house with people hiding in it
  let h = M.batterId !== undefined ? sim.ents.get(M.batterId) : undefined;
  if (!h || houseBreached(sim, h) || !occupants(sim, h).length) {
    const taken = new Set(sim.monsters().map((o) => (o !== m ? o.monster!.batterId : undefined)));
    let bd = Infinity;
    h = undefined;
    for (const e of sim.ents.values()) {
      if (e.role !== 'house' || houseBreached(sim, e) || !occupants(sim, e).length) continue;
      const d = Math.hypot(e.x - m.x, e.z - m.z) + (taken.has(e.id) ? 6 : 0);
      if (d < bd) { bd = d; h = e; }
    }
    M.batterId = h?.id;
    sim.stop(m);
  }
  if (!h) {
    // nobody left to find: prowl the lanes
    if (!sim.moving(m) && m.idleUntil < sim.tick) {
      const a = sim.rng.next() * Math.PI * 2, r = sim.rng.next() * sim.layout.wallRadius;
      const n = sim.nearestWalkable(m, V.x + 0.5 + Math.cos(a) * r, V.z + 0.5 + Math.sin(a) * r, 3);
      if (n) sim.goTo(m, n.x + 0.5, n.z + 0.5);
      m.idleUntil = sim.tick + sim.rng.int(30, 120);
    }
    sim.advancePath(m, monsterSpeed(sim, m));
    return;
  }
  const door = doorOf(sim, h);
  if (Math.hypot(door.x - m.x, door.z - m.z) > 0.3 + bodyR(m)) {
    if (!go(sim, m, door.x, door.z)) M.batterId = undefined;
    return;
  }
  setState(sim, m, 'batter');
  M.batterAt = sim.tick;
}

/** Hammer at a door until it gives. */
function batter(sim: Sim, m: Entity) {
  const M = m.monster!;
  const h = M.batterId !== undefined ? sim.ents.get(M.batterId) : undefined;
  if (!h || houseBreached(sim, h)) {
    M.batterId = undefined;
    return setState(sim, m, 'raid');
  }
  sim.stop(m);
  m.yaw = Math.atan2(h.x - m.x, h.z - m.z);
  const t = sim.tick - (M.batterAt ?? sim.tick);
  if (t % 15 === 0) {
    M.strikeAt = sim.tick;
    sim.sound('hit', h.x, h.z, m.scale * 1.5);
    sim.emote(m, '💥', 1);
  }
  if (t >= 80) {
    breachHouse(sim, h);
    M.batterId = undefined;
    setState(sim, m, 'raid');
  }
}

function startFlee(sim: Sim, m: Entity) {
  dropCarried(sim, m);
  setState(sim, m, 'flee');
  sim.emote(m, '💨', 2);
}

function hunt(sim: Sim, m: Entity) {
  const M = m.monster!;
  // validate prey
  let prey = M.prey >= 0 ? sim.ents.get(M.prey) : undefined;
  if (prey && (prey.kind === 'human' ? preyScore(sim, m, prey) === -Infinity && Math.hypot(prey.x - m.x, prey.z - m.z) > 3 : prey.carriedBy !== undefined)) prey = undefined;
  if (prey && prey.hidden) prey = undefined;
  if (!prey) {
    M.prey = -1;
    if (m.state !== 'hunt') setState(sim, m, 'hunt');
    if (sim.tick % 10 === 0) {
      const p = findPrey(sim, m);
      if (p) {
        M.prey = p.id;
        if (altOf(m) > 15) screech(sim, m);
        setState(sim, m, 'stalk');
        return;
      }
    }
    if (sim.clockMs > M.huntUntil) {
      // nothing found: take a wild animal if one is close, else go home (R12)
      const a = nearestAnimal(sim, m, 30);
      if (a) {
        M.prey = a.id;
        setState(sim, m, 'stalk');
        return;
      }
      setState(sim, m, 'return');
      return;
    }
    const g = M.ground ?? lair(m);
    if (Math.hypot(g.x - m.x, g.z - m.z) < 2.5) M.ground = pickGround(sim, m);
    else go(sim, m, g.x, g.z);
    return;
  }
  // stalk and grab (meters: F3, F4)
  const fp = frontPoint(m);
  const d = Math.hypot(prey.x - fp.x, prey.z - fp.z);
  const reach = reachT(m) + 0.5 / MPT;
  if (prey.kind === 'human' && prey.human!.job === 'guard' && prey.state !== 'downed') {
    m.target = prey.id;
    setState(sim, m, 'fight');
    return;
  }
  if (m.state !== 'grab' && (d > reach || aloft(m) || !vReachOk(sim, m, prey))) {
    m.state = 'stalk';
    const near = Math.hypot(prey.x - m.x, prey.z - m.z);
    if (near < 2 && sim.lineOk(m.x, m.z, prey.x, prey.z, sim.costsFor(sim.moveKey(m)), 99)) {
      // the pounce: the last dozen meters come fast (grabs are measured in meters now)
      sim.stop(m);
      const k = near < 1.5 ? 1.6 : 1;
      if (k > 1 && !M.pounced) {
        M.pounced = true;
        sim.sound('growl', m.x, m.z, m.scale);
      }
      sim.moveToward(m, prey.x, prey.z, Math.min(monsterSpeed(sim, m) * k, Math.max(0.05, (d - reach * 0.6) * 10)));
    } else {
      M.pounced = false;
      go(sim, m, prey.x, prey.z, 10);
    }
    return;
  }
  sim.stop(m);
  m.yaw = Math.atan2(prey.x - m.x, prey.z - m.z);
  if (m.state !== 'grab') {
    m.state = 'grab';
    M.grabAt = sim.tick;
    M.grabPos = { x: prey.x, z: prey.z };
    sim.emote(m, '❗', 1);
    sim.sound('growl', m.x, m.z, m.scale);
    return;
  }
  // the grab latches: the prey can't slip away during it (F4)
  if (M.grabPos) {
    prey.x = M.grabPos.x;
    prey.z = M.grabPos.z;
    sim.stop(prey);
  }
  if (sim.tick - M.grabAt < 10) return;
  M.grabPos = null;
  // captured
  m.carrying = prey.id;
  prey.carriedBy = m.id;
  if (prey.kind === 'human') {
    sim.stop(prey);
    prey.state = 'captive';
    prey.roll = 0.6;
    prey.human!.capturedAt = sim.tick;
    prey.human!.missingReported = false;
    if (prey.id === sim.championId) {
      sim.order = null;
      sim.alert({ kind: 'champion', text: `${firstName(m)} is dragging YOU to the High Place!`, ent: m.id, until: sim.tick + 6000 });
    }
    gainXp(sim, m, 25);
    sim.emote(prey, '😱', 3);
    const c = sim.champion();
    if (c && c !== prey && Math.hypot(c.x - prey.x, c.z - prey.z) < 19) {
      sim.alert({ kind: 'scream', text: `A scream! ${firstName(prey)} is being carried off by ${M.seen ? firstName(m) : 'something'}!`, ent: prey.id, until: sim.tick + 3000 });
      prey.human!.missingReported = true;
    }
  } else {
    prey.state = 'captive';
    sim.stop(prey);
  }
  for (const l of sim.listeners) l.onCapture?.(m, prey);
  setState(sim, m, 'carry');
}

function carry(sim: Sim, m: Entity) {
  const M = m.monster!;
  const v = m.carrying !== undefined ? sim.ents.get(m.carrying) : undefined;
  if (!v) return setState(sim, m, 'return');
  v.x = m.x;
  v.z = m.z;
  v.yaw = m.yaw;
  v.lift = heightM(m) * 0.5 + altOf(m); // meters (F13)
  const A = sim.layout.highAltar;
  const c = sim.champion();
  if (v.kind === 'human') {
    const H = v.human!;
    if (sim.tick % 50 === 0) {
      sim.emote(v, sim.rng.pick(['😱', 'Help!', 'AAAH!', '🙏'])!, 1.5, true);
      if (c && c !== v && Math.hypot(c.x - v.x, c.z - v.z) < 19 && !H.missingReported) {
        H.missingReported = true;
        sim.alert({ kind: 'scream', text: `A scream! ${firstName(v)} is being carried off!`, ent: v.id, until: sim.tick + 3000 });
      }
    }
    if (!H.missingReported && sim.tick - H.capturedAt > 600) {
      H.missingReported = true;
      const where = H.job === 'shepherd' ? 'the pasture' : H.job === 'fisherman' ? 'the shore' : H.job === 'woodcutter' ? 'the cedars' : H.job === 'vinedresser' ? 'the terraces' : H.job === 'farmer' ? 'the fields' : 'the wall';
      sim.alert({ kind: 'missing', text: `${firstName(v)} did not come back from ${where}.` });
    }
  }
  // the champion guards the High Place: abandon the ritual and eat the captive there (R11)
  if (c && c !== v && Math.hypot(c.x - A.x, c.z - A.z) < 12 && Math.hypot(m.x - A.x, m.z - A.z) < 18 && Math.hypot(c.x - m.x, c.z - m.z) < sightOf(sim, m) + 4) {
    return devour(sim, m, v);
  }
  if (Math.hypot(A.x + 0.5 - m.x, A.z + 0.5 - m.z) < 1.8) {
    setState(sim, m, 'sacrifice');
    m.stateUntil = sim.tick + 200;
    sim.emote(m, '🔪', 3);
    return;
  }
  if (!sim.moving(m)) {
    if (!sim.goTo(m, A.x + 0.5, A.z + 1.5)) return devour(sim, m, v);
  }
  sim.advancePath(m, monsterSpeed(sim, m));
}

function devour(sim: Sim, m: Entity, v: Entity) {
  dropCarried(sim, m);
  m.monster!.satedUntil = sim.clockMs + 4 * HOUR_MS;
  if (v.kind === 'human' || v.kind === 'animal') {
    kill(sim, v, { amount: 999, type: 'bite', sourceId: m.id, sourceKind: 'monster', deathType: 'eaten' });
    const c = nearestCorpse(sim, m, 2);
    if (c) startFeed(sim, m, c);
    else setState(sim, m, 'return');
  }
}

function sacrifice(sim: Sim, m: Entity) {
  const M = m.monster!;
  const v = m.carrying !== undefined ? sim.ents.get(m.carrying) : undefined;
  if (!v) return setState(sim, m, 'return');
  v.lift = 1.3 + Math.sin(sim.tick * 0.3) * 0.05;
  if (sim.tick % 40 === 0) sim.burst('dark-pillar', sim.layout.highAltar.x + 0.5, sim.layout.highAltar.z + 0.5);
  if (sim.tick < m.stateUntil) return;
  const value = Math.round(sim.maxHp(v) * (v.kind === 'animal' ? 0.25 : 1));
  const name = v.name ?? v.kind;
  m.carrying = undefined;
  v.carriedBy = undefined;
  v.lift = 0;
  kill(sim, v, { amount: 999, type: 'pierce', sourceId: m.id, sourceKind: 'monster', deathType: M.archetype === 'nephil' ? 'torn' : 'impaled' });
  offerFavor(sim, 'monster', value, 'high', v.kind === 'human' ? 'human' : v.animal?.species ?? v.kind);
  gainXp(sim, m, 50);
  M.satedUntil = sim.clockMs + 4 * HOUR_MS;
  sim.stats.monsterSacrifices++;
  if (v.kind === 'human') sim.log(`${name} was sacrificed to Dagon on the High Place by ${m.name}. (+${value} favor to Dagon)`, 3, 'core', 'sacrifice');
  else sim.log(`A ${v.animal?.species ?? 'beast'} was burned to Dagon on the High Place. (+${value} favor to Dagon)`, 1, 'core', 'sacrifice');
  setState(sim, m, 'return');
}

function startFeed(sim: Sim, m: Entity, c: Entity) {
  setState(sim, m, 'feed');
  m.stateUntil = sim.tick + 200;
  m.yaw = Math.atan2(c.x - m.x, c.z - m.z);
  if (c.corpse) {
    c.corpse.eatenBy = m.id;
    c.anim = { type: 'eaten', t: 200 };
  }
  m.monster!.feedAt = 0;
}

function nearestCorpse(sim: Sim, m: Entity, r: number): Entity | null {
  let best: Entity | null = null, bd = r;
  for (const c of sim.ents.values()) {
    if (c.kind !== 'corpse' || !c.corpse || c.corpse.bones || c.corpse.species !== 'human' || c.corpse.eatenBy !== undefined || sim.dragging === c.id) continue;
    const d = Math.hypot(c.x - m.x, c.z - m.z);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function nearestAnimal(sim: Sim, m: Entity, r: number): Entity | null {
  let best: Entity | null = null, bd = r;
  for (const a of sim.ents.values()) {
    if (a.kind !== 'animal' || a.carriedBy !== undefined) continue;
    const d = Math.hypot(a.x - m.x, a.z - m.z);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

/** The attack loop with a telegraphed wind-up (R15), in meters (F3, F7, F29). */
function fight(sim: Sim, m: Entity, t: Entity) {
  const M = m.monster!;
  if (m.carrying !== undefined) dropCarried(sim, m);
  roar(sim, m);
  const hitR = telegraphRadius(m);
  const fp = frontPoint(m);
  const d = Math.hypot(t.x - fp.x, t.z - fp.z);
  const isChamp = t.id === sim.championId;
  if (M.windup >= 0) {
    // turn toward the target (180°/s), then freeze the facing for the last 2 ticks
    if (sim.tick - M.windup < 6) {
      let dy = Math.atan2(t.x - m.x, t.z - m.z) - m.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      m.yaw += Math.max(-0.314, Math.min(0.314, dy));
    }
    if (sim.tick - M.windup < 8) return;
    M.windup = -1;
    M.attackReadyAt = sim.tick + 15;
    M.strikeAt = sim.tick;
    let dmg = M.dmg * sim.stat(m, 'strength') * armFactor(m);
    if (isEnraged(sim, m)) dmg *= 1.25;
    if (sigLost(m) && ['rahab', 'tannin', 'seir', 'reem'].includes(M.archetype)) dmg *= 0.7;
    if (M.archetype === 'seir' && M.runFrom && Math.hypot(M.runFrom.x - m.x, M.runFrom.z - m.z) > 5) dmg *= 1.5;
    M.runFrom = null;
    if (isChamp) {
      const res = releaseOnChampion(sim, m, t, hitR + bodyR(t));
      const S = cs(sim);
      if (res === 'hit') applyDamage(sim, t, dmg, { type: M.dmgType, sourceId: m.id });
      else if (res === 'block') {
        // the shield takes 75 %; no burn, no limb roll
        applyDamage(sim, t, dmg * 0.25, { type: 'crush', zone: 'torso', sourceId: m.id });
        S.combat.push({ kind: 'blocked', id: m.id, amount: Math.round(dmg * 0.75) });
      } else {
        sim.burst('whiff', fp.x + Math.sin(m.yaw) * reachT(m) * 0.6, fp.z + Math.cos(m.yaw) * reachT(m) * 0.6);
        S.combat.push({ kind: 'dodged', id: m.id });
      }
    } else if (d <= hitR + bodyR(t) - 0.3 / MPT) {
      applyDamage(sim, t, dmg, { type: M.dmgType, sourceId: m.id });
    } else sim.burst('whiff', fp.x + Math.sin(m.yaw) * reachT(m) * 0.6, fp.z + Math.cos(m.yaw) * reachT(m) * 0.6);
    return;
  }
  if (isChamp && besiege(sim, m, t, d, hitR)) return;
  const stop = Math.max(bodyR(m) + bodyR(t) + 0.1 / MPT, reachT(m) * 0.8);
  // a flyer can't strike from aloft, unless it has come up to a climber's height
  const canStrike = vReachOk(sim, m, t) && (isChamp && (t.human?.alt ?? 0) > 0 ? true : !aloft(m));
  if (d <= hitR - 0.4 / MPT && sim.tick >= M.attackReadyAt && canStrike) {
    sim.stop(m);
    M.windup = sim.tick;
    m.yaw = Math.atan2(t.x - m.x, t.z - m.z);
    sim.sound('growl', m.x, m.z, m.scale);
    return;
  }
  if (d > stop) {
    if (!M.runFrom) M.runFrom = { x: m.x, z: m.z };
    if (Math.hypot(t.x - m.x, t.z - m.z) < 2 && sim.lineOk(m.x, m.z, t.x, t.z, sim.costsFor(sim.moveKey(m)), 99)) {
      sim.stop(m);
      const k = Math.min(monsterSpeed(sim, m) * 1.1, (d - stop) * 10 + 0.05);
      sim.moveToward(m, t.x, t.z, k);
    } else go(sim, m, t.x, t.z, 8);
  } else {
    sim.stop(m);
    m.yaw = Math.atan2(t.x - m.x, t.z - m.z);
  }
}

const PACE: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * The champion is up a cliff where m can't reach or follow (D7): prowl at the foot, roaring, for 1.5 game hours,
 * then give up for an hour. The state stays 'fight' (setState would stop the path every tick). True while besieging.
 */
function besiege(sim: Sim, m: Entity, t: Entity, d: number, hitR: number): boolean {
  const M = m.monster!;
  const sieging = M.besiegeUntil !== undefined;
  const arrived = sieging || !sim.moving(m) || Math.hypot(t.x - m.x, t.z - m.z) < 3;
  if (!(upCliff(sim, m, t) && (!vReachOk(sim, m, t) || d > hitR) && arrived)) {
    clearBesiege(m);
    return false;
  }
  M.besiegeSince ??= sim.tick;
  if (sim.tick - M.besiegeSince < 20) return false;
  if (!sieging) {
    M.besiegeUntil = sim.clockMs + Math.max(1.5 * HOUR_MS, 90_000 * sim.timescale);
    sim.emote(m, '💢', 2);
    sim.stop(m);
  }
  if (sim.clockMs > M.besiegeUntil!) {
    clearBesiege(m);
    m.target = -1;
    M.ignoreChampUntil = sim.clockMs + HOUR_MS;
    setState(sim, m, 'return');
    sim.toast(`${M.seen ? firstName(m) : 'The monster'} gives up and slinks off.`);
    return true;
  }
  // prowl: a few steps along the foot every 8 s (no rng: the offsets follow the clock)
  if ((sim.tick + m.id) % 80 === 0) {
    const [ox, oz] = PACE[Math.floor((sim.tick + m.id) / 80) % 4];
    const n = sim.nearestWalkable(m, m.x + ox, m.z + oz, 2);
    if (n) sim.goTo(m, n.x + 0.5, n.z + 0.5);
  }
  if (sim.moving(m)) sim.advancePath(m, monsterSpeed(sim, m) * 0.5);
  else m.yaw = Math.atan2(t.x - m.x, t.z - m.z);
  return true;
}

/** Telegraph radius as drawn by the renderer: equals the real hit radius. */
export function telegraphRadius(m: Entity): number {
  return reachT(m) + 0.3 / MPT; // tiles, from the front point
}

/** Wind-up progress 0..1 (for the ring and the HUD arc), or -1. */
export function windupProgress(sim: Sim, m: Entity): number {
  const w = m.monster?.windup ?? -1;
  return w < 0 ? -1 : Math.min(1, (sim.tick - w) / 8);
}

void regionName;
void SIZE;
void heightM;
