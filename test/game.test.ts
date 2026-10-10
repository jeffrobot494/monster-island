import { describe, it, expect } from 'vitest';
import { Island } from '../src/sim/island';
import { TileGrid } from '../src/sim/world';
import { generateIsland } from '../src/sim/island-gen';
import { generateMonsters, neighborGraph } from '../src/sim/monsters-gen';
import { issueOrder } from '../src/sim/champion';
import { offerDragged, offerLamb, judgment, scaleFor } from '../src/sim/favor';
import { applyDamage } from '../src/sim/combat';
import { resolveAway } from '../src/sim/offline';
import { reachabilityProblem } from '../src/sim/validator';
import { serializeCore } from '../src/sim/serialize';
import { HOUR_MS, DAY_MS } from '../src/sim/clock';
import { now, START } from './helpers';

const make = (seed = 1, ts = 1) => Island.create(seed, START, ts, { now });

describe('generation', () => {
  it('20 seeds: regions, reachable lairs, 6 distinct monsters, graph degrees 2–3', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const island = make(seed);
      const sim = island.sim;
      expect(reachabilityProblem(sim)).toBeNull();
      const counts = new Array(7).fill(0);
      for (let i = 0; i < sim.grid.region.length; i++) if (sim.grid.region[i] < 7) counts[sim.grid.region[i]]++;
      expect(counts.every((c) => c > 20)).toBe(true);
      const gen = generateMonsters(seed);
      expect(new Set(gen.map((g) => g.archetype)).size).toBe(6);
      const g = neighborGraph(6, seed);
      expect(g.every((n) => n.length >= 2 && n.length <= 3)).toBe(true);
      // connected
      const seen = new Set([0]);
      const q = [0];
      while (q.length) for (const n of g[q.pop()!]) if (!seen.has(n)) { seen.add(n); q.push(n); }
      expect(seen.size).toBe(6);
      expect(sim.humans().length).toBe(21);
    }
  });
  it('island generation is deterministic', () => {
    const a = new TileGrid(), b = new TileGrid();
    generateIsland(5, a);
    generateIsland(5, b);
    expect(a.types.join()).toBe(b.types.join());
  });
});

describe('determinism', () => {
  it('same seed + same orders → same state', () => {
    const run = () => {
      const island = make(3, 60);
      for (let i = 0; i < 4000; i++) {
        if (i === 100) issueOrder(island.sim, { type: 'move', x: 70, z: 70 });
        island.step();
        island.sim.drainOut();
      }
      const c = serializeCore(island.sim);
      return JSON.stringify({ ...c, champState: null });
    };
    expect(run()).toBe(run());
  });
});

describe('combat', () => {
  it('zones cripple, downed at 20 %, kills make corpses, XP flows', () => {
    const sim = make(2).sim;
    const m = sim.monsters()[0];
    const c = sim.champion()!;
    const max = sim.maxHp(m);
    applyDamage(sim, m, 10, { type: 'slash', zone: 'legL', sourceId: c.id });
    applyDamage(sim, m, max * 0.2, { type: 'slash', zone: 'legL', sourceId: c.id });
    expect(m.zones!.legL!.state).not.toBe('ok');
    const r = applyDamage(sim, m, m.hp - max * 0.15, { type: 'crush', zone: 'torso', sourceId: c.id });
    expect(r.downed).toBe(true);
    expect(m.state).toBe('downed');
    expect(c.xp + (c.level - 3) * 1000).toBeGreaterThan(0);
    applyDamage(sim, m, 999, { type: 'crush', sourceId: c.id });
    expect(sim.ents.has(m.id)).toBe(false);
    const corpse = [...sim.ents.values()].find((e) => e.kind === 'corpse');
    expect(corpse?.corpse?.deathType).toBe('crushed');
    expect(sim.stats.monsterKills).toBe(1);
  });
});

describe('capture loop', () => {
  it('down a monster, bind it, drag it to the altar, offer it → favor = max HP and it dies', () => {
    const island = make(4);
    const sim = island.sim;
    sim.invincible = true;
    const c = sim.champion()!;
    const m = sim.monsters().find((x) => x.monster!.region !== 6)!;
    // walk the champion up to the lair
    const p = sim.nearestWalkable(c, m.x + 1, m.z, 3)!;
    c.x = p.x + 0.5;
    c.z = p.z + 0.5;
    issueOrder(sim, { type: 'attack', id: m.id });
    let t = 0;
    while (m.state !== 'downed' && t++ < 3000) {
      if (!sim.order && m.state !== 'downed') issueOrder(sim, { type: 'attack', id: m.id });
      island.step();
    }
    expect(m.state).toBe('downed');
    const maxHp = Math.round(sim.maxHp(m));
    issueOrder(sim, { type: 'bind', id: m.id });
    t = 0;
    while (sim.dragging !== m.id && t++ < 200) island.step();
    expect(m.state).toBe('bound');
    const A = sim.layout.villageAltar;
    issueOrder(sim, { type: 'move', x: A.x + 0.5, z: A.z + 1.5 });
    t = 0;
    while (Math.hypot(c.x - A.x - 0.5, c.z - A.z - 0.5) > 2.4 && t++ < 20000) {
      if (!sim.order) issueOrder(sim, { type: 'move', x: A.x + 0.5, z: A.z + 1.5 });
      island.step();
    }
    expect(m.state).toBe('bound');
    const before = sim.favor.human;
    expect(offerDragged(sim)).toBeNull();
    expect(sim.favor.human - before).toBe(maxHp);
    expect(sim.ents.has(m.id)).toBe(false);
  });
});

describe('judgment', () => {
  it('ties rest, scales follow thresholds, the queue is capped, favor resets', () => {
    const sim = make(1).sim;
    expect([99, 100, 299, 300, 599, 600, 999, 1000].map(scaleFor)).toEqual([1, 2, 2, 3, 3, 4, 4, 5]);
    sim.favor = { human: 50, monster: 50 };
    judgment(sim);
    expect(sim.pendingCreations.length).toBe(0);
    for (let k = 0; k < 5; k++) {
      sim.nightIndex++;
      sim.favor = { human: 0, monster: 650 };
      judgment(sim);
    }
    expect(sim.pendingCreations.length).toBe(3);
    expect(sim.pendingCreations[0].scale).toBe(4);
    expect(sim.favor).toEqual({ human: 0, monster: 0 });
    // a lamb at the altar
    const c = sim.champion()!;
    c.x = sim.layout.villageAltar.x + 0.5;
    c.z = sim.layout.villageAltar.z + 1.5;
    expect(offerLamb(sim)).toBeNull();
    expect(sim.favor.human).toBe(40);
    expect(sim.fold).toBe(5);
  });
  it('the clock fires Judgment once per night', () => {
    const island = make(1, 1);
    const sim = island.sim;
    sim.advanceClock(DAY_MS);
    const n = sim.nightIndex;
    expect(n).toBe(1);
    sim.advanceClock(HOUR_MS);
    expect(sim.nightIndex).toBe(1);
  });
});

describe('away resolver', () => {
  it('24 h away: things happen, one Judgment runs, deterministic', () => {
    const run = () => {
      const sim = make(6).sim;
      const s = resolveAway(sim, DAY_MS, DAY_MS);
      return { s, humans: sim.humans().length, night: sim.nightIndex, food: Math.round(sim.food), favor: sim.favor };
    };
    const a = run(), b = run();
    expect(a).toEqual(b);
    expect(a.night).toBe(1);
    expect(a.s.judgments.length).toBe(1);
    expect(a.food).not.toBe(300);
  });
  it('a week away is survivable early but costs lives', () => {
    const sim = make(8).sim;
    resolveAway(sim, 7 * DAY_MS, 7 * DAY_MS);
    const h = sim.humans().length;
    console.log('after a week away:', h, 'humans,', sim.monsters().length, 'monsters, food', Math.round(sim.food));
    expect(h).toBeLessThan(21);
  });
});
