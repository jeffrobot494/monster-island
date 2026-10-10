import { describe, expect, it } from 'vitest';
import { checkSource } from '../src/sim/ast-check';
import { Island } from '../src/sim/island';
import { TICKS_PER_DAY } from '../src/sim/time';
import { validateCandidate } from '../src/sim/validator';
import { nodeLoader, now, refSource } from './helpers';

const env = { loader: nodeLoader, now };

async function liveIsland(seed = 5) {
  const faults: string[] = [];
  const quarantined: string[] = [];
  const island = Island.create(seed, { now, onFault: (f) => faults.push(`${f.id}:${f.hook}:${f.error}`), onQuarantine: (id) => quarantined.push(id) });
  return { island, faults, quarantined };
}

function mod(id: string, body: string) {
  return `export default {
  id: '${id}', title: 'Test ${id}', description: 'test',
  define(api) {},
  ${body}
  tests: [{ name: 't', start: 'dawn', ticks: 10, check(api) { return true; } }],
};`;
}

describe('ast check', () => {
  it('accepts the reference modules', () => {
    expect(checkSource(refSource('fireflies'))).toEqual([]);
    expect(checkSource(refSource('wading'))).toEqual([]);
  });
  it('rejects nondeterminism and escapes', () => {
    const rules = (src: string) => checkSource(src).map((i) => i.rule);
    expect(rules(`export default { a() { return Math.random(); } }`)).toContain('no-random');
    expect(rules(`export default { a() { return Math['ran' + 'dom'](); } }`)).toContain('no-computed-global');
    expect(rules(`export default { a() { return Date.now(); } }`)).toContain('no-free-identifier');
    expect(rules(`export default { a() { setTimeout(() => 1, 5); } }`)).toContain('no-free-identifier');
    expect(rules(`export default { async a() {} }`)).toContain('no-async');
    expect(rules(`export default { a() { return ({}).constructor; } }`)).toContain('no-constructor');
    expect(rules(`import x from 'y'; export default {}`)).toContain('no-import');
    expect(rules(`export const a = 1; export default {}`)).toContain('single-default-export');
    // words in comments and strings never match
    expect(checkSource(`// Math.random Date fetch\nexport default { s: 'Math.random() Date' }`)).toEqual([]);
  });
});

describe('module runtime', () => {
  it('reference modules install, run, and survive a reload', async () => {
    const { island, faults } = await liveIsland();
    for (const name of ['fireflies', 'wading'] as const) island.install(name, await nodeLoader(name, refSource(name)));
    for (let i = 0; i < 2 * TICKS_PER_DAY; i++) island.step();
    expect(faults).toEqual([]);
    expect(island.runtime.byId.get('fireflies')!.state.nights).toBe(2);
    const saved = JSON.parse(JSON.stringify(island.serialize()));
    const sources = { fireflies: refSource('fireflies'), wading: refSource('wading') };
    const reloaded = await Island.load(saved, sources, nodeLoader, { now });
    expect(reloaded.manifest.map((m) => m.status)).toEqual(['active', 'active']);
    expect(reloaded.runtime.byId.get('fireflies')!.state.nights).toBe(2);
    // the reload continues identically
    for (let i = 0; i < 1300; i++) {
      island.step();
      reloaded.step();
    }
    expect(JSON.stringify(reloaded.serialize().core)).toBe(JSON.stringify(island.serialize().core));
    expect([...reloaded.sim.ents.values()].some((e) => e.kind === 'firefly')).toBe(true);
  });

  it('quarantines a module that throws repeatedly, and the island keeps running', async () => {
    const { island, quarantined } = await liveIsland();
    island.install('thrower', await nodeLoader('thrower', mod('thrower', `hooks: { onTick(api) { throw new Error('boom'); } },`)));
    for (let i = 0; i < 100; i++) island.step();
    expect(quarantined).toEqual(['thrower']);
    expect(island.runtime.byId.get('thrower')!.status).toBe('quarantined');
    expect(island.sim.inhabitants().length).toBeGreaterThan(0);
  });

  it('writes to frozen views throw', async () => {
    const { island, faults } = await liveIsland();
    island.install('writer', await nodeLoader('writer', mod('writer', `hooks: { onTick(api) { const e = api.ent.query({ kind: 'human' })[0]; e.speed = 9; } },`)));
    island.step();
    expect(faults[0]).toMatch(/read only|read-only|Cannot assign/);
  });
});

describe('validator', () => {
  const live = async () => {
    const { island } = await liveIsland(11);
    for (let i = 0; i < 700; i++) island.step();
    return JSON.stringify(island.serialize());
  };

  for (const name of ['fireflies', 'wading'] as const) {
    it(`passes the ${name} reference module`, async () => {
      const r = await validateCandidate({ world: await live(), sources: {}, candidate: { id: name, source: refSource(name) }, suspends: [] }, env);
      expect(r.checks.filter((c) => !c.ok), JSON.stringify(r, null, 1)).toEqual([]);
      expect(r.ok).toBe(true);
    }, 120000);
  }

  const broken: [string, string, string][] = [
    ['throws', mod('bad', `hooks: { onDusk(api) { api.vis.emote(api.ent.query({kind:'human'})[0], '!', 1); throw new Error('kaput'); } },`), 'soak'],
    ['invisible', mod('bad', `hooks: { onTick(api) { api.state.n = (api.state.n || 0) + 1; } },`), 'visibility'],
    ['unserializable', mod('bad', `init(api) { api.state.m = new Map(); }, hooks: { onDawn(api) { api.vis.atmosphere({ skyTint: '#ff00ff' }); } },`), 'round-trip'],
    ['frozen write', mod('bad', `hooks: { onTick(api) { const e = api.ent.query({ kind: 'human' })[0]; api.vis.emote(e, '!', 1); e.hunger = 0; } },`), 'soak'],
    ['Math.random', mod('bad', `hooks: { onTick(api) { if (Math.random() < 0.1) api.log('x'); } },`), 'static'],
    ['bad id', mod('wrong', `hooks: {},`), 'static'],
    ['failing test', mod('bad', `hooks: { onDawn(api) { api.vis.atmosphere({ fogDensity: 0.3 }); } },`).replace('return true;', "return 'nope';"), 'tests'],
  ];
  for (const [label, source, check] of broken) {
    it(`catches a broken module: ${label}`, async () => {
      const r = await validateCandidate({ world: await live(), sources: {}, candidate: { id: 'bad', source }, suspends: [] }, env);
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => !c.ok)?.check, JSON.stringify(r.checks)).toBe(check);
    }, 120000);
  }
});
