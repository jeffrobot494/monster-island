// The player's champion (§7, §13, R15–R21): orders, attacks, dash dodge, binding, dragging, regeneration, idle defense,
// succession.
import type { Sim } from './sim';
import type { Entity } from './types';
import { applyDamage, armFactor, firstName, heal, legFactor, releaseDragged } from './combat';
import { JOB_TINT } from './core-defs';

export type Order =
  | { type: 'move'; x: number; z: number }
  | { type: 'attack'; id: number; idle?: boolean }
  | { type: 'finish'; id: number }
  | { type: 'bind'; id: number }
  | { type: 'drag'; id: number }
  | { type: 'drop' }
  | { type: 'altar' };

const SUCCESSION_TICKS = 36_000; // 1 real hour (R21)
const IDLE_TICKS = 3000; // 5 real minutes (R19)
const ALTAR_R = 2.5;

interface ChampState {
  lastOrder: number;
  lastThreat: number;
  swingReady: number;
  dashReady: number;
  diedTick: number;
  altarNotified: boolean;
  weapon: { type: string; mul: number };
}

export function cs(sim: Sim): ChampState {
  const s = sim as unknown as { champState?: ChampState };
  return (s.champState ??= { lastOrder: 0, lastThreat: -9999, swingReady: 0, dashReady: 0, diedTick: 0, altarNotified: false, weapon: { type: 'slash', mul: 1 } });
}

export function champReach(t: Entity) {
  return 1.3 + 0.25 * t.scale;
}

export function issueOrder(sim: Sim, o: Order) {
  const c = sim.champion();
  if (!c || c.state === 'downed' || c.state === 'captive') return;
  const S = cs(sim);
  S.lastOrder = sim.tick;
  if (o.type === 'drop') {
    if (sim.dragging >= 0) {
      releaseDragged(sim);
      sim.log('You let go.', 1);
    }
    return;
  }
  // dash dodge: a move order while something is winding up on you (R15)
  if (o.type === 'move' && sim.tick >= S.dashReady) {
    for (const m of sim.ents.values()) {
      if (m.kind !== 'monster' || m.target !== c.id || (m.monster!.windup ?? -1) < 0) continue;
      if (Math.hypot(m.x - c.x, m.z - c.z) > 4) continue;
      const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz) || 1;
      const nx = c.x + (dx / d) * 1.2, nz = c.z + (dz / d) * 1.2;
      if (sim.walkableFor(c, nx, nz)) {
        c.x = nx;
        c.z = nz;
        S.dashReady = sim.tick + 20;
        sim.burst('dust', c.x, c.z);
        sim.stop(c);
      }
      break;
    }
  }
  if (o.type === 'altar') S.altarNotified = false;
  sim.order = o;
  sim.stop(c);
}

function speed(sim: Sim, c: Entity) {
  let s = sim.stat(c, 'speed') * legFactor(c);
  if (sim.dragging >= 0) {
    const d = sim.ents.get(sim.dragging);
    if (d) {
      let helpers = 0;
      for (const h of sim.ents.values()) if (h.state === 'help-drag' && Math.hypot(h.x - c.x, h.z - c.z) < 3) helpers++;
      const heavy = d.kind === 'monster' || (d.corpse && d.corpse.maxHp > 100);
      s *= heavy ? Math.min(0.85, 0.4 + 0.15 * Math.min(3, helpers)) : 0.8;
    }
  }
  return s;
}

export function stepChampion(sim: Sim, c: Entity) {
  const S = cs(sim);
  if (c.state === 'captive') return;
  if (c.state === 'downed') {
    if (sim.tick - (c.human?.downedAt ?? 0) > 300) {
      c.state = 'idle';
      c.roll = 0;
      c.hp = Math.max(c.hp, sim.maxHp(c) * 0.25);
    }
    return;
  }
  // regeneration out of danger (R16)
  for (const m of sim.ents.values()) {
    if (m.kind === 'monster' && m.state !== 'downed' && m.state !== 'bound' && Math.hypot(m.x - c.x, m.z - c.z) < 15) {
      S.lastThreat = sim.tick;
      break;
    }
  }
  if (sim.tick - S.lastThreat > 100 && c.hp < sim.maxHp(c)) heal(sim, c, sim.maxHp(c) * 0.002);

  // the dragged body follows one tile behind
  if (sim.dragging >= 0) {
    const d = sim.ents.get(sim.dragging);
    if (!d) sim.dragging = -1;
    else {
      const bx = c.x - Math.sin(c.yaw) * 1.0, bz = c.z - Math.cos(c.yaw) * 1.0;
      if (Math.hypot(bx - d.x, bz - d.z) > 0.05) {
        d.x += (bx - d.x) * 0.3;
        d.z += (bz - d.z) * 0.3;
      }
      d.yaw = c.yaw;
      const A = sim.layout.villageAltar;
      if (Math.hypot(A.x + 0.5 - c.x, A.z + 0.5 - c.z) < ALTAR_R) {
        if (!S.altarNotified) {
          S.altarNotified = true;
          sim.alert({ kind: 'altar', text: 'At the altar.' });
        }
      } else S.altarNotified = false;
    }
  }

  let o = sim.order;
  // idle defense (R19)
  if (!o && sim.tick - S.lastOrder > IDLE_TICKS) {
    const V = sim.layout.village;
    let threat: Entity | null = null;
    for (const m of sim.ents.values()) if (m.kind === 'monster' && m.state !== 'downed' && m.state !== 'bound' && Math.hypot(m.x - V.x, m.z - V.z) < sim.layout.wallRadius + 2) threat = m;
    if (threat) o = { type: 'attack', id: threat.id, idle: true };
    else if (Math.hypot(c.x - V.x, c.z - V.z) > 4) o = { type: 'move', x: V.x + 0.5, z: V.z + 1.5 };
    if (o) sim.order = o;
  }
  if (!o) {
    c.state = sim.dragging >= 0 ? 'drag' : 'idle';
    return;
  }
  const walk = (x: number, z: number) => {
    if (!sim.moving(c)) {
      if (!sim.goTo(c, x, z)) {
        sim.order = null;
        return;
      }
    }
    sim.advancePath(c, speed(sim, c));
  };
  switch (o.type) {
    case 'move': {
      c.state = sim.dragging >= 0 ? 'drag' : 'walk';
      if (Math.hypot(o.x - c.x, o.z - c.z) < 0.4 || (!sim.moving(c) && sim.order === o && c.path === null && Math.floor(c.x) === Math.floor(o.x) && Math.floor(c.z) === Math.floor(o.z))) {
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
      if (!t || t.kind !== 'monster' || t.state === 'bound') {
        sim.order = null;
        return;
      }
      if (o.type === 'attack' && t.state === 'downed') {
        sim.order = null;
        sim.alert({ kind: 'info', text: `${firstName(t)} is down! Tap it to bind it, or press Finish.` });
        return;
      }
      const V = sim.layout.village;
      if (o.type === 'attack' && o.idle && Math.hypot(t.x - V.x, t.z - V.z) > sim.layout.wallRadius + 6) {
        sim.order = null;
        return;
      }
      if (sim.dragging >= 0) releaseDragged(sim);
      c.state = 'fight';
      const d = Math.hypot(t.x - c.x, t.z - c.z);
      if (d > champReach(t)) {
        if (!sim.moving(c) || sim.tick % 6 === 0) sim.goTo(c, t.x, t.z);
        sim.advancePath(c, speed(sim, c));
        return;
      }
      sim.stop(c);
      c.yaw = Math.atan2(t.x - c.x, t.z - c.z);
      if (sim.tick >= S.swingReady) {
        S.swingReady = sim.tick + 7;
        const dmg = 12 * (1 + 0.1 * (c.level - 1)) * sim.stat(c, 'strength') * armFactor(c) * S.weapon.mul;
        const ambush = t.state === 'rest' ? 2 : 1;
        if (ambush > 1) sim.emote(c, 'Ambush!', 1, true);
        if (t.monster && t.state !== 'downed') t.target = c.id;
        applyDamage(sim, t, dmg, { type: S.weapon.type, sourceId: c.id, mul: ambush });
        if (t.monster && t.state === 'rest') t.state = 'fight';
      }
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
      if (Math.hypot(t.x - c.x, t.z - c.z) > 1.5) return walk(t.x, t.z);
      sim.stop(c);
      if (sim.dragging >= 0 && sim.dragging !== t.id) releaseDragged(sim);
      if (t.kind === 'monster') {
        if (t.state !== 'bound') sim.log(`You bind ${t.name}. Drag it home to the altar.`, 2, 'core', 'bind');
        t.state = 'bound';
        t.stateUntil = 0;
        t.roll = 1;
        sim.stop(t);
      }
      sim.dragging = t.id;
      S.altarNotified = false;
      sim.order = null;
      return;
    }
    case 'altar': {
      const A = sim.layout.villageAltar;
      c.state = 'walk';
      if (Math.hypot(A.x + 0.5 - c.x, A.z + 0.5 - c.z) < ALTAR_R) {
        sim.stop(c);
        sim.order = null;
        sim.alert({ kind: 'altar', text: 'At the altar.' });
        return;
      }
      return walk(A.x + 0.5, A.z + 1.5);
    }
  }
}

export function championDawn(sim: Sim) {
  if (sim.championPendingDawn) crown(sim);
}

export function checkSuccession(sim: Sim) {
  if (sim.championPendingDawn && sim.tick - cs(sim).diedTick >= SUCCESSION_TICKS) crown(sim);
}

export function onChampionDied(sim: Sim) {
  cs(sim).diedTick = sim.tick;
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
  c.hidden = false;
  c.state = 'idle';
  c.tags = c.tags.filter((t) => t !== 'elder');
  c.tags.push('champion');
  sim.order = null;
  cs(sim).lastOrder = sim.tick;
  sim.log(`${c.name}, once a ${job}, takes up the bronze sword. The village has a new champion (level ${c.level}).`, 3, 'core', 'champion');
  sim.alert({ kind: 'champion', text: `${c.name} is your new champion.` });
}
