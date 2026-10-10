// Candidate validation (§11.8 + R28): static → install → (A) 2-day fast-clock soak with scripted events →
// reachability → (B) live-rate segment → (C) 24 h away resolver → visibility → save round-trip → module tests.
import { checkSource } from './ast-check';
import { Island, type ModuleLoader, type SavedWorld } from './island';
import { HOOKS, MODULE_ENTITY_BUDGET, MODULE_STATE_CAP, type FaultInfo, type ModuleDef, type ModuleRecord } from './module-runtime';
import { DAY_MS, GAME_TIMESCALE, HOUR_MS, MS_PER_REAL_TICK, calDay, hourOf } from './clock';
import { SIZE } from './world';
import type { Sim } from './sim';
import { kill, applyDamage } from './combat';
import { offerFavor } from './favor';
import { resolveAway } from './offline';

export const MAX_SOURCE_BYTES = 30 * 1024;
export const FAST_MS_PER_TICK = 14_400; // a game day = 6000 ticks
export const LIVE_MS_PER_TICK = MS_PER_REAL_TICK * GAME_TIMESCALE; // the game's own clock: a day = 4800 ticks
export const SOAK_TICKS = 12_000;
export const LIVE_TICKS = 6000;
export const TEST_MAX_TICKS = 6000;
export type Suspendable = 'faction-survival';

export interface ValidationRequest {
  world: string;
  sources: Record<string, string>;
  candidate: { id: string; source: string };
  suspends: Suspendable[];
}

export interface CheckResult {
  check: string;
  ok: boolean;
  message?: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: CheckResult[];
  errors: { hook: string; error: string; line?: number }[];
  tests: { name: string; ok: boolean; message?: string }[];
  invariants: Record<string, number | string | boolean>;
  visible?: { what: string; count: number };
  msPerTick?: number;
}

export interface ValidatorEnv {
  loader: ModuleLoader;
  now: () => number;
  progress?: (stage: string) => void;
  runLimitMs?: number;
}

class Abort extends Error {}

export function jsonUnsafePath(v: unknown, path = 'state', seen = new Set<unknown>()): string | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${path} is ${v}`;
  if (typeof v !== 'object') return `${path} is a ${typeof v}`;
  if (seen.has(v)) return `${path} is a circular reference`;
  seen.add(v);
  const proto = Object.getPrototypeOf(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = jsonUnsafePath(v[i], `${path}[${i}]`, seen);
      if (r) return r;
    }
  } else if (proto === Object.prototype || proto === null) {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      const r = jsonUnsafePath(x, `${path}.${k}`, seen);
      if (r) return r;
    }
  } else {
    return `${path} is a ${proto?.constructor?.name ?? 'non-plain object'} (only plain objects, arrays, numbers, strings, booleans, null)`;
  }
  seen.delete(v);
  return null;
}

/** Jump the clock forward (without firing boundaries) to the next occurrence of `hour`. */
export function jumpClockTo(sim: Sim, hour: number) {
  const now = hourOf(sim.clockMs);
  let dh = hour - now;
  if (dh <= 0) dh += 24;
  sim.clockMs += dh * HOUR_MS;
  sim.lastJudgedCalDay = hour < 1 ? calDay(sim.clockMs) - 1 : calDay(sim.clockMs);
  sim.light = sim.computeLight();
}

/** Walker reachability between the inner gate, both altars and every live lair. */
export function reachabilityProblem(sim: Sim): string | null {
  const L = sim.layout;
  const seen = new Uint8Array(SIZE * SIZE);
  const start = L.gates[0].z * SIZE + L.gates[0].x;
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const i = q.pop()!;
    const x = i % SIZE, z = (i / SIZE) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!sim.grid.inBounds(nx, nz)) continue;
      const j = nz * SIZE + nx;
      if (seen[j] || !sim.walkableFor('human', nx, nz)) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  const ok = (p: { x: number; z: number }) => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (seen[(p.z + dz) * SIZE + p.x + dx]) return true;
    return false;
  };
  if (!ok(L.villageAltar)) return 'the village altar can no longer be reached from the gate';
  if (!ok(L.highAltar)) return 'the High Place altar can no longer be reached from the village';
  for (const m of sim.monsters()) if (!ok(L.lairs[m.monster!.region])) return `the lair in region ${m.monster!.region} can no longer be reached on foot`;
  return null;
}

export async function validateCandidate(req: ValidationRequest, env: ValidatorEnv): Promise<ValidationReport> {
  const report: ValidationReport = { ok: false, checks: [], errors: [], tests: [], invariants: {} };
  const { id, source } = req.candidate;
  const pass = (check: string) => report.checks.push({ check, ok: true });
  const failCheck = (check: string, message: string) => {
    report.checks.push({ check, ok: false, message });
    return report;
  };
  const limit = env.runLimitMs ?? 90_000;

  // 1. Static
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) return failCheck('static', `source is larger than ${MAX_SOURCE_BYTES / 1024} KB`);
  const issues = checkSource(source);
  if (issues.length) return failCheck('static', issues.map((i) => `line ${i.line}: [${i.rule}] ${i.message}`).join('\n'));
  let def: ModuleDef;
  try {
    def = await env.loader(id, source);
  } catch (err) {
    return failCheck('static', `import failed: ${(err as Error).message}`);
  }
  const shapeErr = checkShapeOfDef(def, id);
  if (shapeErr) return failCheck('static', shapeErr);
  const world: SavedWorld = JSON.parse(req.world);
  for (const r of def.requires ?? []) {
    const m = world.manifest.find((x) => x.id === r);
    if (!m || m.status !== 'active') return failCheck('static', `requires '${r}', which is not installed and active`);
  }
  pass('static');
  env.progress?.('static');

  const faults: FaultInfo[] = [];
  const opts = {
    now: env.now,
    onFault: (f: FaultInfo) => {
      if (f.id === id) faults.push(f);
    },
  };
  const recordErrors = () => {
    for (const f of faults.slice(report.errors.length, 5)) report.errors.push({ hook: f.hook, error: f.error, line: f.line });
  };

  /** fresh clone of the live world on a chosen clock, candidate installed */
  const clone = async (msPerTick: number, hour: number): Promise<{ island: Island; mod: ModuleRecord }> => {
    const island = await Island.load(world, req.sources, env.loader, opts);
    const sim = island.sim;
    sim.judgmentEnabled = false;
    sim.msPerTick = msPerTick;
    sim.gameOver = null;
    sim.lastRealMs = 0;
    jumpClockTo(sim, hour);
    const fresh = await env.loader(id, source);
    island.install(id, fresh);
    return { island, mod: island.runtime.byId.get(id)! };
  };
  const runTicks = (island: Island, n: number, stage: string, script?: (i: number) => void) => {
    const t0 = env.now();
    for (let i = 0; i < n; i++) {
      script?.(i);
      island.step();
      if (i % 300 === 299) {
        env.progress?.(stage);
        if (env.now() - t0 > limit) throw new Abort(`${stage} took longer than ${limit / 1000}s (treated as a hang)`);
      }
    }
    island.sim.drainOut();
  };
  const invariants = (sim: Sim, mod: ModuleRecord, tag: string): string[] => {
    const fails: string[] = [];
    let bad = 0, modEnts = 0;
    for (const e of sim.ents.values()) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.z) || e.x < 0 || e.z < 0 || e.x > SIZE || e.z > SIZE || !Number.isFinite(e.hp)) bad++;
      if (e.owner) modEnts++;
    }
    const humans = sim.humans().filter((h) => h.id !== sim.championId).length;
    const monsters = sim.monsters().length;
    report.invariants[`${tag}.humans`] = humans;
    report.invariants[`${tag}.monsters`] = monsters;
    report.invariants[`${tag}.moduleEntities`] = modEnts;
    if (bad) fails.push(`${tag}: ${bad} entities have NaN/out-of-bounds positions or HP`);
    if (modEnts > MODULE_ENTITY_BUDGET) fails.push(`${tag}: ${modEnts} creation entities exceed the budget of ${MODULE_ENTITY_BUDGET}`);
    if (!req.suspends.includes('faction-survival')) {
      if (!humans) fails.push(`${tag}: the villagers were wiped out`);
      if (!monsters) fails.push(`${tag}: the monsters were wiped out`);
    }
    if (mod.status === 'quarantined') fails.push(`${tag}: the module was quarantined`);
    return fails;
  };

  // 2. Install
  let island: Island, mod: ModuleRecord;
  try {
    ({ island, mod } = await clone(FAST_MS_PER_TICK, 5));
  } catch (err) {
    return failCheck('install', `define/init threw: ${(err as Error).message}`);
  }
  pass('install');
  env.progress?.('install');

  // 3. (A) fast-clock soak with scripted events
  const sim = island.sim;
  const t0 = env.now();
  try {
    runTicks(island, SOAK_TICKS, 'soak', (i) => {
      if (i === 400) {
        const v = sim.humans().find((h) => h.id !== sim.championId && !h.hidden);
        if (v) kill(sim, v, { amount: 999, type: 'bite', sourceId: -1, sourceKind: 'validator', deathType: 'bitten' });
      } else if (i === 800) {
        const m = sim.monsters()[0];
        if (m) applyDamage(sim, m, 50, { type: 'slash', sourceId: sim.championId });
      } else if (i === 1200) offerFavor(sim, 'human', 40, 'village', 'lamb');
      else if (i === 1600) {
        const a = [...sim.ents.values()].find((e) => e.kind === 'animal');
        if (a) {
          kill(sim, a, { amount: 999, type: 'pierce', sourceId: -1, sourceKind: 'validator', deathType: 'impaled' });
          offerFavor(sim, 'monster', 40, 'high', 'goat');
        }
      }
    });
  } catch (err) {
    if (err instanceof Abort) return failCheck('soak', err.message);
    throw err;
  }
  report.msPerTick = Math.round(((env.now() - t0) / SOAK_TICKS) * 1000) / 1000;
  const fails = invariants(sim, mod, 'soak');
  if (faults.length) fails.push(`the candidate threw ${faults.length} error(s) during the soak`);
  const size = island.runtime.stateSize(mod);
  report.invariants.stateBytes = size;
  if (size > MODULE_STATE_CAP) fails.push(`module state is ${size} bytes, over the ${MODULE_STATE_CAP} byte cap`);
  const reach = reachabilityProblem(sim);
  if (reach) fails.push(reach);
  recordErrors();
  if (fails.length) return failCheck('soak', fails.join('; '));
  pass('soak');

  // 4. (B) live clock rate (catches per-tick effects tuned against the fast clock)
  try {
    const nf = faults.length;
    const { island: b, mod: bm } = await clone(LIVE_MS_PER_TICK, 22);
    runTicks(b, LIVE_TICKS, 'live-rate');
    const f2 = invariants(b.sim, bm, 'live');
    if (faults.length > nf) f2.push(`the candidate threw ${faults.length - nf} error(s) at the live clock rate`);
    recordErrors();
    if (f2.length) return failCheck('live-rate', f2.join('; '));
  } catch (err) {
    return failCheck('live-rate', err instanceof Abort ? err.message : `failed: ${(err as Error).message}`);
  }
  pass('live-rate');
  env.progress?.('live-rate');

  // 5. (C) a day away (hooks run hour by hour in the resolver)
  try {
    const nf = faults.length;
    const { island: c, mod: cm } = await clone(LIVE_MS_PER_TICK, 9);
    resolveAway(c.sim, DAY_MS, DAY_MS);
    c.sim.drainOut();
    const f3 = invariants(c.sim, cm, 'away');
    if (faults.length > nf) f3.push(`the candidate threw ${faults.length - nf} error(s) while the player was away`);
    recordErrors();
    if (f3.length) return failCheck('away', f3.join('; '));
  } catch (err) {
    return failCheck('away', `failed: ${(err as Error).message}`);
  }
  pass('away');

  // 6. Visibility (credited during the soak)
  report.visible = { what: mod.visible?.what ?? 'none', count: mod.visibleCount };
  if (!mod.visibleCount) return failCheck('visibility', 'invisible change: during the 2-day soak the module never spawned, changed a tile, emitted particles, set a shape/tint, emoted/spoke, changed the atmosphere, damaged/modified a creature, changed a rule outcome, or had a behavior selected');
  pass('visibility');

  // 7. Save round-trip
  try {
    const unsafe = jsonUnsafePath(mod.state, 'api.state')
      ?? [...sim.ents.values()].map((e) => (e.data[id] ? jsonUnsafePath(e.data[id], `api.data(entity ${e.id})`) : null)).find(Boolean)
      ?? [...mod.tileData].map(([i, d]) => jsonUnsafePath(d, `tileData(${i % SIZE},${Math.floor(i / SIZE)})`)).find(Boolean);
    if (unsafe) return failCheck('round-trip', `module data is not JSON-serializable: ${unsafe}`);
    const savedJson = JSON.stringify(island.serialize());
    const before = JSON.parse(savedJson) as SavedWorld;
    const reloaded = await Island.load(before, { ...req.sources, [id]: source }, env.loader, opts);
    reloaded.sim.judgmentEnabled = false;
    const rmod = reloaded.runtime.byId.get(id);
    if (!rmod || rmod.status !== 'active') return failCheck('round-trip', `module did not reload active${rmod ? ' (quarantined on load)' : ''}`);
    const after = reloaded.serialize();
    if (JSON.stringify(after.modules.mods[id]) !== JSON.stringify(before.modules.mods[id])) return failCheck('round-trip', 'module state/tileData changed across save and reload');
    const nBefore = faults.length;
    runTicks(reloaded, 100, 'round-trip');
    if (faults.length > nBefore) {
      recordErrors();
      return failCheck('round-trip', `the module threw ${faults.length - nBefore} error(s) in the 100 ticks after reload (define is re-run on load, init is not)`);
    }
  } catch (err) {
    return failCheck('round-trip', err instanceof Abort ? err.message : `save/reload failed: ${(err as Error).message}`);
  }
  pass('round-trip');
  env.progress?.('round-trip');

  // 8. Module tests (fresh fast-clock clone each)
  let allTests = true;
  for (const test of def.tests ?? []) {
    const name = typeof test.name === 'string' ? test.name : 'unnamed test';
    try {
      const nf = faults.length;
      const hour = test.start === 'dusk' ? 18 : test.start === 'night' ? 23 : 6;
      const { island: c, mod: m } = await clone(FAST_MS_PER_TICK, hour);
      if (test.setup) runModuleCode(() => test.setup!(m.api));
      runTicks(c, Math.min(TEST_MAX_TICKS, Math.max(0, Math.floor(test.ticks))), `test ${name}`);
      const r = runModuleCode(() => test.check(m.api));
      if (faults.length > nf) {
        recordErrors();
        report.tests.push({ name, ok: false, message: `the module threw during the test: ${faults[nf].error}` });
        allTests = false;
      } else if (r !== true) {
        report.tests.push({ name, ok: false, message: typeof r === 'string' ? r : `check returned ${JSON.stringify(r)} (expected true)` });
        allTests = false;
      } else report.tests.push({ name, ok: true });
    } catch (err) {
      report.tests.push({ name, ok: false, message: err instanceof Abort ? err.message : `test threw: ${(err as Error).message}` });
      allTests = false;
    }
    env.progress?.(`test ${name}`);
  }
  if (!allTests) return failCheck('tests', report.tests.filter((t) => !t.ok).map((t) => `${t.name}: ${t.message}`).join('; '));
  pass('tests');

  report.ok = true;
  return report;
}

function runModuleCode<T>(fn: () => T): T {
  const r = fn();
  if (r && typeof (r as any).then === 'function') throw new Error('test functions must be synchronous');
  return r;
}

function checkShapeOfDef(def: ModuleDef, id: string): string | null {
  if (!def || typeof def !== 'object') return 'the default export must be an object';
  if (def.id !== id) return `the default export's id must be '${id}' (got ${JSON.stringify(def.id)})`;
  if (typeof def.title !== 'string' || !def.title) return 'the default export needs a title string';
  if (typeof def.define !== 'function') return 'the default export needs a define(api) function (it may be empty)';
  const tests = def.tests;
  if (!Array.isArray(tests) || tests.length < 1 || tests.length > 3) return 'the module needs 1–3 tests';
  for (const t of tests) {
    if (!t || typeof t.check !== 'function') return 'every test needs a check(api) function';
    if (typeof t.ticks !== 'number' || !(t.ticks >= 0 && t.ticks <= TEST_MAX_TICKS)) return `test ticks must be a number from 0 to ${TEST_MAX_TICKS}`;
    if (t.start !== undefined && !['dawn', 'dusk', 'night'].includes(t.start)) return "test start must be 'dawn', 'dusk' or 'night'";
  }
  if (def.hooks !== undefined && (typeof def.hooks !== 'object' || def.hooks === null)) return 'hooks must be an object';
  for (const k of Object.keys(def.hooks ?? {})) if (!(HOOKS as readonly string[]).includes(k)) return `unknown hook '${k}' (allowed: ${HOOKS.join(', ')})`;
  for (const b of def.behaviors ?? []) {
    if (!b || typeof b.id !== 'string' || typeof b.score !== 'function' || typeof b.act !== 'function') return 'every behavior needs id, score(api, e) and act(api, e)';
  }
  return null;
}
