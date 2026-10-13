// Tests for work that lives in src/arena/sandbox/ (src/arena/README.md). They run only under the arena's config
// (`npm run arena:test`), where the sandbox copies stand in for the game's files. When you promote a file, move its
// tests into the game's own test files (without the runIf) so the game keeps them.
import { describe, it, expect } from 'vitest';
import { ArenaSim } from '../src/arena/arena-sim';
import { ArenaDirector } from '../src/arena/director';
import { DEFAULT_SHAPE } from '../src/arena/geometry';
import { DEFAULT_RULES, type ArenaRules } from '../src/arena/rules';
import { issueOrder } from '../src/sim/champion';
import { START } from './helpers';

function arena(rules: Partial<ArenaRules> = {}) {
  const sim = new ArenaSim(11);
  sim.build({ ...DEFAULT_SHAPE, density: 'none' }, START, 180);
  const dir = new ArenaDirector(sim, { ...DEFAULT_RULES, autoSpawn: false, ...rules });
  dir.reset();
  return { sim, dir };
}

const run = (sim: ArenaSim, ticks: number, each?: (i: number) => void) => {
  for (let i = 0; i < ticks; i++) {
    sim.step();
    sim.drainOut();
    each?.(i);
  }
};

describe.runIf(import.meta.env.VITE_ARENA)('sandbox: sim/monster-ai.ts', () => {
  it('raiders with no house to break into prowl the village instead of standing still', () => {
    const { sim, dir } = arena({ guards: 0, invincible: true });
    // the champion out of their sight, on the far side
    const c = sim.champion()!;
    c.z = sim.arena.spawn.z + 4;
    const m = dir.spawnMonster('reem')!;
    const x0 = m.x, z0 = m.z;
    let moved = 0, px = m.x, pz = m.z;
    run(sim, 600, () => {
      moved += Math.hypot(m.x - px, m.z - pz);
      px = m.x;
      pz = m.z;
    });
    expect(moved).toBeGreaterThan(15);
    expect(Math.hypot(m.x - x0, m.z - z0)).toBeGreaterThan(2);
  });
});

describe.runIf(import.meta.env.VITE_ARENA)('sandbox: sim/village.ts (followers)', () => {
  it('followers keep up with a walking champion', () => {
    const { sim, dir } = arena({ guards: 3, guardsFollow: true });
    const c = sim.champion()!;
    const s = sim.arena.spawn;
    issueOrder(sim, { type: 'move', x: s.x, z: s.z - 18 });
    let worst = 0;
    run(sim, 900, (i) => {
      if (i > 300) for (const g of dir.guards()) worst = Math.max(worst, Math.hypot(g.x - c.x, g.z - c.z));
    });
    expect(Math.hypot(c.x - s.x, c.z - (s.z - 18))).toBeLessThan(2);
    for (const g of dir.guards()) expect(Math.hypot(g.x - c.x, g.z - c.z)).toBeLessThan(3);
    expect(worst).toBeLessThan(8);
  });

  it('followers fight a monster near the champion; guards holding posts stay put', () => {
    const { sim, dir } = arena({ guards: 2, guardsFollow: true, invincible: true });
    const c = sim.champion()!;
    const m = dir.spawnMonster('seir')!;
    m.x = c.x + 3;
    m.z = c.z - 3;
    run(sim, 200);
    expect(dir.guards().some((g) => g.state === 'fight' || g.state === 'downed') || m.hp < sim.maxHp(m)).toBe(true);

    // hold posts: walk away and they don't come
    const b = arena({ guards: 2, guardsFollow: false });
    const c2 = b.sim.champion()!;
    issueOrder(b.sim, { type: 'move', x: c2.x, z: c2.z - 15 });
    run(b.sim, 600);
    for (const g of b.dir.guards()) expect(Math.hypot(g.x - c2.x, g.z - c2.z)).toBeGreaterThan(8);
  });
});
