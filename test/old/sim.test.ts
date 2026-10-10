import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { TICKS_PER_DAY } from '../src/sim/time';
import { sideOf } from '../src/sim/island-gen';
import { findPath } from '../src/sim/pathfind';
import { serializeCore, deserializeCore } from '../src/sim/serialize';

function run(seed: number, days: number) {
  const sim = new Sim(seed);
  sim.generate();
  for (let i = 0; i < days * TICKS_PER_DAY; i++) sim.step();
  return sim;
}

const fingerprint = (sim: Sim) => JSON.stringify(serializeCore(sim));

describe('core sim', () => {
  it('same seed gives the same state after 10 days', () => {
    expect(fingerprint(run(1234, 10))).toBe(fingerprint(run(1234, 10)));
  });

  it('save round-trip continues identically', () => {
    const a = run(77, 2);
    const b = deserializeCore(JSON.parse(JSON.stringify(serializeCore(a))));
    for (let i = 0; i < 900; i++) {
      a.step();
      b.step();
    }
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('births occur within 10 days', () => {
    let births = 0;
    const sim = new Sim(42);
    sim.generate();
    sim.listeners.push({ onDawn: () => (births = sim.history.reduce((s, d) => s + d.births, 0) + sim.dayStats.births) });
    for (let i = 0; i < 10 * TICKS_PER_DAY + 1; i++) sim.step();
    expect(births).toBeGreaterThan(0);
  });

  it('inhabitants eat and sleep every day', () => {
    const sim = run(9, 3);
    for (const d of sim.history) {
      expect(d.ate.monster + d.ate.human).toBeGreaterThan(0);
      expect(d.slept.monster).toBeGreaterThan(0);
      expect(d.slept.human).toBeGreaterThan(0);
    }
  });
});

describe('50-seed sweep', () => {
  for (let seed = 1; seed <= 50; seed++) {
    it(`seed ${seed}`, () => {
      const sim = new Sim(seed);
      sim.generate();
      const L = sim.layout;
      const bushes = [...sim.ents.values()].filter((e) => e.kind === 'berry-bush');
      expect(bushes.length).toBe(24);
      for (const [v, side] of [[L.monsterVillage, 'east'], [L.humanVillage, 'west']] as const) {
        const near = bushes.filter((b) => Math.hypot(b.x - 0.5 - v.x, b.z - 0.5 - v.z) <= 8 && sideOf(L, Math.floor(b.x), Math.floor(b.z)) === side);
        expect(near.length, `${side} bushes near village`).toBeGreaterThanOrEqual(6);
      }
      // every house reachable from every bush on its side
      const houses = [...sim.ents.values()].filter((e) => e.kind === 'house');
      for (const h of houses) {
        const kind = h.faction!;
        const side = kind === 'monster' ? 'east' : 'west';
        for (const b of bushes) {
          if (sideOf(L, Math.floor(b.x), Math.floor(b.z)) !== side) continue;
          const p = findPath(sim.grid, sim.costsFor(kind), Math.floor(b.x), Math.floor(b.z), Math.floor(h.x), Math.floor(h.z), 64 * 64);
          expect(p, `house ${h.id} ← bush ${b.id}`).not.toBeNull();
        }
      }
      for (let i = 0; i < 10 * TICKS_PER_DAY; i++) sim.step();
      expect(sim.inhabitants('monster').length).toBeGreaterThan(0);
      expect(sim.inhabitants('human').length).toBeGreaterThan(0);
    }, 60000);
  }
});
