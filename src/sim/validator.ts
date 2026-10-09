// Candidate validation (§8, Phase 1): static → install → dawn clone → 2-day soak → tests → visibility → round-trip.
import { checkSource } from './ast-check';
import { Island, type ModuleLoader, type SavedWorld } from './island';
import { MODULE_STATE_CAP, type FaultInfo, type ModuleDef, type ModuleRecord } from './module-runtime';
import { DUSK_TICK, TICKS_PER_DAY } from './time';
import { CORE_BEHAVIORS, ENTITY_CAP } from './sim';
import { SIZE } from './world';

export const MAX_SOURCE_BYTES = 30 * 1024;
export const SOAK_TICKS = 2 * TICKS_PER_DAY;
export type Suspendable = 'eat' | 'sleep' | 'faction-survival';

export interface ValidationRequest {
  world: string; // SavedWorld JSON of the live island
  sources: Record<string, string>; // sources of installed modules
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
  /** called between phases/periodically so a host can detect hangs */
  progress?: (stage: string) => void;
  runLimitMs?: number;
}

class Abort extends Error {}

/** Find the first non-JSON-safe value (Map, function, NaN, cycles...) in module-owned data. */
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

export async function validateCandidate(req: ValidationRequest, env: ValidatorEnv): Promise<ValidationReport> {
  const report: ValidationReport = { ok: false, checks: [], errors: [], tests: [], invariants: {} };
  const { id, source } = req.candidate;
  const pass = (check: string) => report.checks.push({ check, ok: true });
  const failCheck = (check: string, message: string) => {
    report.checks.push({ check, ok: false, message });
    return report;
  };
  const limit = env.runLimitMs ?? 60_000;

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
    for (const f of faults.slice(0, 5 - report.errors.length)) report.errors.push({ hook: f.hook, error: f.error, line: f.line });
  };

  /** fresh clone of the live world, advanced to the next dawn, with the candidate installed */
  const dawnClone = async (): Promise<{ island: Island; mod: ModuleRecord }> => {
    const island = await Island.load(world, req.sources, env.loader, opts);
    const toDawn = (TICKS_PER_DAY - (island.sim.tick % TICKS_PER_DAY)) % TICKS_PER_DAY;
    for (let i = 0; i < toDawn; i++) island.step();
    // step() lands on dayTick 0 and runs dawn; install right after so the candidate starts fresh at dawn
    const fresh = await env.loader(id, source);
    island.install(id, fresh);
    return { island, mod: island.runtime.byId.get(id)! };
  };
  const runTicks = (island: Island, n: number, stage: string) => {
    const t0 = env.now();
    for (let i = 0; i < n; i++) {
      island.step();
      if (i % 300 === 299) {
        env.progress?.(stage);
        if (env.now() - t0 > limit) throw new Abort(`${stage} took longer than ${limit / 1000}s (treated as a hang)`);
      }
    }
    island.sim.drainOut();
  };

  // 2. Install
  let island: Island, mod: ModuleRecord;
  try {
    ({ island, mod } = await dawnClone());
  } catch (err) {
    return failCheck('install', `define/init threw: ${(err as Error).message}`);
  }
  pass('install');
  env.progress?.('install');

  // 3–4. Soak + absolute invariants
  const startDay = island.sim.time.day;
  const t0 = env.now();
  try {
    runTicks(island, SOAK_TICKS, 'soak');
  } catch (err) {
    if (err instanceof Abort) return failCheck('soak', err.message);
    throw err;
  }
  report.msPerTick = Math.round(((env.now() - t0) / SOAK_TICKS) * 1000) / 1000;
  const sim = island.sim;
  // close out the last soaked day
  const days = [...sim.history.filter((d) => d.day >= startDay), sim.dayStats].filter((d) => d.day < startDay + 2);
  const inv = report.invariants;
  inv.candidateErrors = faults.length;
  inv.quarantined = mod.status === 'quarantined';
  let badPos = 0;
  for (const e of sim.ents.values()) if (!Number.isFinite(e.x) || !Number.isFinite(e.z) || e.x < 0 || e.z < 0 || e.x > SIZE || e.z > SIZE || !Number.isFinite(e.hp) || !Number.isFinite(e.hunger)) badPos++;
  inv.badPositions = badPos;
  inv.entities = sim.entityCount();
  inv.monsters = sim.inhabitants('monster').length;
  inv.humans = sim.inhabitants('human').length;
  inv.daysChecked = days.length;
  const fails: string[] = [];
  if (faults.length) fails.push(`the candidate threw ${faults.length} error(s) during the soak`);
  if (badPos) fails.push(`${badPos} entities have NaN/out-of-bounds positions or stats`);
  if (inv.entities > ENTITY_CAP) fails.push(`entity count ${inv.entities} exceeds the cap ${ENTITY_CAP}`);
  for (const d of days) {
    const ate = d.ate.monster + d.ate.human, slept = d.slept.monster + d.slept.human;
    inv[`day${d.day - startDay + 1}.ate`] = ate;
    inv[`day${d.day - startDay + 1}.slept`] = slept;
    if (!req.suspends.includes('eat') && ate === 0) fails.push(`nobody ate on soak day ${d.day - startDay + 1}`);
    if (!req.suspends.includes('sleep') && slept === 0) fails.push(`nobody slept on soak day ${d.day - startDay + 1}`);
  }
  if (!req.suspends.includes('faction-survival')) {
    if (!inv.monsters) fails.push('the monsters were wiped out');
    if (!inv.humans) fails.push('the humans were wiped out');
  }
  const size = island.runtime.stateSize(mod);
  inv.stateBytes = size;
  if (size > MODULE_STATE_CAP) fails.push(`module state is ${size} bytes, over the ${MODULE_STATE_CAP} byte cap`);
  recordErrors();
  if (fails.length) return failCheck('soak', fails.join('; '));
  pass('soak');

  // 6. Visibility (credited during the soak)
  report.visible = { what: mod.visible?.what ?? 'none', count: mod.visibleCount };
  if (!mod.visibleCount) return failCheck('visibility', 'invisible change: during the 2-day soak the module never spawned a shaped entity, changed a tile, emitted particles, set a shape/tint, emoted/spoke, changed the atmosphere, or had one of its behaviors selected');
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

  // 5. Module tests (fresh dawn clone each)
  let allTests = true;
  for (const test of def.tests ?? []) {
    const name = typeof test.name === 'string' ? test.name : 'unnamed test';
    try {
      const nf = faults.length;
      const { island: c, mod: m } = await dawnClone();
      if (test.start === 'dusk') runTicks(c, DUSK_TICK, `test ${name}`);
      if (test.setup) runModuleCode(() => test.setup!(m.api));
      runTicks(c, Math.min(TICKS_PER_DAY, Math.max(0, Math.floor(test.ticks))), `test ${name}`);
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
    if (typeof t.ticks !== 'number' || !(t.ticks >= 0 && t.ticks <= TICKS_PER_DAY)) return `test ticks must be a number from 0 to ${TICKS_PER_DAY}`;
    if (t.start !== undefined && t.start !== 'dawn' && t.start !== 'dusk') return "test start must be 'dawn' or 'dusk'";
  }
  if (def.hooks !== undefined && (typeof def.hooks !== 'object' || def.hooks === null)) return 'hooks must be an object';
  for (const b of def.behaviors ?? []) {
    if (!b || typeof b.id !== 'string' || typeof b.score !== 'function' || typeof b.act !== 'function') return 'every behavior needs id, score(api, e) and act(api, e)';
    if ((CORE_BEHAVIORS as readonly string[]).includes(b.id)) return `behavior id '${b.id}' collides with a core behavior; use api.ent.suppress to override core behaviors`;
  }
  return null;
}
