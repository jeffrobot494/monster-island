// The player's champion in first person (spec §4–5, F6–F10, F31): pose messages from the client-side controller,
// swings with a client-chosen target and zone, dodge i-frames, block, interact, finish, torch; hold and autopilot
// modes when the player isn't driving; dragging along a breadcrumb trail; regeneration; succession.
import type { Sim } from './sim';
import type { Entity, Zone } from './types';
import { applyDamage, armFactor, firstName, heal, legFactor, releaseDragged, kill, spawnSevered } from './combat';
import { JOB_TINT } from './core-defs';
import { doorOf } from './village';
import { M, WATER_Y } from './ground';
import { axisDist, axisPoint, bearingOff, bodyR, champReachable, feetY, frontPoint, heightM } from './body';
import { champThrow, spearsOf, takeSpear } from './spears';
import { capZone, climbable, RIDE } from './climb-body';

/** Internal orders: used by autopilot and by dev/test scripts. */
export type Order =
  | { type: 'move'; x: number; z: number }
  | { type: 'attack'; id: number; idle?: boolean }
  | { type: 'finish'; id: number }
  | { type: 'bind'; id: number }
  | { type: 'drag'; id: number }
  | { type: 'drop' }
  | { type: 'altar' };

export type ChampInput =
  | { type: 'pose'; x: number; z: number; yaw: number; pitch: number; epoch: number; input: boolean; fly?: boolean; alt?: number; climb?: 'wall' | 'perch' | 'mount'; mount?: { id: number; cap: number } }
  /** the client landed hard (impact m/s; > 13 hurts), at (x, z): falls are client physics, damage is the sim's */
  | { type: 'land'; impact: number; x?: number; z?: number }
  | { type: 'swing'; yaw: number; pitch: number; targetId: number | null; zone: Zone | null }
  | { type: 'throw'; yaw: number; pitch: number; targetId: number | null; zone: Zone | null }
  /** what's in hand: the sword (and shield), or a spear to thrust and throw */
  | { type: 'wield'; weapon: Wield }
  | { type: 'dodge' }
  | { type: 'block'; on: boolean }
  | { type: 'interact'; id: number | null }
  | { type: 'finish'; id: number | null }
  | { type: 'torch'; on: boolean }
  | { type: 'lock'; on: boolean };

export type Wield = 'sword' | 'spear';

export type CtrlReason = 'player' | 'hold' | 'autopilot' | 'downed' | 'captive' | 'dead';

export interface CombatEvent {
  /** shake: a ridden body's shake landed while you held on (amount: the stamina it costs); thrown: off it (hard: its
   *  grab), x/z: the body's position, to fly away from */
  kind: 'hit' | 'whiff' | 'blocked' | 'hurt' | 'dodged' | 'shake' | 'thrown';
  hard?: boolean;
  id?: number;
  zone?: string;
  x?: number;
  z?: number;
  killed?: boolean;
  severed?: boolean;
  downed?: boolean;
  amount?: number;
}

const SUCCESSION_TICKS = 36_000; // 1 real hour (R21)
const IDLE_TICKS = 3000; // 5 real minutes (R19, F9)
export const SWORD_M = 2.4;
/** a spear's thrust: a meter more reach than the sword, on a narrower line */
export const SPEAR_M = 3.4;
export const INTERACT_M = 3.0;
const SPRINT_MS = 8.8;
const CRAWL_MS = 0.8;

interface ChampState {
  lastInput: number;
  lastThreat: number;
  swingReady: number;
  diedTick: number;
  altarNotified: boolean;
  /** the sword's damage (the gods can bless it: api.champion.setWeapon) */
  weapon: { type: string; mul: number };
  /** in hand: the sword, or one of the spears carried (none left, it's the sword again) */
  wield: Wield;
  epoch: number;
  locked: boolean;
  blocking: boolean;
  torch: boolean;
  iframesUntil: number;
  dodgeTick: number;
  lastPoseTick: number;
  pitch: number;
  /** recent accepted poses for favorable release checks (F7) */
  poses: { tick: number; x: number; z: number; yaw: number; alt?: number }[];
  /** breadcrumb trail for dragging (F8), oldest first */
  trail: { x: number; z: number }[];
  reason: CtrlReason;
  correction: { x: number; z: number; epoch: number; alt?: number } | null;
  /** tick of the last hard landing (one fall, one hurt) */
  landTick?: number;
  combat: CombatEvent[];
  ambushed: number[];
  /** thrown off monster `id`: mount poses on it are latency until `until` (tick) and are ignored */
  unmount?: { id: number; until: number };
}

export function cs(sim: Sim): ChampState {
  const s = sim as unknown as { champState?: ChampState };
  return (s.champState ??= {
    lastInput: 0, lastThreat: -9999, swingReady: 0, diedTick: 0, altarNotified: false, weapon: { type: 'slash', mul: 1 },
    wield: 'sword', epoch: 1, locked: true, blocking: false, torch: false, iframesUntil: 0, dodgeTick: -99, lastPoseTick: 0, pitch: 0,
    poses: [], trail: [], reason: 'player', correction: null, combat: [], ambushed: [],
  });
}

export function champReach(t: Entity) {
  return SWORD_M / M + bodyR(t);
}

/** Who moves the champion right now. */
export function ctrlReason(sim: Sim): CtrlReason {
  const c = sim.champion();
  if (!c) return 'dead';
  if (c.state === 'captive' || c.carriedBy !== undefined) return 'captive';
  if (c.state === 'downed') return 'downed';
  if (sim.order) return 'autopilot';
  if (!cs(sim).locked) return 'hold';
  return 'player';
}

export function isPlayerCtrl(r: CtrlReason) {
  return r === 'player' || r === 'downed';
}

/** Speed multiplier the client applies to walk/sprint (legs, stat mods). Dragging doesn't slow the champion. */
export function champSpeedMul(sim: Sim): number {
  const c = sim.champion();
  if (!c) return 1;
  return (sim.stat(c, 'speed') / 1.1) * legFactor(c);
}

/** Dev/test: give the champion an internal order (it runs in sim mode). */
export function issueOrder(sim: Sim, o: Order) {
  const c = sim.champion();
  if (!c || c.state === 'downed' || c.state === 'captive') return;
  const S = cs(sim);
  S.lastInput = sim.tick;
  if (o.type === 'drop') {
    if (sim.dragging >= 0) releaseDragged(sim);
    return;
  }
  if (o.type === 'altar') S.altarNotified = false;
  sim.order = o;
  sim.stop(c);
}

function correct(sim: Sim, c: Entity) {
  const S = cs(sim);
  S.epoch++;
  S.correction = { x: c.x, z: c.z, epoch: S.epoch };
  if (c.human?.alt) S.correction.alt = c.human.alt;
}

/** Forget any climbing: height, how, and the monster being ridden. */
export function clearClimb(c: Entity) {
  if (!c.human) return;
  delete c.human.alt;
  delete c.human.climb;
  delete c.human.mount;
}

/** Off the cliff and back on the ground: for autopilot, captivity and loading (docs/climbing-phase1-plan.md, D3). */
export function groundChampion(sim: Sim, c: Entity) {
  const onCliff = sim.grid.get(Math.floor(c.x), Math.floor(c.z)) === 'cliff';
  if (onCliff || (c.human?.alt ?? 0) > 0) {
    if (!sim.walkableFor(c, c.x, c.z)) {
      const n = sim.nearestWalkable(c, c.x, c.z, 24);
      if (n) {
        c.x = n.x + 0.5;
        c.z = n.z + 0.5;
      } else {
        const V = sim.layout.village;
        c.x = V.x + 0.5;
        c.z = V.z + 1.5;
      }
      sim.stop(c);
    }
  }
  clearClimb(c);
}

/** A hard landing (D4): leg damage, or death from high enough; deep water breaks the fall. */
function land(sim: Sim, c: Entity, i: { impact: number; x?: number; z?: number }, reason: CtrlReason) {
  const S = cs(sim);
  const impact = Math.min(60, Math.max(0, Number(i.impact) || 0));
  if (impact <= 13 || sim.tick - (S.landTick ?? -99) < 5) return;
  S.landTick = sim.tick;
  if (reason === 'hold') {
    // in hold mid-fall (the pointer free): the client finished the fall, so the champion is where it landed
    if (Number.isFinite(i.x) && Number.isFinite(i.z) && (sim.walkableFor(c, i.x!, i.z!) || sim.grid.get(Math.floor(i.x!), Math.floor(i.z!)) === 'cliff')) {
      c.x = Math.min(127.99, Math.max(0, i.x!));
      c.z = Math.min(127.99, Math.max(0, i.z!));
    }
    clearClimb(c);
  } else if (c.human) {
    // on whatever it landed on: the client's next pose says how high that is (a floating isle is 140 m up; clearing
    // the height here made that pose an impossible climb, and the correction dropped the champion to the ground)
    delete c.human.climb;
    delete c.human.mount;
  }
  // deep water breaks the fall (at the surface: the height over water is above the seabed)
  const gy = sim.ground.y(c.x, c.z);
  if (WATER_Y - gy >= 1 && gy + (c.human?.alt ?? 0) <= WATER_Y + 1) return;
  const before = c.hp;
  if (impact > 28) applyDamage(sim, c, 9999, { type: 'crush', zone: 'torso', sourceId: -1, deathType: 'crushed' });
  else {
    const d = (impact - 13) * 4;
    applyDamage(sim, c, d / 2, { type: 'crush', zone: 'legL', sourceId: -1, deathType: 'crushed' });
    applyDamage(sim, c, d / 2, { type: 'crush', zone: 'legR', sourceId: -1, deathType: 'crushed' });
  }
  const dealt = Math.max(0, before - Math.max(0, c.hp));
  if (dealt > 0) sim.out.hurt = (sim.out.hurt ?? 0) + dealt;
  if (sim.ents.has(c.id) && c.hp > 0) sim.toast('You land badly.');
}

function pushTrail(S: ChampState, x: number, z: number) {
  const t = S.trail;
  const last = t[t.length - 1];
  if (last && Math.hypot(last.x - x, last.z - z) < 0.05) return;
  t.push({ x, z });
  if (t.length > 80) t.shift();
}

/** Apply queued client input at the start of a tick, in arrival order (§9.3). */
export function processInputs(sim: Sim) {
  const S = cs(sim);
  const list = sim.inputs;
  sim.inputs = [];
  const c = sim.champion();
  if (S.wield === 'spear' && (!c || spearsOf(c) <= 0)) S.wield = 'sword';
  for (const i of list) {
    if (i.type === 'lock') {
      S.locked = i.on;
      if (i.on) S.lastInput = sim.tick;
      else S.blocking = false;
      continue;
    }
    if (i.type === 'torch') {
      S.torch = i.on;
      if (i.on) S.blocking = false;
      continue;
    }
    if (!c) continue;
    const reason = ctrlReason(sim);
    if (i.type === 'pose') {
      if (i.input) {
        S.lastInput = sim.tick;
        if (reason === 'autopilot' && sim.order) {
          // the player takes the wheel back; the client snaps on the new epoch
          sim.order = null;
          sim.stop(c);
          S.epoch++;
          continue;
        }
      }
      if (i.epoch !== S.epoch || !isPlayerCtrl(reason)) continue;
      applyPose(sim, c, i);
      continue;
    }
    if (i.type === 'land') {
      if (isPlayerCtrl(reason) || reason === 'hold') land(sim, c, i, reason);
      continue;
    }
    S.lastInput = sim.tick;
    if (reason !== 'player') continue;
    switch (i.type) {
      case 'swing': swing(sim, c, i); break;
      case 'throw':
        if (c.state === 'downed' || sim.dragging >= 0 || sim.tick < S.swingReady - 1) break;
        // on a body it's a thrust with the spear in hand (left mouse); right mouse is holding on
        if (c.human?.mount) break;
        S.swingReady = sim.tick + 8;
        S.blocking = false;
        sim.actionError = champThrow(sim, c, i);
        if (spearsOf(c) <= 0) S.wield = 'sword';
        break;
      case 'wield':
        if (i.weapon === 'spear' && spearsOf(c) <= 0) sim.actionError = 'No spears. Pick one up where it fell, or take one from the village rack.';
        else {
          S.wield = i.weapon === 'spear' ? 'spear' : 'sword';
        }
        break;
      case 'dodge':
        S.iframesUntil = sim.tick + 3;
        S.dodgeTick = sim.tick;
        break;
      case 'block':
        // on a monster it's holding on (docs/climbing-phase4-plan.md), which a torch doesn't stop
        S.blocking = i.on && (!S.torch || !!c.human?.mount) && sim.dragging < 0;
        break;
      case 'interact': sim.actionError = interact(sim, c, i.id); break;
      case 'finish': sim.actionError = finish(sim, c, i.id); break;
    }
  }
}

function applyPose(sim: Sim, c: Entity, p: { x: number; z: number; yaw: number; pitch: number; fly?: boolean; alt?: number; climb?: 'wall' | 'perch' | 'mount'; mount?: { id: number; cap: number } }) {
  const S = cs(sim);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.yaw)) return;
  if (p.fly) clearClimb(c);
  if (p.fly) {
    // dev fly mode: anywhere, any speed, and nothing can touch you up there
    S.iframesUntil = sim.tick + 5;
    S.lastPoseTick = sim.tick;
    c.x = Math.min(127.99, Math.max(0, p.x));
    c.z = Math.min(127.99, Math.max(0, p.z));
    c.yaw = p.yaw;
    S.pitch = p.pitch;
    return;
  }
  if (p.climb === 'mount') {
    mountPose(sim, c, p);
    return;
  }
  if (S.unmount && sim.tick >= S.unmount.until) delete S.unmount;
  const downed = c.state === 'downed';
  // climbing (terraformer islands only): the client reports the feet's height and whether it's on a wall or a cliff
  const terrain = !!sim.grid.base;
  const alt = terrain && Number.isFinite(p.alt) ? Math.min(300, Math.max(0, p.alt!)) : 0;
  const climb = terrain && (p.climb === 'wall' || p.climb === 'perch') ? p.climb : undefined;
  let max = downed ? CRAWL_MS : SPRINT_MS * Math.max(0.3, champSpeedMul(sim)) * 1.15;
  if (climb === 'wall') max = Math.max(max, 9.5); // lunges are 8 m/s whatever the legs
  if (sim.tick - S.dodgeTick <= 4) max += 17.5;
  const elapsed = Math.min(0.25, Math.max(0.1, (sim.tick - S.lastPoseTick) * 0.1));
  const d = Math.hypot(p.x - c.x, p.z - c.z);
  const sameTile = Math.floor(p.x) === Math.floor(c.x) && Math.floor(p.z) === Math.floor(c.z);
  // the feet's rise: of alt, or of their absolute height (walking along an arch over a valley raises alt, not the feet)
  const oldAlt = c.human?.alt ?? 0;
  const rise = Math.min(alt - oldAlt, terrain ? sim.ground.y(p.x, p.z) + alt - (sim.ground.y(c.x, c.z) + oldAlt) : 0);
  const ok = (sameTile || sim.walkableFor(c, p.x, p.z) || climbTile(sim, p.x, p.z, climb, alt)) && d <= (1.6 * max * elapsed) / M + 0.2 && rise <= 10 * elapsed + 1;
  S.lastPoseTick = sim.tick;
  if (!ok) {
    correct(sim, c);
    return;
  }
  c.x = Math.min(127.99, Math.max(0, p.x));
  c.z = Math.min(127.99, Math.max(0, p.z));
  c.yaw = p.yaw;
  S.pitch = p.pitch;
  if (terrain && c.human) {
    if (alt > 0) c.human.alt = alt;
    else delete c.human.alt;
    if (climb) c.human.climb = climb;
    else delete c.human.climb;
    delete c.human.mount;
  }
  S.poses.push({ tick: sim.tick, x: c.x, z: c.z, yaw: c.yaw, ...(alt > 0 ? { alt } : {}) });
  if (S.poses.length > 6) S.poses.shift();
}

/**
 * On a monster (docs/climbing-phase3-plan.md, Part D): the monster moves the rider, so instead of the walk and speed
 * rules the pose must be on a live, climbable monster, within its height of it and no higher than its top + 1 m.
 * Terraformer islands only (elsewhere the pose is ignored, like a climb's height).
 */
function mountPose(sim: Sim, c: Entity, p: { x: number; z: number; yaw: number; pitch: number; alt?: number; mount?: { id: number; cap: number } }) {
  const S = cs(sim);
  if (!sim.grid.base || !c.human) return;
  S.lastPoseTick = sim.tick;
  // just thrown off it: these poses were sent before the client heard
  if (S.unmount && S.unmount.id === p.mount?.id && sim.tick < S.unmount.until) return;
  const m = p.mount && Number.isInteger(p.mount.id) ? sim.ents.get(p.mount.id) : undefined;
  const alt = Number.isFinite(p.alt) ? Math.min(300, Math.max(0, p.alt!)) : 0;
  // the client draws the body a few ticks behind the sim: allow for how far it moves meanwhile (half a second at full
  // speed), and for a flyer's dive (14 m/s)
  const lag = m ? m.monster && RIDE[m.monster.archetype]?.flies ? 7 : 0 : 0;
  const ok = !!m && m.kind === 'monster' && m.hp > 0 && !m.hidden && m.state !== 'bound' && climbable(m.monster?.archetype) && Number.isInteger(p.mount!.cap) &&
    Math.hypot(p.x - m.x, p.z - m.z) <= heightM(m) / M + 0.3 + sim.stat(m, 'speed') * legFactor(m) * 0.5 &&
    sim.ground.y(p.x, p.z) + alt <= feetY(sim.ground, m) + heightM(m) + 1 + lag;
  if (!ok) {
    correct(sim, c);
    return;
  }
  c.x = Math.min(127.99, Math.max(0, p.x));
  c.z = Math.min(127.99, Math.max(0, p.z));
  c.yaw = p.yaw;
  S.pitch = p.pitch;
  if (alt > 0) c.human.alt = alt;
  else delete c.human.alt;
  c.human.climb = 'mount';
  c.human.mount = { id: m!.id, cap: p.mount!.cap };
  S.poses.push({ tick: sim.tick, x: c.x, z: c.z, yaw: c.yaw, ...(alt > 0 ? { alt } : {}) });
  if (S.poses.length > 6) S.poses.shift();
}

/** Where a climber may be: a cliff tile, or water below one (a sea-cliff foot), or beside a cliff while on the wall. */
function climbTile(sim: Sim, x: number, z: number, climb: 'wall' | 'perch' | undefined, alt: number): boolean {
  if (!climb && alt <= 0.3) return false;
  const ix = Math.floor(x), iz = Math.floor(z);
  const t = sim.grid.get(ix, iz);
  if (t === 'cliff' || (t.endsWith('water') && (climb || alt > 0.3))) return true;
  if (t === 'wall' || t === 'house') return false;
  if (alt > 3) return true; // up on the feature mesh (an arch span) over any other tile
  if (climb !== 'wall') return false;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (sim.grid.get(ix + dx, iz + dz) === 'cliff') return true;
  return false;
}

/**
 * A blow with what's in hand. The sword: 12 a swing every 0.6 s, the gods' blessing on it, reach 2.4 m and a wide arc.
 * The spear's thrust: 15 every 0.8 s, piercing, reach 3.4 m on a narrow line (±30° for the target under the
 * crosshair, ±20° for the nearest one).
 */
function blowOf(sim: Sim, c: Entity) {
  const S = cs(sim);
  const k = (1 + 0.1 * (c.level - 1)) * sim.stat(c, 'strength') * armFactor(c);
  return S.wield === 'spear'
    ? { reach: SPEAR_M, arc: 30, near: 20, dmg: 15 * k, type: 'pierce', ticks: 8 }
    : { reach: SWORD_M, arc: 70, near: 50, dmg: 12 * k * S.weapon.mul, type: S.weapon.type, ticks: 6 };
}

function swing(sim: Sim, c: Entity, i: { yaw: number; targetId: number | null; zone: Zone | null }) {
  const S = cs(sim);
  // the client paces swings at 0.6 s (thrusts at 0.8 s); allow a tick of jitter
  if (c.state === 'downed' || sim.dragging >= 0 || sim.tick < S.swingReady - 1) return;
  const w = blowOf(sim, c);
  S.swingReady = sim.tick + w.ticks;
  S.blocking = false;
  if (c.human?.mount) return strikeFromBody(sim, c, w.dmg, w.type);
  const ok = (t: Entity | undefined): t is Entity => {
    if (!t || t.hp <= 0 || !sim.ents.has(t.id)) return false;
    const hittable = t.kind === 'monster' ? t.state !== 'downed' && t.state !== 'bound' : t.tags.includes('hittable');
    if (!hittable || t.hidden) return false;
    const p = axisPoint(t, c.x, c.z);
    const dist = axisDist(t, c.x, c.z) - bodyR(t);
    if (sim.grid.base) {
      // the weapon's vertical band, from the champion's hand
      const hand = feetY(sim.ground, c) + 1.65, ft = feetY(sim.ground, t);
      if (ft > hand + w.reach || ft + heightM(t) < hand - w.reach) return false;
    }
    return dist <= (w.reach + 1.0) / M && bearingOff(i.yaw, c.x, c.z, p.x, p.z) <= (w.arc * Math.PI) / 180 + Math.atan2(bodyR(t), Math.max(0.05, Math.hypot(p.x - c.x, p.z - c.z)));
  };
  let t = i.targetId !== null ? sim.ents.get(i.targetId) : undefined;
  let zone: Zone | undefined = i.zone ?? undefined;
  if (!ok(t)) {
    // fallback: nearest bearing within the narrower arc and plain reach
    t = undefined;
    zone = undefined;
    let best = Infinity;
    for (const m of sim.ents.values()) {
      if (m.kind !== 'monster' || !ok(m)) continue;
      const p = axisPoint(m, c.x, c.z);
      const off = bearingOff(i.yaw, c.x, c.z, p.x, p.z);
      if (off > (w.near * Math.PI) / 180 || axisDist(m, c.x, c.z) - bodyR(m) > w.reach / M) continue;
      if (off < best) { best = off; t = m; }
    }
  }
  if (!t) {
    S.combat.push({ kind: 'whiff' });
    return;
  }
  if (zone && t.zones && !t.zones[zone]) zone = undefined;
  let dmg = w.dmg;
  if (zone === 'head') dmg *= 1.5;
  let mul = 1;
  if (t.monster && t.state === 'rest' && !S.ambushed.includes(t.id)) {
    mul = 2;
    S.ambushed.push(t.id);
    sim.toast(`You catch ${t.monster.seen ? firstName(t) : 'it'} resting in its lair. Double damage!`);
  }
  if (t.monster && t.state !== 'downed') {
    t.target = c.id;
    delete t.monster.ignoreChampUntil; // hit it and the fight is back on
  }
  const r = applyDamage(sim, t, dmg, { type: w.type, sourceId: c.id, mul, zone });
  if (t.monster && sim.ents.has(t.id) && t.state === 'rest') t.state = 'fight';
  S.combat.push({ kind: 'hit', id: t.id, zone: r.zone, x: t.x, z: t.z, killed: r.killed, severed: r.severed, downed: r.downed, amount: Math.round(r.dealt) });
}

/**
 * A blow from a monster's body (docs/climbing-phase4-plan.md, Part B): it lands on the zone of the capsule you're on,
 * doubled; on the head tripled, and it staggers the monster for 2 s. No reach or arc test: you're on it.
 */
function strikeFromBody(sim: Sim, c: Entity, base: number, type: string) {
  const S = cs(sim);
  const t = sim.ents.get(c.human!.mount!.id);
  if (!t?.monster || t.hp <= 0 || t.hidden || t.state === 'downed' || t.state === 'bound') {
    S.combat.push({ kind: 'whiff' });
    return;
  }
  let zone = capZone(t.monster.archetype, c.human!.mount!.cap) ?? undefined;
  if (zone && t.zones && (!t.zones[zone] || t.zones[zone]!.state === 'severed')) zone = undefined;
  const head = zone === 'head';
  t.target = c.id;
  delete t.monster.ignoreChampUntil;
  const r = applyDamage(sim, t, base * (head ? 3 : 2), { type, sourceId: c.id, zone });
  if (head && sim.ents.has(t.id) && t.hp > 0 && t.state !== 'downed') {
    t.monster.staggerUntil = sim.tick + 20;
    t.monster.windup = -1;
    delete t.monster.grabbing;
    if (t.monster.ride) t.monster.ride.shakeAt = -1;
    sim.emote(t, '💫', 2);
  }
  if (sim.ents.has(t.id) && t.state === 'rest') t.state = 'fight';
  S.combat.push({ kind: 'hit', id: t.id, zone: r.zone, x: t.x, z: t.z, killed: r.killed, severed: r.severed, downed: r.downed, amount: Math.round(r.dealt) });
}


function near(sim: Sim, c: Entity, t: Entity, m = INTERACT_M) {
  if (sim.grid.base && Math.abs(feetY(sim.ground, t) - feetY(sim.ground, c)) >= 3) return false;
  return axisDist(t, c.x, c.z) - bodyR(t) <= m / M;
}

function bind(sim: Sim, c: Entity, t: Entity) {
  const S = cs(sim);
  if (sim.dragging >= 0 && sim.dragging !== t.id) releaseDragged(sim);
  if (t.kind === 'monster') {
    if (t.state !== 'bound') sim.log(`You bind ${t.name}. Drag it home to the altar.`, 2, 'core', 'bind');
    t.state = 'bound';
    t.stateUntil = 0;
    t.roll = 1;
    sim.stop(t);
  }
  sim.dragging = t.id;
  S.blocking = false;
  S.altarNotified = false;
  S.trail = [{ x: t.x, z: t.z }, { x: c.x, z: c.z }];
  sim.sound('bind', t.x, t.z);
}

function interact(sim: Sim, c: Entity, id: number | null): string | null {
  if (sim.dragging >= 0) {
    releaseDragged(sim);
    sim.toast('You let go.');
    return null;
  }
  const t = id !== null ? sim.ents.get(id) : undefined;
  if (!t) return null;
  if (t.kind === 'spear') {
    if (!near(sim, c, t)) return 'Too far away.';
    return takeSpear(sim, c, t);
  }
  if ((t.kind === 'monster' && (t.state === 'downed' || t.state === 'bound')) || t.kind === 'corpse') {
    if (!near(sim, c, t)) return 'Too far away.';
    bind(sim, c, t);
    return null;
  }
  if (t.kind === 'human' && t.id !== c.id && !t.hidden) {
    const lines = (t.human?.bio ?? '').split('. ').filter(Boolean);
    sim.emote(t, lines.length ? lines[sim.rng.int(0, lines.length - 1)].replace(/\.?$/, '.') : '…', 3, true);
  }
  return null;
}

function finish(sim: Sim, c: Entity, id: number | null): string | null {
  const t = id !== null ? sim.ents.get(id) : undefined;
  if (!t || t.kind !== 'monster' || (t.state !== 'downed' && t.state !== 'bound')) return 'Nothing to finish.';
  if (!near(sim, c, t)) return 'Too far away.';
  if (sim.dragging === t.id) releaseDragged(sim);
  if (t.zones?.head) t.zones.head.state = 'severed';
  spawnSevered(sim, t, 'head');
  cs(sim).combat.push({ kind: 'hit', id: t.id, zone: 'head', x: t.x, z: t.z, killed: true, severed: true });
  kill(sim, t, { amount: 999, type: 'slash', zone: 'head', sourceId: c.id, sourceKind: 'human', deathType: 'dismembered' });
  return null;
}

/** Monster release against the champion (F7, F29): i-frames, the most favorable recent pose, block. */
export function releaseOnChampion(sim: Sim, m: Entity, c: Entity, hitR: number): 'iframe' | 'miss' | 'block' | 'hit' {
  const S = cs(sim);
  if (sim.tick <= S.iframesUntil) return 'iframe';
  // its rider is beyond its blows: it shakes and grabs instead (monster-ai.ts, ridden)
  if (c.human?.mount?.id === m.id) return 'miss';
  const fp = frontPoint(m);
  const arc = (50 * Math.PI) / 180;
  const recent = S.poses.filter((p) => sim.tick - p.tick <= 2);
  const cands = recent.length && isPlayerCtrl(S.reason) ? recent : [{ tick: sim.tick, x: c.x, z: c.z, yaw: c.yaw, alt: c.human?.alt }];
  for (const p of cands) {
    if (sim.grid.base && !champReachable(sim.ground, m, c, sim.ground.y(p.x, p.z) + (p.alt ?? 0))) return 'miss';
    const out = Math.hypot(p.x - fp.x, p.z - fp.z) > hitR;
    const behind = bearingOff(m.yaw, m.x, m.z, p.x, p.z) > arc + Math.atan2(bodyR(c), Math.max(0.05, Math.hypot(p.x - m.x, p.z - m.z)));
    if (out || behind) return 'miss';
  }
  // holding on to a body isn't a shield up
  if (S.blocking && !c.human?.mount && bearingOff(c.yaw, c.x, c.z, m.x, m.z) <= (60 * Math.PI) / 180) return 'block';
  return 'hit';
}

function placeDragged(sim: Sim, c: Entity) {
  const S = cs(sim);
  const d = sim.ents.get(sim.dragging);
  if (!d) {
    sim.dragging = -1;
    return;
  }
  // walk back along the trail by 1.5 m + body radius (F8)
  let need = 1.5 / M + bodyR(d) + 0.3 / M;
  let px = c.x, pz = c.z;
  let found = false;
  for (let k = S.trail.length - 1; k >= 0; k--) {
    const q = S.trail[k];
    const seg = Math.hypot(px - q.x, pz - q.z);
    if (seg >= need) {
      const f = need / seg;
      px += (q.x - px) * f;
      pz += (q.z - pz) * f;
      found = true;
      break;
    }
    need -= seg;
    px = q.x;
    pz = q.z;
  }
  if (!found && S.trail.length) {
    px = S.trail[0].x;
    pz = S.trail[0].z;
  }
  d.x += (px - d.x) * 0.5;
  d.z += (pz - d.z) * 0.5;
  if (Math.hypot(c.x - d.x, c.z - d.z) > 0.01) d.yaw = Math.atan2(c.x - d.x, c.z - d.z);
  while (S.trail.length > 2 && Math.hypot(S.trail[0].x - d.x, S.trail[0].z - d.z) > 3) S.trail.shift();
  const A = sim.layout.villageAltar;
  if (Math.hypot(A.x + 0.5 - c.x, A.z + 0.5 - c.z) < 4 / M + 0.3) {
    if (!S.altarNotified) {
      S.altarNotified = true;
      sim.alert({ kind: 'altar', text: 'At the altar. Press E on it to make the offering.' });
    }
  } else S.altarNotified = false;
}

export function stepChampion(sim: Sim, c: Entity) {
  const S = cs(sim);
  const prev = S.reason;
  if (c.state === 'captive') {
    S.reason = 'captive';
    if (c.human?.alt !== undefined || c.human?.climb) groundChampion(sim, c);
    return;
  }
  if (c.state === 'downed') {
    S.reason = 'downed';
    if (!isPlayerCtrl(prev)) S.epoch++;
    pushTrail(S, c.x, c.z);
    if (sim.tick - (c.human?.downedAt ?? 0) > 300) {
      c.state = 'idle';
      c.roll = 0;
      c.hp = Math.max(c.hp, sim.maxHp(c) * 0.25);
    }
    return;
  }
  // regeneration out of danger (R16)
  for (const m of sim.ents.values()) {
    if (m.kind === 'monster' && m.state !== 'downed' && m.state !== 'bound' && m.state !== 'rest' && Math.hypot(m.x - c.x, m.z - c.z) < 15) {
      S.lastThreat = sim.tick;
      break;
    }
  }
  if (sim.tick - S.lastThreat > 100 && c.hp < sim.maxHp(c)) heal(sim, c, sim.maxHp(c) * 0.002);

  // idle defense: autopilot after 5 minutes without input (R19, F9)
  if (!sim.order && sim.tick - S.lastInput > IDLE_TICKS) {
    const V = sim.layout.village;
    let threat: Entity | null = null;
    for (const m of sim.ents.values()) if (m.kind === 'monster' && m.state !== 'downed' && m.state !== 'bound' && Math.hypot(m.x - V.x, m.z - V.z) < sim.layout.wallRadius - 1) threat = m;
    if (threat) sim.order = { type: 'attack', id: threat.id, idle: true };
    else if (Math.hypot(c.x - V.x, c.z - V.z) > 4) sim.order = { type: 'move', x: V.x + 0.5, z: V.z + 1.5 };
  }
  const reason = ctrlReason(sim);
  S.reason = reason;
  if (isPlayerCtrl(reason) && !isPlayerCtrl(prev)) S.epoch++;
  // the sim walks the champion now: off the cliff first (and only once: then it's on walkable ground)
  if (reason === 'autopilot' && ((c.human?.alt ?? 0) > 0 || sim.grid.get(Math.floor(c.x), Math.floor(c.z)) === 'cliff')) groundChampion(sim, c);
  if (reason === 'hold') holdGround(sim, c);
  else if (reason === 'autopilot') runOrder(sim, c);
  else c.state = sim.dragging >= 0 ? 'drag' : 'idle';
  pushTrail(S, c.x, c.z);
  if (sim.dragging >= 0) placeDragged(sim, c);
}

/** Pointer lock lost: stand and swing at whatever attacks you (F10). */
function holdGround(sim: Sim, c: Entity) {
  const S = cs(sim);
  c.state = sim.dragging >= 0 ? 'drag' : 'idle';
  let foe: Entity | null = null, bd = Infinity;
  for (const m of sim.ents.values()) {
    if (m.kind !== 'monster' || m.target !== c.id || m.state === 'downed' || m.state === 'bound') continue;
    const d = axisDist(m, c.x, c.z) - bodyR(m);
    if (d < bd) { bd = d; foe = m; }
  }
  if (!foe || bd > SWORD_M / M) return;
  if (sim.dragging >= 0) releaseDragged(sim);
  c.state = 'fight';
  const p = axisPoint(foe, c.x, c.z);
  c.yaw = Math.atan2(p.x - c.x, p.z - c.z);
  if (sim.tick >= S.swingReady) swing(sim, c, { yaw: c.yaw, targetId: foe.id, zone: null });
}

function speed(sim: Sim, c: Entity) {
  return sim.stat(c, 'speed') * legFactor(c);
}

function runOrder(sim: Sim, c: Entity) {
  const S = cs(sim);
  const o = sim.order!;
  const walk = (x: number, z: number) => {
    if (!sim.moving(c) && !sim.goTo(c, x, z)) {
      sim.order = null;
      return;
    }
    sim.advancePath(c, speed(sim, c));
  };
  switch (o.type) {
    case 'move': {
      c.state = sim.dragging >= 0 ? 'drag' : 'walk';
      if (Math.hypot(o.x - c.x, o.z - c.z) < 0.4) {
        sim.order = null;
        sim.stop(c);
        return;
      }
      if (!sim.moving(c) && !sim.goTo(c, o.x, o.z)) {
        sim.order = null;
        return;
      }
      sim.advancePath(c, speed(sim, c));
      if (!sim.moving(c)) sim.order = null;
      return;
    }
    case 'attack':
    case 'finish': {
      const t = sim.ents.get(o.id);
      if (!t || t.kind !== 'monster' || (o.type === 'attack' && (t.state === 'bound' || t.state === 'downed'))) {
        sim.order = null;
        return;
      }
      const V = sim.layout.village;
      if (o.type === 'attack' && o.idle && Math.hypot(t.x - V.x, t.z - V.z) > sim.layout.wallRadius + 6) {
        sim.order = null;
        return;
      }
      if (sim.dragging >= 0) releaseDragged(sim);
      c.state = 'fight';
      const gapT = axisDist(t, c.x, c.z) - bodyR(t);
      const want = o.type === 'finish' ? INTERACT_M / M * 0.8 : (SWORD_M / M) * 0.85;
      if (gapT > want) {
        if (gapT < 2) {
          sim.stop(c);
          const p = axisPoint(t, c.x, c.z);
          sim.moveToward(c, p.x, p.z, speed(sim, c));
        } else {
          if (!sim.moving(c) || sim.tick % 6 === 0) sim.goTo(c, t.x, t.z);
          sim.advancePath(c, speed(sim, c));
        }
        return;
      }
      sim.stop(c);
      const p = axisPoint(t, c.x, c.z);
      c.yaw = Math.atan2(p.x - c.x, p.z - c.z);
      if (o.type === 'finish') {
        finish(sim, c, t.id);
        sim.order = null;
        return;
      }
      if (sim.tick >= S.swingReady) swing(sim, c, { yaw: c.yaw, targetId: t.id, zone: null });
      return;
    }
    case 'bind':
    case 'drag': {
      const t = sim.ents.get(o.id);
      const ok = t && (o.type === 'bind' ? t.kind === 'monster' && (t.state === 'downed' || t.state === 'bound') : t.kind === 'corpse' || (t.kind === 'monster' && t.state === 'bound'));
      if (!t || !ok) {
        sim.order = null;
        return;
      }
      c.state = 'walk';
      if (!near(sim, c, t, INTERACT_M * 0.8)) {
        if (axisDist(t, c.x, c.z) < 1.5) {
          sim.stop(c);
          sim.moveToward(c, t.x, t.z, speed(sim, c));
          return;
        }
        return walk(t.x, t.z);
      }
      sim.stop(c);
      bind(sim, c, t);
      sim.order = null;
      return;
    }
    case 'altar': {
      const A = sim.layout.villageAltar;
      c.state = 'walk';
      if (Math.hypot(A.x + 0.5 - c.x, A.z + 0.5 - c.z) < 0.45) {
        sim.stop(c);
        sim.order = null;
        sim.alert({ kind: 'altar', text: 'At the altar.' });
        return;
      }
      if (Math.hypot(A.x + 0.5 - c.x, A.z + 1.0 - c.z) < 1.2) {
        sim.stop(c);
        sim.moveToward(c, A.x + 0.5, A.z + 0.9, speed(sim, c));
        return;
      }
      return walk(A.x + 0.5, A.z + 1.5);
    }
    case 'drop':
      sim.order = null;
  }
}

export function championDawn(sim: Sim) {
  if (sim.championPendingDawn) crown(sim);
}

export function checkSuccession(sim: Sim) {
  if (sim.championPendingDawn && sim.tick - cs(sim).diedTick >= SUCCESSION_TICKS) crown(sim);
}

export function onChampionDied(sim: Sim) {
  const S = cs(sim);
  S.diedTick = sim.tick;
  S.blocking = false;
  sim.dragging = -1;
}

export function crown(sim: Sim) {
  const pool = sim.humans().filter((h) => h.state !== 'captive' && h.state !== 'downed' && h.carriedBy === undefined);
  if (!pool.length) return;
  const c = sim.rng.pick(pool)!;
  sim.championPendingDawn = false;
  sim.championId = c.id;
  const job = c.human!.job;
  c.human!.job = 'champion';
  c.human!.site = -1;
  c.human!.shift = 'day';
  c.shape = 'champion';
  c.tint = JOB_TINT.champion;
  c.base.speed = 1.1;
  if (c.hidden) {
    const h = sim.ents.get(c.human!.homeId);
    if (h) {
      const d = doorOf(sim, h);
      c.x = d.x;
      c.z = d.z;
    }
  }
  c.hidden = false;
  c.state = 'idle';
  clearClimb(c);
  sim.stop(c);
  c.tags = c.tags.filter((t) => t !== 'elder');
  c.tags.push('champion');
  sim.order = null;
  const S = cs(sim);
  S.lastInput = sim.tick;
  S.epoch++;
  S.trail = [];
  S.poses = [];
  S.wield = 'sword';
  sim.log(`${c.name}, once a ${job}, takes up the bronze sword. The village has a new champion (level ${c.level}).`, 3, 'core', 'champion');
  sim.alert({ kind: 'champion', text: `${c.name} is your new champion.` });
}
