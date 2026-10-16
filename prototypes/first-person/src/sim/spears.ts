import { hostile } from './team';
// Spears (real items): the champion and the guards carry them, throw them on a ballistic arc, and must pick them up
// again. Nothing makes new ones: the village starts with a rack of them, and a spear that falls into the sea is gone.
// Positions in tiles, heights and velocities in meters (the ground function's units).
import type { Sim } from './sim';
import type { Entity, Zone } from './types';
import { M } from './ground';
import { axisDist, bodyR, feetY, heightM } from './body';
import { applyDamage, armFactor, firstName } from './combat';
import { monsterSpeed } from './monster-ai';
import { cs } from './champion';
import { SIZE } from './world';

export const CHAMP_SPEARS = 3;
export const GUARD_SPEARS = 1;
export const RACK_SPEARS = 6;
const G = 9.8;
const DT = 0.1; // seconds per tick
const SUB = 4;
export const CHAMP_SPEED = 30; // m/s
const GUARD_SPEED = 24;
const PICKUP_T = 1.4 / M; // walk over a spear to take it
const ZONE_H: Record<Zone, number> = { head: 0.9, torso: 0.6, armL: 0.6, armR: 0.6, legL: 0.2, legR: 0.2, sig: 0.65 };

export const spearsOf = (e: Entity) => e.human?.spears ?? 0;
export const spearCap = (sim: Sim, e: Entity) => (e.id === sim.championId ? CHAMP_SPEARS : e.human?.job === 'guard' ? GUARD_SPEARS : 0);

export function spawnSpear(sim: Sim, x: number, z: number, st: 'rack' | 'ground', yaw = 0): Entity {
  const e = sim.spawn({ kind: 'spear', x, z, shape: st === 'rack' ? 'spear-up' : 'spear' });
  e.yaw = yaw;
  e.spear = { st, y: 0, vx: 0, vy: 0, vz: 0, thrower: -1, aimId: -1, aimZone: null, t: 0 };
  return e;
}

/** The village's spear rack: a structure with RACK_SPEARS spears standing in it. */
export function placeRack(sim: Sim) {
  const L = sim.layout;
  const a = L.villageAltar, g = L.granary;
  const open = sim.nearestWalkable('human', (a.x + g.x) / 2 + 0.5, (a.z + g.z) / 2 + 0.5, 4) ?? { x: a.x + 1, z: a.z };
  const yaw = Math.atan2(g.x - a.x, g.z - a.z) + Math.PI / 2;
  const rack = sim.spawn({ kind: 'structure', x: open.x + 0.5, z: open.z + 0.5, shape: 'spear-rack' });
  rack.role = 'spear-rack';
  rack.yaw = yaw;
  const ax = Math.cos(yaw), az = -Math.sin(yaw); // the rack's long axis
  for (let k = 0; k < RACK_SPEARS; k++) {
    const off = ((k - (RACK_SPEARS - 1) / 2) * 0.4) / M;
    spawnSpear(sim, rack.x + ax * off, rack.z + az * off, 'rack', yaw);
  }
}

/** Saves from before spears existed: arm the champion and guards and put up the rack. */
export function ensureSpears(sim: Sim) {
  for (const e of sim.ents.values()) if (e.kind === 'spear' || e.role === 'spear-rack') return;
  placeRack(sim);
  for (const h of sim.humans()) if (h.human!.job === 'guard' || h.id === sim.championId) setSpears(h, 1);
}

export function setSpears(e: Entity, n: number) {
  if (!e.human) return;
  e.human.spears = n;
  if (e.human.job === 'guard' && (e.shape === 'guard' || e.shape === 'guard-bare')) e.shape = n > 0 ? 'guard' : 'guard-bare';
}

/** A human puts down (or dies with) the spears it carried. */
export function dropSpears(sim: Sim, e: Entity) {
  const n = spearsOf(e);
  if (!n) return;
  setSpears(e, 0);
  const at = sim.nearestWalkable('human', e.x, e.z, 3) ?? { x: Math.floor(e.x), z: Math.floor(e.z) };
  const near = Math.floor(e.x) === at.x && Math.floor(e.z) === at.z;
  for (let k = 0; k < n; k++) {
    const yaw = sim.rng.next() * Math.PI * 2;
    spawnSpear(sim, near ? e.x + Math.sin(yaw) * 0.06 : at.x + 0.5, near ? e.z + Math.cos(yaw) * 0.06 : at.z + 0.5, 'ground', yaw);
  }
}

/** Take a spear (rack or ground). Returns an error for the champion's prompt, or null. */
export function takeSpear(sim: Sim, e: Entity, s: Entity): string | null {
  if (!s.spear || s.spear.st === 'flying') return null;
  if (spearsOf(e) >= spearCap(sim, e)) return 'You cannot carry more spears.';
  sim.remove(s);
  const had = spearsOf(e);
  setSpears(e, had + 1);
  if (e.id === sim.championId) {
    // your only spear goes straight into your hand; carrying others, what's in hand stays your choice
    if (!had) cs(sim).wield = 'spear';
    sim.toast(`You take a spear (${spearsOf(e)}/${CHAMP_SPEARS})${had ? '' : ', in hand'}.`);
  }
  return null;
}

/** Rough ground velocity (tiles/s) of a walker, for leading a throw. */
function velOf(sim: Sim, t: Entity): { x: number; z: number } {
  if (!t.monster || !sim.moving(t)) return { x: 0, z: 0 };
  const v = monsterSpeed(sim, t);
  return { x: Math.sin(t.yaw) * v, z: Math.cos(t.yaw) * v };
}

const baseY = (sim: Sim, t: Entity) => sim.ground.y(t.x, t.z) + (t.monster?.alt ?? 0) + t.lift;

/** Launch angles for a ballistic throw from (x, y, z) to (tx, ty, tz) at speed v; the low arc. Null when out of range. */
function solve(x: number, y: number, z: number, tx: number, ty: number, tz: number, v: number): { yaw: number; pitch: number; t: number } | null {
  const d = Math.hypot(tx - x, tz - z) * M;
  const h = ty - y;
  if (d < 0.01) return null;
  const disc = v ** 4 - G * (G * d * d + 2 * h * v * v);
  if (disc < 0) return null;
  const pitch = Math.atan((v * v - Math.sqrt(disc)) / (G * d));
  return { yaw: Math.atan2(tx - x, tz - z), pitch, t: d / (v * Math.cos(pitch)) };
}

/** Aim at a zone of a target, leading its movement. */
function aimAt(sim: Sim, x: number, y: number, z: number, t: Entity, zone: Zone | null, v: number) {
  const vel = velOf(sim, t);
  const hy = baseY(sim, t) + heightM(t) * ZONE_H[zone ?? 'torso'];
  let sol = solve(x, y, z, t.x, hy, t.z, v);
  for (let k = 0; k < 2 && sol; k++) sol = solve(x, y, z, t.x + vel.x * sol.t, hy, t.z + vel.z * sol.t, v) ?? sol;
  return sol;
}

function launch(sim: Sim, thrower: Entity, yaw: number, pitch: number, v: number, aimId: number, aimZone: Zone | null) {
  const x = thrower.x + (Math.sin(yaw) * 0.5) / M, z = thrower.z + (Math.cos(yaw) * 0.5) / M;
  const s = spawnSpear(sim, x, z, 'ground', yaw);
  s.shape = 'spear';
  s.spear = {
    st: 'flying', y: feetY(sim.ground, thrower) + 1.6, // a climber throws from the wall
    vx: Math.sin(yaw) * Math.cos(pitch) * v, vy: Math.sin(pitch) * v, vz: Math.cos(yaw) * Math.cos(pitch) * v,
    thrower: thrower.id, aimId, aimZone, t: 0,
  };
  s.lift = 1.6;
  setSpears(thrower, spearsOf(thrower) - 1);
  sim.sound('swing', thrower.x, thrower.z);
}

/** The champion throws along the view, or (with a target under the crosshair) on the arc that reaches it. */
export function champThrow(sim: Sim, c: Entity, i: { yaw: number; pitch: number; targetId: number | null; zone: Zone | null }): string | null {
  if (spearsOf(c) <= 0) return 'No spears left. Pick one up: the village rack has more.';
  const y = feetY(sim.ground, c) + 1.6;
  const t = i.targetId !== null ? sim.ents.get(i.targetId) : undefined;
  let sol: { yaw: number; pitch: number } | null = null;
  if (t && !t.hidden && t.hp > 0 && (t.inhabitant ? hostile(c,t) : t.tags.includes('hittable')) && Math.hypot(t.x - c.x, t.z - c.z) * M < 100) {
    sol = aimAt(sim, c.x, y, c.z, t, i.zone, CHAMP_SPEED);
    // only help a throw that is already pointed at the target
    if (sol) {
      let dy = sol.yaw - i.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      if (Math.abs(dy) > 0.2) sol = null;
    }
  }
  if (!sol) sol = { yaw: i.yaw, pitch: Math.max(-1.2, Math.min(1.3, i.pitch + 0.05)) };
  launch(sim, c, sol.yaw, sol.pitch, CHAMP_SPEED, t?.id ?? -1, i.zone);
  return null;
}

/** A guard throws at a monster, a little wide. False when the throw can't reach. */
export function guardThrow(sim: Sim, g: Entity, m: Entity): boolean {
  const sol = aimAt(sim, g.x, sim.ground.y(g.x, g.z) + 1.6, g.z, m, 'torso', GUARD_SPEED);
  if (!sol) return false;
  g.yaw = sol.yaw;
  launch(sim, g, sol.yaw + (sim.rng.next() - 0.5) * 0.08, sol.pitch + (sim.rng.next() - 0.5) * 0.04, GUARD_SPEED, m.id, 'torso');
  sim.emote(g, '🗡️', 1);
  return true;
}

function hittable(sim: Sim, e: Entity, s: Entity): boolean {
  if (e === s || e.hidden || e.hp <= 0 || e.carriedBy !== undefined) return false;
  const thrower = sim.ents.get(s.spear!.thrower);
  if (e.inhabitant) return !!thrower && hostile(thrower,e) && e.state !== 'downed' && e.state !== 'bound';
  return e.tags.includes('hittable');
}

const isOpen = (sim: Sim, x: number, z: number) => !!sim.grid.defs.get(sim.grid.get(Math.floor(x), Math.floor(z)))?.walkable;

function land(sim: Sim, s: Entity, champ: boolean) {
  const S = s.spear!;
  const tile = sim.grid.get(Math.floor(s.x), Math.floor(s.z));
  if (tile === 'deep-water' || tile === 'shallow-water') {
    sim.remove(s);
    if (champ) sim.toast('Your spear sinks into the sea.');
    return;
  }
  if (!isOpen(sim, s.x, s.z)) {
    // struck a wall or a house: it falls at its foot
    const n = sim.nearestWalkable('human', s.x - (S.vx * DT) / M, s.z - (S.vz * DT) / M, 3);
    if (n) { s.x = n.x + 0.5; s.z = n.z + 0.5; }
  }
  S.st = 'ground';
  S.vx = S.vy = S.vz = 0;
  s.lift = 0;
  s.shape = 'spear';
}

/** Per tick: fly, hit, land; and the champion picks up spears he walks over. */
export function stepSpear(sim: Sim, s: Entity) {
  const S = s.spear;
  if (!S) return;
  if (S.st !== 'flying') {
    if (S.st === 'ground' && sim.tick % 2 === 0) {
      const c = sim.champion();
      if (c && c.state !== 'downed' && c.state !== 'captive' && Math.hypot(c.x - s.x, c.z - s.z) < PICKUP_T && spearsOf(c) < CHAMP_SPEARS && (!sim.grid.base || Math.abs(feetY(sim.ground, c) - feetY(sim.ground, s)) < 3)) takeSpear(sim, c, s);
    }
    return;
  }
  const thrower = sim.ents.get(S.thrower);
  const champ = S.thrower === sim.championId;
  S.t++;
  for (let k = 0; k < SUB; k++) {
    const dt = DT / SUB;
    s.x += (S.vx * dt) / M;
    s.z += (S.vz * dt) / M;
    S.vy -= G * dt;
    S.y += S.vy * dt;
    if (s.x < 0 || s.z < 0 || s.x >= SIZE || s.z >= SIZE) {
      s.x = Math.min(SIZE - 0.01, Math.max(0, s.x));
      s.z = Math.min(SIZE - 0.01, Math.max(0, s.z));
      return land(sim, s, champ);
    }
    // a body in the way
    for (const e of sim.ents.values()) {
      if (!hittable(sim, e, s) || Math.abs(e.x - s.x) > 1 || Math.abs(e.z - s.z) > 1) continue;
      const b = baseY(sim, e);
      const top = b + heightM(e);
      if (S.y < b - 0.3 || S.y > top + 0.3) continue;
      if (axisDist(e, s.x, s.z) > bodyR(e) + 0.25 / M) continue;
      return strike(sim, s, e, thrower, (S.y - b) / Math.max(0.1, top - b));
    }
    if (S.y <= sim.ground.y(s.x, s.z)) return land(sim, s, champ);
  }
  s.yaw = Math.atan2(S.vx, S.vz);
  s.lift = Math.max(0, S.y - sim.ground.y(s.x, s.z));
  if (S.t > 80) land(sim, s, champ);
}

function strike(sim: Sim, s: Entity, t: Entity, thrower: Entity | undefined, h: number) {
  const S = s.spear!;
  let zone: Zone | undefined;
  if (t.id === S.aimId && S.aimZone && t.zones?.[S.aimZone]) zone = S.aimZone;
  else if (t.zones) zone = h > 0.82 ? 'head' : h < 0.4 ? (sim.rng.chance(0.5) ? 'legL' : 'legR') : 'torso';
  const champ = thrower && thrower.id === sim.championId;
  let dmg = champ ? 24 * (1 + 0.1 * (thrower.level - 1)) : 12;
  if (thrower) dmg *= sim.stat(thrower, 'strength') * armFactor(thrower);
  if (zone === 'head') dmg *= 1.5;
  const r = applyDamage(sim, t, dmg, { type: 'pierce', sourceId: thrower?.id, zone });
  if (thrower && t.monster && sim.ents.has(t.id) && t.state !== 'downed' && t.state !== 'bound') {
    t.target = thrower.id;
    if (champ) delete t.monster.ignoreChampUntil; // hit it and the fight is back on
    if (t.state === 'rest') t.state = 'fight';
  }
  if (champ) {
    cs(sim).combat.push({ kind: 'hit', id: t.id, zone: r.zone, x: t.x, z: t.z, killed: r.killed, severed: r.severed, downed: r.downed, amount: Math.round(r.dealt) });
    if (t.monster && !r.killed) sim.toast(`Your spear strikes ${t.monster.seen ? firstName(t) : 'it'}${zone === 'head' ? ' in the head' : ''}!`);
  }
  // the spear falls at the beast's feet
  s.x = t.x + (sim.rng.next() - 0.5) * 0.1;
  s.z = t.z + (sim.rng.next() - 0.5) * 0.1;
  land(sim, s, !!champ);
}

// ---------- guards ----------

/** An unarmed guard with no monster close by goes for the nearest safe spear. True while busy with it. */
export function guardFetch(sim: Sim, g: Entity): boolean {
  const H = g.human!;
  if (spearsOf(g) >= GUARD_SPEARS) {
    H.fetchSpear = undefined;
    return false;
  }
  const monsterNear = (x: number, z: number, r: number) => sim.monsters().some((m) => m.state !== 'downed' && m.state !== 'bound' && Math.hypot(m.x - x, m.z - z) < r);
  if (monsterNear(g.x, g.z, 3)) return false;
  let s = H.fetchSpear !== undefined ? sim.ents.get(H.fetchSpear) : undefined;
  if (!s?.spear || s.spear.st === 'flying') s = undefined;
  if (!s && sim.tick % 10 === g.id % 10) {
    const V = sim.layout.village;
    const claimed = new Set<number>();
    for (const o of sim.humans()) if (o !== g && o.human!.fetchSpear !== undefined) claimed.add(o.human!.fetchSpear);
    let best: Entity | undefined, bd = Infinity;
    for (const e of sim.ents.values()) {
      if (!e.spear || e.spear.st === 'flying' || claimed.has(e.id)) continue;
      if (Math.hypot(e.x - V.x, e.z - V.z) > 30 || monsterNear(e.x, e.z, 5)) continue;
      // lying spears first, then the rack
      const d = Math.hypot(e.x - g.x, e.z - g.z) + (e.spear.st === 'rack' ? 20 : 0);
      if (d < bd) { bd = d; best = e; }
    }
    s = best;
    H.fetchSpear = s?.id;
  }
  if (!s) return false;
  g.state = 'fetch-spear';
  if (Math.hypot(s.x - g.x, s.z - g.z) < 0.35) {
    takeSpear(sim, g, s);
    H.fetchSpear = undefined;
    sim.stop(g);
    return true;
  }
  if (!sim.moving(g) && !sim.goTo(g, s.x, s.z)) {
    H.fetchSpear = undefined;
    return false;
  }
  sim.advancePath(g, sim.stat(g, 'speed') * 1.1);
  return true;
}
