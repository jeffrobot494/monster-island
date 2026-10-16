import type { Sim } from '../sim';
import type { Entity } from '../types';
import { UNITS } from './defs';
import { hostile } from '../team';
import { applyDamage } from '../combat';
export function spawnUnit(
  sim: Sim,
  type: keyof typeof UNITS,
  x: number,
  z: number,
  leader: number,
  iid: number,
) {
  const def = UNITS[type],
    e = sim.spawn({
      kind: def.kind,
      x,
      z,
      shape: def.shape,
      tint: def.tint,
      scale: def.scale,
      tags: def.tags,
    });
  e.inhabitant = true;
  e.faction = def.faction;
  e.name = def.title;
  e.hp = e.base.maxHp = def.hp;
  e.base.speed = def.speed;
  e.unit = { type, leader, iid, mode: 'follow', until: 0, stolen: 0 };
  const spot = sim.nearestWalkable(e, x, z, 6);
  if (spot) {
    e.x = spot.x + 0.5;
    e.z = spot.z + 0.5;
  } else sim.remove(e);
  return e;
}
export function scatterUnit(sim: Sim, e: Entity) {
  if (!e.unit || e.unit.mode === 'scatter') return;
  e.unit.mode = 'scatter';
  e.unit.until = sim.tick + 50;
  sim.stop(e);
}
function move(sim: Sim, e: Entity, x: number, z: number) {
  const speed = sim.stat(e, 'speed'),
    d = Math.hypot(x - e.x, z - e.z);
  if (d < 0.2) return;
  const step = Math.min(d, speed / 10),
    nx = e.x + ((x - e.x) / d) * step,
    nz = e.z + ((z - e.z) / d) * step;
  if (sim.walkableFor(e, nx, nz)) {
    sim.stop(e);
    sim.moveToward(e, x, z, speed);
  } else {
    if (!sim.moving(e) || sim.tick % 30 === e.id % 30) sim.goTo(e, x, z);
    sim.advancePath(e, speed);
  }
}
export function stealFood(sim: Sim, iid: number, amount: number) {
  const inst = sim.events.active.find(
    (a) => a.iid === iid && a.phase === 'active',
  );
  if (!inst) return 0;
  const index = sim.director
    .definition(inst.def)
    .effects.findIndex((e) => e.type === 'spawnEscort');
  if (index < 0) return 0;
  const spec = sim.director.definition(inst.def).effects[index],
    state = inst.state[index];
  const stolen = Number(state.stolen ?? 0),
    take = Math.max(
      0,
      Math.min(sim.food, Number(spec.maxFood) - stolen, amount),
    );
  sim.food -= take;
  state.stolen = stolen + take;
  return take;
}
export function stepUnit(sim: Sim, e: Entity) {
  const u = e.unit!,
    p = UNITS[u.type].params,
    leader = sim.ents.get(u.leader);
  if (!leader?.monster || leader.hp <= 0) scatterUnit(sim, e);
  if (u.mode === 'scatter') {
    if (sim.tick >= u.until) {
      sim.remove(e);
      return;
    }
    const v = sim.layout.village;
    move(sim, e, e.x + (e.x - v.x), e.z + (e.z - v.z));
    return;
  }
  if (!leader) return;
  const anchor =
    (leader.monster!.alt ?? 0) > 3 || !sim.walkableFor(e, leader.x, leader.z)
      ? sim.nearestWalkable(e, leader.x, leader.z, 12)
      : leader;
  const base = anchor ?? e;
  const scared = sim
    .humans()
    .some(
      (h) =>
        hostile(e, h) &&
        !h.hidden &&
        (h.id === sim.championId || h.human!.job === 'guard') &&
        !['downed', 'captive', 'bound'].includes(h.state) &&
        sim.dist(e, h) < p.fearRadius,
    );
  if (scared) {
    move(sim, e, base.x, base.z);
    return;
  }
  const targets: {
    x: number;
    z: number;
    kind: 'worker' | 'food' | 'lamb';
    entity?: Entity;
  }[] = [
    { ...sim.layout.granary, kind: 'food' },
    { ...sim.layout.fold, kind: 'lamb' },
    ...sim
      .humans()
      .filter(
        (h) =>
          hostile(e, h) &&
          !h.hidden &&
          h.human!.job !== 'guard' &&
          h.id !== sim.championId,
      )
      .map((h) => ({ x: h.x, z: h.z, kind: 'worker' as const, entity: h })),
  ];
  const target = targets
    .filter(
      (t) =>
        sim.dist(e, t) < p.raidRadius &&
        sim.dist(base, t) < p.leash * 2 &&
        (t.kind !== 'lamb' || sim.fold > 0),
    )
    .sort((a, b) => sim.dist(e, a) - sim.dist(e, b))[0];
  if (target && u.mode !== 'return') {
    u.mode = 'raid';
    move(sim, e, target.x, target.z);
    if (sim.dist(e, target) < 0.8 && sim.tick >= u.until) {
      u.until = sim.tick + p.biteCooldownTicks;
      if (target.kind === 'worker')
        applyDamage(sim, target.entity!, 2, { type: 'bite', sourceId: e.id });
      if (target.kind === 'food') {
        const take = stealFood(sim, u.iid, p.foodBite);
        u.stolen += take;
        if (take) sim.emote(e, '🌾', 1);
      }
      if (target.kind === 'lamb' && sim.rng.chance(p.lambChance)) {
        sim.fold--;
        u.mode = 'return';
        sim.emote(e, '🐑', 1);
      }
    }
  } else {
    if (sim.dist(e, base) < 2) u.mode = 'follow';
    const angle = leader.yaw + Math.PI + ((e.id % 5) - 2) * 0.4;
    move(
      sim,
      e,
      base.x + Math.sin(angle) * p.leash * 0.5,
      base.z + Math.cos(angle) * p.leash * 0.5,
    );
  }
}
