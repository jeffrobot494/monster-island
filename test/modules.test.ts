import { describe, it, expect } from 'vitest';
import { Island } from '../src/sim/island';
import { validateCandidate } from '../src/sim/validator';
import { nodeLoader, now, refSource, START } from './helpers';

const world = () => JSON.stringify(Island.create(7, START, 1, { now }).serialize());

describe('reference creations pass the validator', () => {
  for (const name of ['war-hounds', 'poison-fog'] as const) {
    it(name, async () => {
      const r = await validateCandidate({ world: world(), sources: {}, candidate: { id: name, source: refSource(name) }, suspends: [] }, { loader: nodeLoader, now });
      if (!r.ok) console.log(JSON.stringify(r, null, 1));
      expect(r.ok).toBe(true);
    }, 120_000);
  }
});

describe('broken creations are rejected', () => {
  const cases: [string, string, string][] = [
    ['uses Math.random', `export default { id: 'x', title: 't', define() {}, hooks: { onTick(api) { Math.random(); } }, tests: [{ name: 'a', ticks: 1, check: () => true }] };`, 'static'],
    ['throws in onTick', `export default { id: 'x', title: 't', define() {}, hooks: { onTick(api) { if (api.time.tick > 50) throw new Error('boom'); } }, tests: [{ name: 'a', ticks: 1, check: () => true }] };`, 'soak'],
    ['invisible', `export default { id: 'x', title: 't', define() {}, tests: [{ name: 'a', ticks: 1, check: () => true }] };`, 'visibility'],
    ['wipes out the villagers', `export default { id: 'x', title: 't', define() {}, hooks: { onHour(api) { for (const h of api.ent.query({ kind: 'human' })) api.ent.kill(h); } }, tests: [{ name: 'a', ticks: 1, check: () => true }] };`, 'soak'],
    ['removes a human directly', `export default { id: 'x', title: 't', define() {}, hooks: { onTick(api) { const h = api.ent.query({ kind: 'human' })[0]; if (h) api.ent.remove(h); } }, tests: [{ name: 'a', ticks: 1, check: () => true }] };`, 'soak'],
  ];
  for (const [label, src, check] of cases) {
    it(label, async () => {
      const r = await validateCandidate({ world: world(), sources: {}, candidate: { id: 'x', source: src }, suspends: [] }, { loader: nodeLoader, now });
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => !c.ok)?.check).toBe(check);
    }, 120_000);
  }
});
