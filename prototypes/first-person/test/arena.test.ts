// The combat arena (src/arena/README.md): its shape, and the director running the game's sim on it.
import { describe, it, expect } from 'vitest';
import { ArenaSim } from '../src/arena/arena-sim';
import { ArenaDirector, FOLLOWER_TAG } from '../src/arena/director';
import { C, DEFAULT_SHAPE, FLOOR_Y, planArena, prismTriangles, solidTiles, type ArenaShape } from '../src/arena/geometry';
import { DEFAULT_RULES, sanitize, type ArenaRules } from '../src/arena/rules';
import { FeatureSurface } from '../src/input/feature-surface';
import { findPath } from '../src/sim/pathfind';
import { kill } from '../src/sim/combat';
import { M } from '../src/sim/ground';
import { SIZE } from '../src/sim/world';
import { START } from './helpers';

function arena(shape: Partial<ArenaShape> = {}, rules: Partial<ArenaRules> = {}) {
  const sim = new ArenaSim(7);
  sim.build({ ...DEFAULT_SHAPE, ...shape }, START, 180);
  const dir = new ArenaDirector(sim, { ...DEFAULT_RULES, ...rules });
  dir.reset();
  return { sim, dir };
}

const run = (sim: ArenaSim, ticks: number) => {
  for (let i = 0; i < ticks; i++) {
    sim.step();
    sim.drainOut();
  }
};

describe('arena shape', () => {
  it('is deterministic, and its rock faces outward', () => {
    const a = planArena(DEFAULT_SHAPE), b = planArena(DEFAULT_SHAPE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.prisms.length).toBeGreaterThan(15);
    const { pos } = prismTriangles(a.prisms);
    const surf = new FeatureSurface(pos);
    // every flat top can be stood on, at its height
    for (const p of a.prisms.filter((q) => q.y0 < FLOOR_Y && q.ty.every((y) => y === q.ty[0]))) {
      const cx = p.pts.reduce((s, q) => s + q[0], 0) / p.pts.length / M, cz = p.pts.reduce((s, q) => s + q[1], 0) / p.pts.length / M;
      const f = surf.floor(cx, cz, 999);
      expect(f).not.toBeNull();
      expect(f!.y).toBeGreaterThanOrEqual(p.ty[0] - 1e-3);
    }
    // side faces point away from their prism's middle
    for (const p of a.prisms) {
      const one = new FeatureSurface(prismTriangles([p]).pos);
      const cx = p.pts.reduce((s, q) => s + q[0], 0) / p.pts.length, cz = p.pts.reduce((s, q) => s + q[1], 0) / p.pts.length;
      for (let t = 0; t < one.count; t++) {
        if (Math.abs(one.ny(t)) > 0.9) continue;
        const o = t * 9, T = one.tri;
        const mx = (T[o] + T[o + 3] + T[o + 6]) / 3, mz = (T[o + 2] + T[o + 5] + T[o + 8]) / 3;
        expect((mx - cx) * one.nrm[t * 3] + (mz - cz) * one.nrm[t * 3 + 2]).toBeGreaterThan(0);
      }
    }
  });

  it('rock faces and the wall rise right at the edge of the floor tiles (so a climb can start from the floor)', () => {
    const { sim } = arena({ density: 'lots' });
    const surf = new FeatureSurface(prismTriangles(sim.arena.prisms).pos);
    let faces = 0, walls = 0;
    for (let z = 1; z < SIZE - 1; z++) for (let x = 1; x < SIZE - 1; x++) {
      if (!sim.walkableFor('human', x, z)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (sim.grid.get(x + dx, z + dz) !== 'cliff') continue;
        // a body on the floor tile, right at the shared edge: its lowest sphere (0.55 m up, r 0.33 m) touches rock
        const ex = x + 0.5 + dx * (0.5 - 0.05 / M), ez = z + 0.5 + dz * (0.5 - 0.05 / M);
        const y = sim.ground.y(ex, ez);
        const rock = surf.sphereHit(ex, ez, y + 0.55, 0.33) >= 0;
        const wall = sim.ground.y(x + 0.5 + dx * (0.5 + 1 / M), z + 0.5 + dz * (0.5 + 1 / M)) > y + 3;
        expect(rock || wall, `floor tile ${x},${z} toward ${dx},${dz}`).toBe(true);
        if (rock) faces++;
        else walls++;
      }
    }
    expect(faces).toBeGreaterThan(50);
    expect(walls).toBeGreaterThan(50);
  });

  it('every gate and every open tile can be walked to from the spawn', () => {
    for (const density of ['some', 'lots'] as const) for (const seed of [1, 2, 3]) {
      const { sim } = arena({ density, seed });
      const s = sim.arena.spawn;
      const costs = sim.costsFor('monster:reem|');
      for (let r = 1; r <= 6; r++) {
        const g = sim.layout.lairs[r];
        expect(sim.walkableFor('human', g.x, g.z), `gate ${r}, ${density} ${seed}`).toBe(true);
        expect(findPath(sim.grid, costs, Math.floor(s.x), Math.floor(s.z), g.x, g.z, 40000), `gate ${r}, ${density} ${seed}`).not.toBeNull();
      }
      // every floor tile can be reached: no pocket walled in by rock
      let open = 0;
      for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
        if (!sim.walkableFor('human', x, z)) continue;
        open++;
        if ((x + z) % 7) continue; // a sample is plenty
        expect(findPath(sim.grid, costs, Math.floor(s.x), Math.floor(s.z), x, z, 40000), `${x},${z} ${density} ${seed}`).not.toBeNull();
      }
      expect(open).toBeGreaterThan(1000);
    }
  });

  it('blocks the tiles under rock and beyond the wall, not under an arch span', () => {
    const { sim } = arena();
    const solid = solidTiles(sim.arena);
    for (let i = 0; i < SIZE * SIZE; i++) if (solid[i]) expect(sim.grid.types[i]).toBe('cliff');
    expect(sim.grid.get(C, C - DEFAULT_SHAPE.radius - 2)).toBe('cliff');
    expect(sim.ground.y(C, C - DEFAULT_SHAPE.radius - 3)).toBeGreaterThan(FLOOR_Y + DEFAULT_SHAPE.wallH - 1);
  });

  it('sanitizes stored settings', () => {
    const c = sanitize({ shape: { radius: 999, wallH: 60, density: 'bogus' as never, seed: 2 }, rules: { ...DEFAULT_RULES, monsters: ['nephil', 'nope'], hour: null } });
    expect(c.shape.radius).toBe(50);
    expect(c.shape.density).toBe('some');
    expect(c.rules.monsters).toEqual(['nephil']);
    expect(c.rules.hour).toBeNull();
  });
});

describe('arena director', () => {
  it('a round: champion and guards at the spawn, waves through the gates, a fight', () => {
    const { sim, dir } = arena({}, { maxAlive: 3, spawnEvery: 5, waveSize: 2, invincible: true });
    expect(sim.champion()).toBeTruthy();
    expect(dir.guards().length).toBe(3);
    expect(dir.guards().every((g) => g.tags.includes(FOLLOWER_TAG))).toBe(true);
    run(sim, 60);
    expect(sim.monsters().length).toBe(2);
    run(sim, 3000);
    expect(sim.gameOver).toBeNull();
    expect(sim.monsters().length).toBeLessThanOrEqual(3);
    expect(dir.spawned).toBeGreaterThanOrEqual(3);
    // someone has been fighting
    const hurt = [...sim.ents.values()].some((e) => e.inhabitant && e.hp < sim.maxHp(e));
    expect(hurt || dir.kills > 0 || dir.guardDeaths > 0).toBe(true);
    expect(sim.champion()).toBeTruthy();
  });

  it('only allowed archetypes spawn, and at the set level', () => {
    const { sim } = arena({}, { monsters: ['ziz'], monsterLevel: 4, maxAlive: 4, waveSize: 4, spawnEvery: 1 });
    run(sim, 30);
    expect(sim.monsters().length).toBe(4);
    for (const m of sim.monsters()) {
      expect(m.monster!.archetype).toBe('ziz');
      expect(m.level).toBe(4);
    }
  });

  it('a fallen champion comes back at the spawn; the game never crowns a guard', () => {
    const { sim, dir } = arena({}, { championRespawn: 3, autoSpawn: false });
    const c = sim.champion()!;
    kill(sim, c, { amount: 999, type: 'dev', sourceId: -1, sourceKind: 'none' });
    expect(sim.champion()).toBeUndefined();
    run(sim, 20);
    expect(sim.champion()).toBeUndefined();
    run(sim, 20);
    const c2 = sim.champion()!;
    expect(c2).toBeTruthy();
    expect(c2.human!.job).toBe('champion');
    expect(Math.hypot(c2.x - sim.arena.spawn.x, c2.z - sim.arena.spawn.z)).toBeLessThan(0.1);
    expect(dir.guards().length).toBe(3);
    expect(dir.deaths).toBe(1);
  });

  it('fallen guards are replaced; the guard count follows the rules', () => {
    const { sim, dir } = arena({}, { guardRespawn: 2, autoSpawn: false });
    kill(sim, dir.guards()[0], { amount: 999, type: 'dev', sourceId: -1, sourceKind: 'none' });
    expect(dir.guards().length).toBe(2);
    run(sim, 25);
    expect(dir.guards().length).toBe(3);
    dir.apply({ ...dir.rules, guards: 1, guardsFollow: false });
    expect(dir.guards().length).toBe(1);
    expect(dir.guards()[0].tags.includes(FOLLOWER_TAG)).toBe(false);
    dir.apply({ ...dir.rules, guards: 5 });
    run(sim, 2);
    expect(dir.guards().length).toBe(5);
  });

  it('bodies are cleared, and a reset clears the floor', () => {
    const { sim, dir } = arena({}, { bodiesLinger: 2, autoSpawn: false });
    const m = dir.spawnMonster('seir')!;
    kill(sim, m, { amount: 999, type: 'dev', sourceId: -1, sourceKind: 'none' });
    expect([...sim.ents.values()].some((e) => e.kind === 'corpse')).toBe(true);
    run(sim, 30);
    expect([...sim.ents.values()].some((e) => e.kind === 'corpse')).toBe(false);
    dir.spawnMonster('nephil');
    dir.reset();
    expect(sim.monsters().length).toBe(0);
    expect(dir.spawned).toBe(0);
  });

  it('a fixed hour holds the light', () => {
    const { sim, dir } = arena({}, { hour: 23, autoSpawn: false });
    run(sim, 600);
    expect(sim.hour).toBe(23);
    expect(sim.light).toBeLessThan(0.3);
    dir.apply({ ...dir.rules, hour: 12 });
    run(sim, 1);
    expect(sim.light).toBeGreaterThan(0.9);
  });
});
