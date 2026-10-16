// Climbing, sim side (docs/climbing-phase1-plan.md, Part E, tests 1–11): height in poses, corrections and saves,
// falls, vertical reach, flyers stooping, besiege, hand-over resets, and procedural islands untouched.
import { describe, it, expect } from 'vitest';
import { Island } from '../src/sim/island';
import { cs, releaseOnChampion, type ChampInput } from '../src/sim/champion';
import { serializeCore, deserializeCore } from '../src/sim/serialize';
import { DEFAULT_SETTINGS } from '../src/sim/terrain-import';
import { M, WATER_Y } from '../src/sim/ground';
import { SIZE } from '../src/sim/world';
import { HOUR_MS } from '../src/sim/clock';
import { bodyR, champReachable, reachT } from '../src/sim/body';
import { startRaid, telegraphRadius, vReachOk } from '../src/sim/monster-ai';
import type { Entity } from '../src/sim/types';
import { now, START } from './helpers';

const terrainIsland = (seed = 7) => Island.create(seed, START, 1, DEFAULT_SETTINGS);

function feed(island: Island, i: ChampInput) {
  island.sim.inputs.push(i);
}
function pose(island: Island, x: number, z: number, extra: Partial<Extract<ChampInput, { type: 'pose' }>> = {}) {
  const c = island.sim.champion()!;
  feed(island, { type: 'pose', x, z, yaw: c.yaw, pitch: 0, epoch: cs(island.sim).epoch, input: true, ...extra });
}
/** Put the champion somewhere by hand (as a dev scenario does) and adopt the new epoch. */
function put(island: Island, x: number, z: number, alt = 0) {
  const c = island.sim.champion()!;
  c.x = x;
  c.z = z;
  if (alt > 0) {
    c.human!.alt = alt;
    c.human!.climb = 'wall';
  } else {
    delete c.human!.alt;
    delete c.human!.climb;
  }
  cs(island.sim).epoch++;
  cs(island.sim).poses = [];
}
/** Step, keeping the champion where it is (and the player at the controls). */
function hold(island: Island, ticks: number, each?: () => void) {
  for (let t = 0; t < ticks; t++) {
    const c = island.sim.champion()!;
    pose(island, c.x, c.z, c.human?.alt ? { alt: c.human.alt, climb: c.human.climb } : {});
    island.step();
    each?.();
  }
}

/** A cliff tile with a human- and m-walkable neighbour, the walkable side well below it. */
function cliffEdge(island: Island, m?: Entity) {
  const sim = island.sim;
  let best: { cx: number; cz: number; wx: number; wz: number; drop: number } | null = null;
  for (let z = 2; z < SIZE - 2; z++) for (let x = 2; x < SIZE - 2; x++) {
    if (sim.grid.get(x, z) !== 'cliff') continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wx = x + dx, wz = z + dz;
      if (!sim.walkableFor('human', wx, wz) || (m && !sim.walkableFor(m, wx, wz))) continue;
      const drop = sim.ground.y(x + 0.5, z + 0.5) - sim.ground.y(wx + 0.5, wz + 0.5);
      if (!best || drop > best.drop) best = { cx: x, cz: z, wx, wz, drop };
    }
  }
  return best!;
}

const groundMonster = (sim: Island['sim']) => sim.monsters().find((m) => !m.monster!.flies)!;

/** fake bodies for the reach rule, at base scale */
function body(arch: string, scale: number, alt = 0): Entity {
  return { x: 64.5, z: 64.5, scale, kind: 'monster', monster: { archetype: arch, alt } } as unknown as Entity;
}

describe('climbing: the sim', () => {
  it('1–2: climb poses onto cliff tiles are accepted with their height; corrections keep it', () => {
    const island = terrainIsland();
    const sim = island.sim;
    const e = cliffEdge(island);
    const c = sim.champion()!;
    const dx = e.cx - e.wx, dz = e.cz - e.wz;
    // just inside the walkable tile, at its border with the cliff
    const bx = e.wx + 0.5 + dx * 0.45, bz = e.wz + 0.5 + dz * 0.45;
    put(island, bx, bz);
    island.step();
    const tx = bx + dx * 0.15, tz = bz + dz * 0.15;
    const ep = cs(sim).epoch;
    pose(island, tx, tz);
    island.step();
    expect(cs(sim).epoch).toBe(ep + 1); // corrected: not walkable without a climb
    expect(Math.floor(c.x)).toBe(e.wx + (dx < 0 ? 0 : 0));
    pose(island, tx, tz, { alt: 1, climb: 'wall' });
    island.step();
    expect(Math.floor(c.x) === e.cx && Math.floor(c.z) === e.cz).toBe(true);
    expect(c.human!.alt).toBe(1);
    // climb to 12 m, 1.5 m a tick
    for (let a = 2.5; a <= 12; a += 1.5) {
      pose(island, tx, tz, { alt: a, climb: 'wall' });
      island.step();
    }
    expect(c.human!.alt).toBe(11.5);
    // too fast up: corrected, and the correction carries the height
    pose(island, tx, tz, { alt: 40, climb: 'wall' });
    island.step();
    expect(cs(sim).correction?.alt).toBe(11.5);
    expect(c.human!.alt).toBe(11.5);
  });

  it('3: vertical reach: a nephil reaches 5 m up but not 9; a tannin not 3.5; procedural islands always reach', () => {
    const island = terrainIsland();
    const g = island.sim.ground;
    const champ = (alt: number) => ({ x: 64.5, z: 64.5, kind: 'human', scale: 1, human: { alt } }) as unknown as Entity;
    expect(champReachable(g, body('nephil', 2.2), champ(5))).toBe(true);
    expect(champReachable(g, body('nephil', 2.2), champ(9))).toBe(false);
    expect(champReachable(g, body('tannin', 1.6), champ(3.5))).toBe(false);
    expect(champReachable(g, body('tannin', 1.6), champ(1))).toBe(true);
    // vReachOk only ever says no for the champion on a terraformer island
    const sim = island.sim;
    const c = sim.champion()!, m = groundMonster(sim);
    m.x = c.x;
    m.z = c.z;
    c.human!.alt = 30;
    expect(vReachOk(sim, m, c)).toBe(false);
    const proc = Island.create(7, START, 1).sim;
    const pc = proc.champion()!, pm = groundMonster(proc);
    pc.human!.alt = 30;
    expect(vReachOk(proc, pm, pc)).toBe(true);
  });

  it('4: a release misses a champion who climbed out of reach during the wind-up', () => {
    const island = terrainIsland();
    const sim = island.sim;
    for (let k = 0; k < 10; k++) island.step(); // past the start's i-frames
    const c = sim.champion()!, m = groundMonster(sim);
    cs(sim).iframesUntil = 0;
    m.x = c.x;
    m.z = c.z - reachT(m) * 0.7;
    m.yaw = 0;
    const hitR = telegraphRadius(m) + bodyR(c);
    cs(sim).poses = [];
    expect(releaseOnChampion(sim, m, c, hitR)).toBe('hit');
    cs(sim).poses = [{ tick: sim.tick, x: c.x, z: c.z, yaw: c.yaw, alt: 20 }];
    cs(sim).reason = 'player';
    expect(releaseOnChampion(sim, m, c, hitR)).toBe('miss');
  });

  it('5: besiege: no wind-up, a steady prowl, giving up, and leaving the champion be for an hour', () => {
    const island = terrainIsland();
    const sim = island.sim;
    sim.invincible = true;
    const m = groundMonster(sim);
    const e = cliffEdge(island, m);
    const c = sim.champion()!;
    put(island, e.cx + 0.5, e.cz + 0.5, 20);
    m.x = e.wx + 0.5;
    m.z = e.wz + 0.5;
    m.target = c.id;
    m.state = 'fight';
    m.monster!.seen = true;
    let woundUp = false;
    const paths = new Set<unknown>();
    hold(island, 200, () => {
      woundUp ||= m.monster!.windup >= 0;
      if (m.monster!.besiegeUntil !== undefined && m.path) paths.add(m.path);
    });
    expect(woundUp).toBe(false);
    expect(m.state).toBe('fight');
    expect(m.monster!.besiegeUntil).toBeGreaterThan(sim.clockMs);
    // one path per prowl (every 80 ticks), not one per tick
    expect(paths.size).toBeLessThanOrEqual(4);
    // time's up
    m.monster!.besiegeUntil = sim.clockMs - 1;
    hold(island, 1);
    expect(m.target).toBe(-1);
    expect(m.state).toBe('return');
    expect(m.monster!.ignoreChampUntil).toBeGreaterThan(sim.clockMs + HOUR_MS * 0.9);
    // for the next hour: no aggro (champion close, on the ground), no roar response, no raid targeting
    put(island, e.wx + 0.5, e.wz + 0.5);
    m.x = e.wx + 0.5 + 1.5 / M;
    m.z = e.wz + 0.5;
    let retargeted = false;
    hold(island, 60, () => (retargeted ||= m.target === c.id));
    m.monster!.respondTo = { x: m.x, z: m.z, at: sim.tick };
    hold(island, 30, () => (retargeted ||= m.target === c.id));
    startRaid(sim);
    hold(island, 60, () => (retargeted ||= m.target === c.id));
    expect(retargeted).toBe(false);
    // hit it and the fight is back on
    m.x = c.x;
    m.z = c.z + 1.5 / M + bodyR(m);
    m.state = 'fight';
    cs(sim).swingReady = 0;
    feed(island, { type: 'swing', yaw: 0, pitch: 0, targetId: m.id, zone: 'torso' });
    island.step();
    expect(m.monster!.ignoreChampUntil).toBeUndefined();
    expect(m.target).toBe(c.id);
  });

  it('6: no besiege when the champion can be walked to: the monster comes up and attacks', () => {
    const island = terrainIsland();
    const sim = island.sim;
    sim.invincible = true;
    const m = groundMonster(sim);
    // a walkable spot well above a walkable spot nearby
    let best: { hx: number; hz: number; lx: number; lz: number } | null = null, bd = 0;
    for (let z = 4; z < SIZE - 4; z += 2) for (let x = 4; x < SIZE - 4; x += 2) {
      if (!sim.walkableFor(m, x, z) || !sim.walkableFor('human', x, z)) continue;
      for (const [dx, dz] of [[4, 0], [0, 4], [-4, 0], [0, -4]]) {
        if (!sim.walkableFor(m, x + dx, z + dz)) continue;
        const d = sim.ground.y(x + 0.5, z + 0.5) - sim.ground.y(x + dx + 0.5, z + dz + 0.5);
        if (d > bd) { bd = d; best = { hx: x, hz: z, lx: x + dx, lz: z + dz }; }
      }
    }
    expect(bd).toBeGreaterThan(8);
    const c = sim.champion()!;
    put(island, best!.hx + 0.5, best!.hz + 0.5);
    m.x = best!.lx + 0.5;
    m.z = best!.lz + 0.5;
    m.target = c.id;
    m.state = 'fight';
    let woundUp = false, besieged = false;
    hold(island, 1500, () => {
      woundUp ||= m.monster!.windup >= 0;
      besieged ||= m.monster!.besiegeUntil !== undefined;
      m.target = c.id; // keep it on the champion however far the walk around is
    });
    expect(besieged).toBe(false);
    expect(woundUp).toBe(true);
  });

  it('7: falls hurt the legs, kill from high enough, not into deep water; a paused fall still lands', () => {
    const island = terrainIsland();
    const sim = island.sim;
    const c = sim.champion()!;
    const hp0 = c.hp;
    const land = (impact: number) => {
      sim.drainOut();
      feed(island, { type: 'land', impact });
      island.step();
      const hurt = sim.drainOut().hurt ?? 0;
      for (let k = 0; k < 6; k++) island.step();
      return hurt;
    };
    expect(land(10)).toBe(0);
    expect(c.hp).toBe(hp0);
    expect(land(20)).toBeGreaterThan(0);
    expect(c.hp).toBeLessThan(hp0);
    expect(c.zones!.legL!.hp).toBeLessThan(c.zones!.legL!.max);
    // deep water breaks the fall
    const hp1 = c.hp;
    const keep = { x: c.x, z: c.z };
    let wet: { x: number; z: number } | null = null;
    for (let i = 0; i < SIZE * SIZE && !wet; i++) {
      const x = (i % SIZE) + 0.5, z = Math.floor(i / SIZE) + 0.5;
      if (WATER_Y - sim.ground.y(x, z) >= 1.5) wet = { x, z };
    }
    c.x = wet!.x;
    c.z = wet!.z;
    sim.drainOut();
    feed(island, { type: 'land', impact: 25 });
    island.step();
    expect(sim.drainOut().hurt ?? 0).toBe(0);
    expect(c.hp).toBeGreaterThanOrEqual(hp1); // (it regenerates)
    c.x = keep.x;
    c.z = keep.z;
    for (let k = 0; k < 6; k++) island.step();
    // paused (pointer lock lost): still applied
    cs(sim).locked = false;
    island.step();
    expect(cs(sim).reason).toBe('hold');
    expect(land(20)).toBeGreaterThan(0);
    expect(c.hp).toBeLessThan(hp1);
    cs(sim).locked = true;
    // and high enough kills
    const id = c.id;
    feed(island, { type: 'land', impact: 40 });
    island.step();
    expect(sim.ents.get(id)).toBeUndefined();
    const corpse = [...sim.ents.values()].find((e) => e.kind === 'corpse' && e.corpse?.name === c.name);
    expect(corpse?.corpse?.deathType).toBe('crushed');
  });

  it('8: a flyer fighting a climber comes up to its height', () => {
    let island: Island | null = null, f: Entity | undefined;
    for (let seed = 1; seed < 12 && !f; seed++) {
      island = terrainIsland(seed);
      f = island.sim.monsters().find((m) => m.monster!.flies);
    }
    expect(f).toBeDefined();
    const sim = island!.sim;
    sim.invincible = true;
    const e = cliffEdge(island!);
    const c = sim.champion()!;
    put(island!, e.cx + 0.5, e.cz + 0.5, 20);
    f!.x = e.wx + 0.5;
    f!.z = e.wz + 0.5;
    f!.monster!.alt = 0;
    f!.target = c.id;
    f!.state = 'fight';
    const want = sim.ground.y(c.x, c.z) + 20 - sim.ground.y(f!.x, f!.z);
    let high = 0;
    hold(island!, 40, () => (high = Math.max(high, f!.monster!.alt ?? 0)));
    expect(high).toBeGreaterThan(Math.min(15, want - 2));
  });

  it('9–10: autopilot and loading take the champion off the cliff, once', () => {
    const island = terrainIsland();
    const sim = island.sim;
    const c = sim.champion()!;
    // a cliff tile as far from walkable ground as there is
    let spot: { x: number; z: number } | null = null, far = -1;
    for (let z = 2; z < SIZE - 2; z++) for (let x = 2; x < SIZE - 2; x++) {
      if (sim.grid.get(x, z) !== 'cliff') continue;
      let r = 1;
      while (r <= 6 && !sim.nearestWalkable(c, x, z, r)) r++;
      if (r > far && r <= 6) { far = r; spot = { x, z }; }
    }
    put(island, spot!.x + 0.5, spot!.z + 0.5);
    cs(sim).lastInput = sim.tick - 3001; // the idle defense: walk home
    island.step();
    const order = sim.order;
    expect(order).not.toBeNull();
    expect(sim.walkableFor(c, c.x, c.z)).toBe(true);
    expect(c.human!.alt).toBeUndefined();
    const at = { x: c.x, z: c.z };
    for (let k = 0; k < 30; k++) island.step();
    if (sim.order) expect(sim.order).toBe(order); // not re-issued every tick
    expect(Math.hypot(c.x - at.x, c.z - at.z)).toBeGreaterThan(0.1); // and walking

    // a save up the cliff loads on the ground
    sim.order = null;
    put(island, spot!.x + 0.5, spot!.z + 0.5, 12);
    const back = deserializeCore(JSON.parse(JSON.stringify(serializeCore(sim))));
    const bc = back.champion()!;
    expect(back.walkableFor(bc, bc.x, bc.z)).toBe(true);
    expect(bc.human!.alt).toBeUndefined();
  });

  it('11: procedural islands are untouched (no heights, no sieges)', () => {
    const island = Island.create(5, START, 1);
    const sim = island.sim;
    expect(sim.grid.base).toBeNull();
    const c = sim.champion()!;
    const H = sim.layout.highAltar;
    const p = sim.nearestWalkable(c, H.x, H.z, 6)!;
    put(island, p.x + 0.5, p.z + 0.5);
    sim.invincible = true;
    let touched = false;
    for (let t = 0; t < 3000 && !sim.gameOver; t++) {
      const ch = sim.champion();
      if (ch) pose(island, ch.x, ch.z, { alt: 15, climb: 'wall' }); // a client can't make the sim care
      island.step();
      if (ch?.human?.alt !== undefined || ch?.human?.climb !== undefined) touched = true;
      for (const m of sim.monsters()) if (m.monster!.besiegeUntil !== undefined || m.monster!.besiegeSince !== undefined || m.monster!.ignoreChampUntil !== undefined) touched = true;
    }
    expect(sim.tick).toBeGreaterThan(2900);
    expect(touched).toBe(false);
  });
});
