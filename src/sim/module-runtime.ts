// The host side of the creation-module contract (§11.3–11.5, R25–R27): per-module api, frozen views, attribution,
// caps, faults, quarantine.
import { Rng, hashSeed } from './rng';
import { type BehaviorEntry, type DamageInfo, type DeathInfo, type Sim, type SimListener } from './sim';
import { SIZE } from './world';
import { DMG_TYPES, JOBS, STATS, type Atmosphere, type EmitterDef, type Entity, type Faction, type Job, type ShapeDef, type ShapePart, type Stat } from './types';
import { applyDamage, heal, initZones, kill, monsterMaxHp, humanMaxHp } from './combat';
import { REGION_NAMES } from './island-gen';
import { addNewcomer } from './village';
import { cs } from './champion';
import { monsterActive } from './monster-ai';

export interface ModuleTest {
  name: string;
  start?: 'dawn' | 'dusk' | 'night';
  ticks: number;
  setup?: (api: any) => void;
  check: (api: any) => unknown;
}

export const HOOKS = ['onTick', 'onHour', 'onDawn', 'onDusk', 'onMidnight', 'onSpawn', 'onDeath', 'onDamage', 'onSacrifice', 'onCapture', 'onArrive'] as const;
export type HookName = (typeof HOOKS)[number];

export interface ModuleDef {
  id: string;
  title: string;
  description?: string;
  requires?: string[];
  define?: (api: any) => void;
  init?: (api: any) => void;
  hooks?: Partial<Record<HookName, (...a: any[]) => unknown>>;
  behaviors?: { id: string; appliesTo?: (api: any, e: any) => unknown; score: (api: any, e: any) => number; act: (api: any, e: any) => void }[];
  rules?: {
    moveCost?: (kind: string, tile: string) => number | undefined;
    damage?: (info: DamageInfo) => number | undefined;
    production?: (job: string) => number | undefined;
  };
  teardown?: (api: any) => void;
  tests?: ModuleTest[];
}

export interface VisibleEffect {
  what: string;
  x: number;
  z: number;
  tick: number;
}

export interface ModuleRecord {
  id: string;
  def: ModuleDef;
  status: 'active' | 'quarantined';
  phase: 'define' | 'init' | 'run';
  api: any;
  state: Record<string, unknown>;
  tileData: Map<number, Record<string, unknown>>;
  rng: Rng;
  listeners: Map<string, ((api: any, payload: unknown) => void)[]>;
  faultDay: number;
  faultCount: number;
  totalFaults: number;
  setTileDay: number;
  setTileCount: number;
  logDay: number;
  logCount: number;
  foodDay: number;
  foodCount: number;
  shapes: Set<string>;
  emitters: Set<string>;
  tiles: Set<string>;
  timeMs: number;
  visible: VisibleEffect | null;
  visibleCount: number;
}

interface Schedule {
  due: number;
  mod: string;
  type: string;
  payload: unknown;
}

export interface SavedModules {
  order: string[];
  mods: Record<string, { status: 'active' | 'quarantined'; state: Record<string, unknown>; tileData: [number, Record<string, unknown>][]; rng: number; totalFaults: number }>;
  schedules: Schedule[];
}

export interface FaultInfo {
  id: string;
  hook: string;
  error: string;
  stack?: string;
  line?: number;
}

export interface RuntimeOptions {
  now: () => number;
  onFault?: (f: FaultInfo) => void;
  onQuarantine?: (id: string, reason: string) => void;
  onVisible?: (id: string, v: VisibleEffect) => void;
}

export const CORE_KINDS = new Set(['human', 'monster', 'animal', 'corpse', 'part', 'blood', 'structure']);
const HEX = /^#[0-9a-fA-F]{6}$/;
export const MODULE_STATE_CAP = 8 * 1024;
export const MODULE_ENTITY_BUDGET = 400;
const CAPS = { spawned: 150, shapes: 8, emitters: 6, tiles: 4, setTilePerDay: 300, attached: 40, logsPerDay: 30, schedules: 200, foodPerDay: 300 };
const CORE_STATES = new Set(['flee', 'go-home', 'hide', 'rest', 'return', 'hunt', 'prowl', 'idle']);

class ApiError extends Error {}

function fail(msg: string): never {
  throw new ApiError(msg);
}
function num(v: unknown, name: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a finite number (got ${String(v)})`);
  if (v < min || v > max) fail(`${name} must be between ${min} and ${max} (got ${v})`);
  return v;
}
function int(v: unknown, name: string, min: number, max: number): number {
  return Math.floor(num(v, name, min, max));
}
function color(v: unknown, name: string): string {
  if (typeof v !== 'string' || !HEX.test(v)) fail(`${name} must be a '#rrggbb' color (got ${JSON.stringify(v)})`);
  return v;
}
function str(v: unknown, name: string, maxLen: number): string {
  if (typeof v !== 'string' || !v.length) fail(`${name} must be a non-empty string`);
  if (v.length > maxLen) fail(`${name} must be at most ${maxLen} characters`);
  return v;
}

/** Map a stack trace to a line in the module's own source (blob:/data: URL frames). */
export function moduleLine(stack: string | undefined): number | undefined {
  if (!stack) return undefined;
  const m = stack.match(/(?:blob:|data:)[^\n]*?:(\d+):(\d+)\)?/);
  return m ? Number(m[1]) : undefined;
}

/** Tiles modules may never change: walls, gates, altars, lairs (±1). */
export function protectedTile(sim: Sim, x: number, z: number): boolean {
  const L = sim.layout;
  if (sim.grid.get(x, z) === 'wall') return true;
  const near = (p: { x: number; z: number }, r = 1) => Math.abs(p.x - x) <= r && Math.abs(p.z - z) <= r;
  if (L.gates.some((g) => near(g, 2)) || near(L.villageAltar) || near(L.highAltar, 2)) return true;
  for (let r = 1; r <= 6; r++) if (near(L.lairs[r])) return true;
  return Math.hypot(x - L.village.x, z - L.village.z) < L.wallRadius;
}

export class ModuleRuntime implements SimListener {
  mods: ModuleRecord[] = [];
  byId = new Map<string, ModuleRecord>();
  schedules: Schedule[] = [];
  private saved: SavedModules | null = null;
  private viewCache = new Map<number, Readonly<Record<string, unknown>>>();
  private emitDepth = 0;

  constructor(public sim: Sim, public opts: RuntimeOptions) {
    sim.listeners.push(this);
  }

  restore(saved: SavedModules | null) {
    this.saved = saved;
    if (saved) this.schedules = saved.schedules.map((s) => ({ ...s }));
  }

  // ---------- install ----------

  install(id: string, def: ModuleDef, first: boolean, status: 'active' | 'quarantined' = 'active') {
    if (!def || typeof def !== 'object') throw new Error('default export must be an object');
    if (def.id !== id) throw new Error(`module id must be '${id}' (got '${def.id}')`);
    if (typeof def.title !== 'string' || !def.title) throw new Error('module must have a title');
    if (this.byId.has(id)) throw new Error(`module '${id}' is already installed`);
    for (const r of def.requires ?? []) if (!this.byId.get(r)) throw new Error(`requires '${r}', which is not installed`);
    const saved = this.saved?.mods[id];
    const mod: ModuleRecord = {
      id, def, status, phase: 'define', api: null,
      state: !first && saved ? structuredClone(saved.state) : {},
      tileData: new Map(!first && saved ? saved.tileData.map(([i, o]) => [i, structuredClone(o)]) : []),
      rng: new Rng(!first && saved ? saved.rng : hashSeed(this.sim.seed, 'mod', id)),
      listeners: new Map(), faultDay: -1, faultCount: 0, totalFaults: saved?.totalFaults ?? 0,
      setTileDay: -1, setTileCount: 0, logDay: -1, logCount: 0, foodDay: -1, foodCount: 0,
      shapes: new Set(), emitters: new Set(), tiles: new Set(),
      timeMs: 0, visible: null, visibleCount: 0,
    };
    if (!first && saved) mod.status = saved.status;
    mod.api = this.makeApi(mod);
    this.mods.push(mod);
    this.byId.set(id, mod);
    try {
      if (def.define) this.runSync(def.define, mod.api);
      this.sim.defsVersion++;
      if (first && def.init) {
        mod.phase = 'init';
        this.runSync(def.init, mod.api);
      }
    } catch (err) {
      if (first) {
        this.uninstallRaw(mod);
        throw err;
      }
      mod.phase = 'run';
      this.quarantine(mod, `define failed on load: ${(err as Error)?.message}`);
      return mod;
    }
    mod.phase = 'run';
    if (mod.status === 'active') this.activate(mod);
    return mod;
  }

  private runSync(fn: (...a: any[]) => unknown, ...args: unknown[]) {
    const r = fn(...args);
    if (r && typeof (r as any).then === 'function') throw new Error('must be synchronous (returned a Promise)');
    return r;
  }

  private uninstallRaw(mod: ModuleRecord) {
    this.deactivate(mod);
    this.mods = this.mods.filter((m) => m !== mod);
    this.byId.delete(mod.id);
    for (const s of mod.shapes) this.sim.shapes.delete(s);
    for (const s of mod.emitters) this.sim.emitters.delete(s);
    for (const t of mod.tiles) this.sim.grid.removeTileType(t);
    for (const e of [...this.sim.ents.values()]) if (e.owner === mod.id) this.sim.remove(e);
    for (const e of this.sim.ents.values()) delete e.data[mod.id];
    this.schedules = this.schedules.filter((s) => s.mod !== mod.id);
    this.sim.defsVersion++;
  }

  private activate(mod: ModuleRecord) {
    const def = mod.def;
    for (const b of def.behaviors ?? []) {
      const entry: BehaviorEntry = {
        id: b.id,
        owner: mod.id,
        appliesTo: (e) => e.id !== this.sim.championId && (b.appliesTo ? !!this.call(mod, `behavior ${b.id}.appliesTo`, () => b.appliesTo!(mod.api, this.view(e))) : true),
        score: (e) => {
          const s = this.call(mod, `behavior ${b.id}.score`, () => b.score(mod.api, this.view(e)));
          return typeof s === 'number' ? s : 0;
        },
        act: (e) => {
          this.credit(mod, `behavior:${b.id}`, e.x, e.z);
          this.call(mod, `behavior ${b.id}.act`, () => b.act(mod.api, this.view(e)));
        },
      };
      this.sim.behaviors.push(entry);
    }
    const rules = def.rules ?? {};
    if (typeof rules.moveCost === 'function') {
      const mc = rules.moveCost;
      this.sim.ruleFns.push({ owner: mod.id, fn: (kind, tile) => {
        const r = this.call(mod, 'rules.moveCost', () => mc(kind, tile));
        return typeof r === 'number' ? r : undefined;
      } });
      this.sim.invalidateCosts();
    }
    if (typeof rules.damage === 'function') {
      const dm = rules.damage;
      this.sim.damageRules.push({ owner: mod.id, fn: (info) => {
        const r = this.call(mod, 'rules.damage', () => dm(Object.freeze({ ...info })));
        if (typeof r === 'number' && r !== 1) this.credit(mod, 'law', SIZE / 2, SIZE / 2);
        return typeof r === 'number' ? r : undefined;
      } });
    }
    if (typeof rules.production === 'function') {
      const pr = rules.production;
      this.sim.productionRules.push({ owner: mod.id, fn: (job) => {
        const r = this.call(mod, 'rules.production', () => pr(job));
        if (typeof r === 'number' && r !== 1) this.credit(mod, 'law', SIZE / 2, SIZE / 2);
        return typeof r === 'number' ? r : undefined;
      } });
    }
  }

  private deactivate(mod: ModuleRecord) {
    const s = this.sim;
    s.behaviors = s.behaviors.filter((b) => b.owner !== mod.id);
    const hadRules = s.ruleFns.some((r) => r.owner === mod.id);
    s.ruleFns = s.ruleFns.filter((r) => r.owner !== mod.id);
    s.damageRules = s.damageRules.filter((r) => r.owner !== mod.id);
    s.productionRules = s.productionRules.filter((r) => r.owner !== mod.id);
    if (hadRules) s.invalidateCosts();
  }

  quarantine(mod: ModuleRecord, reason: string) {
    const was = mod.status;
    mod.status = 'quarantined';
    this.deactivate(mod);
    if (was !== 'quarantined' || reason.startsWith('define failed')) {
      this.sim.log(`The creation "${mod.def.title}" falters and is stilled (${reason}).`, 2, mod.id, 'quarantine');
      this.opts.onQuarantine?.(mod.id, reason);
    }
  }

  setStatus(id: string, status: 'active' | 'quarantined') {
    const mod = this.byId.get(id);
    if (!mod || mod.status === status) return;
    if (status === 'quarantined') this.quarantine(mod, 'disabled by the player');
    else {
      mod.status = 'active';
      mod.faultCount = 0;
      this.activate(mod);
    }
  }

  // ---------- calls & faults ----------

  call<T>(mod: ModuleRecord, hook: string, fn: () => T): T | undefined {
    if (mod.status !== 'active') return undefined;
    this.viewCache.clear();
    const t0 = this.opts.now();
    try {
      const r = fn();
      if (r && typeof (r as any).then === 'function') throw new Error(`${hook} must be synchronous (returned a Promise)`);
      return r;
    } catch (err) {
      this.fault(mod, hook, err);
      return undefined;
    } finally {
      mod.timeMs += this.opts.now() - t0;
    }
  }

  fault(mod: ModuleRecord, hook: string, err: unknown) {
    const day = this.sim.day;
    if (mod.faultDay !== day) {
      mod.faultDay = day;
      mod.faultCount = 0;
    }
    mod.faultCount++;
    mod.totalFaults++;
    const e = err as Error;
    const message = e instanceof Error ? `${e instanceof ApiError ? 'api: ' : `${e.name}: `}${e.message}` : String(err);
    this.opts.onFault?.({ id: mod.id, hook, error: message, stack: e?.stack, line: moduleLine(e?.stack) });
    if (mod.faultCount > 5 && mod.status === 'active') this.quarantine(mod, `more than 5 faults today; last: ${message}`);
  }

  private credit(mod: ModuleRecord, what: string, x: number, z: number) {
    mod.visibleCount++;
    if (!mod.visible) {
      mod.visible = { what, x, z, tick: this.sim.tick };
      this.opts.onVisible?.(mod.id, mod.visible);
    }
  }

  // ---------- views ----------

  view(e: Entity): Readonly<Record<string, unknown>> {
    let v = this.viewCache.get(e.id);
    if (v) return v;
    const s = this.sim;
    const zones: string[] = [];
    if (e.zones) for (const [z, st] of Object.entries(e.zones)) if (st && st.state !== 'ok') zones.push(`${z}:${st.state}`);
    v = Object.freeze({
      id: e.id, kind: e.kind, faction: e.faction, name: e.name, inhabitant: e.inhabitant,
      x: e.x, z: e.z, hp: e.hp, maxHp: s.stat(e, 'maxHp'), speed: s.stat(e, 'speed'), strength: s.stat(e, 'strength'), sight: s.stat(e, 'sight'),
      level: e.level, xp: e.xp, state: e.state, downed: e.state === 'downed', champion: e.id === s.championId,
      job: e.human?.job, homeId: e.human?.homeId, archetype: e.monster?.archetype,
      enraged: e.monster ? e.monster.enragedUntil > s.clockMs : false,
      active: e.monster ? monsterActive(s, e) : undefined,
      flies: e.monster?.flies, swims: e.monster?.swims,
      lair: e.monster ? Object.freeze({ x: e.monster.lairX, z: e.monster.lairZ }) : undefined,
      zones: Object.freeze(zones), carrying: e.carrying ?? null, carriedBy: e.carriedBy ?? null,
      corpse: e.corpse ? Object.freeze({ species: e.corpse.species, maxHp: e.corpse.maxHp, fresh: !e.corpse.bones, bones: e.corpse.bones, faction: e.corpse.faction }) : undefined,
      tags: Object.freeze([...e.tags]), owner: e.owner, shape: e.shape, tint: e.tint, scale: e.scale, hidden: e.hidden,
    });
    this.viewCache.set(e.id, v);
    return v;
  }

  private resolve(x: unknown, name = 'entity'): Entity {
    const id = typeof x === 'number' ? x : x && typeof x === 'object' ? (x as { id?: unknown }).id : undefined;
    if (typeof id !== 'number') fail(`${name} must be an entity (view or id)`);
    const e = this.sim.ents.get(id);
    if (!e) fail(`${name} ${id} does not exist (it may have died or been removed)`);
    this.viewCache.delete(id);
    return e;
  }

  // ---------- the api ----------

  private makeApi(mod: ModuleRecord) {
    const sim = this.sim;
    const rt = this;
    const defineOnly = (what: string) => {
      if (mod.phase !== 'define') fail(`${what} may only be called inside define(api)`);
    };
    const running = (what: string) => {
      if (mod.phase === 'define') fail(`${what} may not be called inside define(api); use init or hooks`);
    };
    const ownedCount = () => {
      let n = 0;
      for (const e of sim.ents.values()) if (e.owner === mod.id) n++;
      return n;
    };
    const moduleEntities = () => {
      let n = 0;
      for (const e of sim.ents.values()) if (e.owner) n++;
      return n;
    };
    const tileXZ = (x: unknown, z: unknown) => [int(x, 'x', 0, SIZE - 1), int(z, 'z', 0, SIZE - 1)] as const;
    const checkShape = (id: unknown) => {
      const s = str(id, 'shape id', 40);
      if (!sim.shapes.has(s)) fail(`unknown shape '${s}' (define it with api.vis.defineShape in define, or use a core shape)`);
      return s;
    };
    const checkEmitter = (id: unknown) => {
      const s = str(id, 'emitter id', 40);
      if (!sim.emitters.has(s)) fail(`unknown emitter '${s}' (define it with api.vis.defineEmitter in define)`);
      return s;
    };
    const claim = (set: Set<string>, existing: boolean, id: string, what: string, cap: number) => {
      if (existing && !set.has(id)) fail(`${what} '${id}' already exists (defined by the core or another module); pick a unique id`);
      if (!set.has(id) && set.size >= cap) fail(`at most ${cap} ${what}s per module`);
      set.add(id);
    };
    const daily = (key: 'setTile' | 'log' | 'food') => {
      const day = sim.day;
      if (key === 'setTile') { if (mod.setTileDay !== day) { mod.setTileDay = day; mod.setTileCount = 0; } return; }
      if (key === 'log') { if (mod.logDay !== day) { mod.logDay = day; mod.logCount = 0; } return; }
      if (mod.foodDay !== day) { mod.foodDay = day; mod.foodCount = 0; }
    };
    const pos = (p: { x: number; z: number }) => Object.freeze({ x: p.x + 0.5, z: p.z + 0.5 });

    const world = {
      size: SIZE,
      tile: (x: unknown, z: unknown) => sim.grid.get(Math.floor(num(x, 'x')), Math.floor(num(z, 'z'))),
      setTile: (x: unknown, z: unknown, type: unknown) => {
        running('api.world.setTile');
        const [ix, iz] = tileXZ(x, z);
        const t = str(type, 'tile type', 40);
        if (!sim.grid.defs.has(t)) fail(`unknown tile type '${t}'`);
        if (protectedTile(sim, ix, iz)) return false;
        daily('setTile');
        if (sim.grid.get(ix, iz) === t) return true;
        if (++mod.setTileCount > CAPS.setTilePerDay) fail(`at most ${CAPS.setTilePerDay} setTile calls per module per day`);
        sim.grid.set(ix, iz, t);
        sim.tileChanged(sim.grid.idx(ix, iz));
        rt.credit(mod, 'tile', ix + 0.5, iz + 0.5);
        return true;
      },
      tileData: (x: unknown, z: unknown) => {
        const [ix, iz] = tileXZ(x, z);
        const i = sim.grid.idx(ix, iz);
        let d = mod.tileData.get(i);
        if (!d) mod.tileData.set(i, (d = {}));
        return d;
      },
      defineTile: (id: unknown, o: any) => {
        defineOnly('api.world.defineTile');
        const tid = str(id, 'tile id', 40);
        if (!o || typeof o !== 'object') fail('defineTile needs an options object');
        claim(mod.tiles, sim.grid.defs.has(tid), tid, 'tile type', CAPS.tiles);
        const walkable = !!o.walkable;
        sim.grid.defineTile({
          id: tid, color: color(o.color, 'tile color'), height: num(o.height ?? 0.2, 'tile height', -1, 3),
          walkable, moveCost: walkable ? num(o.moveCost ?? 1, 'moveCost', 0.1, 20) : Infinity, owner: mod.id,
        });
      },
      countTiles: (type: unknown) => sim.grid.count(str(type, 'tile type', 40)),
      findTiles: (type: unknown, limit?: unknown) => {
        const t = str(type, 'tile type', 40);
        const max = limit === undefined ? 4096 : int(limit, 'limit', 0, 16384);
        const out: { x: number; z: number }[] = [];
        for (let i = 0; i < sim.grid.types.length && out.length < max; i++) if (sim.grid.types[i] === t) out.push({ x: i % SIZE, z: Math.floor(i / SIZE) });
        return out;
      },
      nearestTile: (x: unknown, z: unknown, type: unknown, maxR: unknown) => {
        const cx = Math.floor(num(x, 'x')), cz = Math.floor(num(z, 'z'));
        const t = str(type, 'tile type', 40);
        const R = int(maxR ?? 10, 'maxR', 0, 64);
        let best: { x: number; z: number } | null = null, bd = Infinity;
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
          const tx = cx + dx, tz = cz + dz;
          if (!sim.grid.inBounds(tx, tz) || sim.grid.get(tx, tz) !== t) continue;
          const d = dx * dx + dz * dz;
          if (d <= R * R && d < bd) { bd = d; best = { x: tx, z: tz }; }
        }
        return best;
      },
      height: (x: unknown, z: unknown) => sim.grid.height(Math.floor(num(x, 'x')), Math.floor(num(z, 'z'))),
      walkable: (kind: unknown, x: unknown, z: unknown) => sim.walkableFor(str(kind, 'kind', 40), num(x, 'x'), num(z, 'z')),
      regionAt: (x: unknown, z: unknown) => sim.grid.regionAt(num(x, 'x'), num(z, 'z')),
      regionName: (id: unknown) => REGION_NAMES[int(id, 'region id', 0, 255)] ?? 'the sea',
      isProtected: (x: unknown, z: unknown) => protectedTile(sim, int(x, 'x', 0, SIZE - 1), int(z, 'z', 0, SIZE - 1)),
    };

    const ent = {
      all: () => [...sim.ents.values()].map((e) => rt.view(e)),
      get: (id: unknown) => {
        const e = sim.ents.get(typeof id === 'number' ? id : (id as any)?.id);
        return e ? rt.view(e) : undefined;
      },
      query: (q: any = {}) => {
        const out: unknown[] = [];
        const near = q.near;
        if (near) {
          num(near.x, 'near.x');
          num(near.z, 'near.z');
          num(near.r, 'near.r', 0);
        }
        for (const e of sim.ents.values()) {
          if (q.kind !== undefined && e.kind !== q.kind) continue;
          if (q.faction !== undefined && e.faction !== q.faction) continue;
          if (q.tag !== undefined && !e.tags.includes(q.tag)) continue;
          if (q.state !== undefined && e.state !== q.state) continue;
          if (q.job !== undefined && e.human?.job !== q.job) continue;
          if (q.inhabitant !== undefined && e.inhabitant !== !!q.inhabitant) continue;
          if (q.owner !== undefined && e.owner !== q.owner) continue;
          if (near && (e.x - near.x) ** 2 + (e.z - near.z) ** 2 > near.r * near.r) continue;
          out.push(rt.view(e));
        }
        return out;
      },
      dist: (a: unknown, b: unknown) => {
        const ea = rt.resolve(a, 'a'), eb = rt.resolve(b, 'b');
        return Math.hypot(ea.x - eb.x, ea.z - eb.z);
      },
      spawn: (o: any) => {
        running('api.ent.spawn');
        if (!o || typeof o !== 'object') fail('spawn needs an options object');
        const kind = str(o.kind, 'kind', 32);
        if (CORE_KINDS.has(kind)) fail(`kind '${kind}' is reserved by the core; module entities are never humans or monsters (use api.village.spawnVillager or api.ent.revive)`);
        const x = num(o.x, 'x', 0, SIZE - 0.001), z = num(o.z, 'z', 0, SIZE - 0.001);
        const shape = checkShape(o.shape);
        const tint = o.tint === undefined ? undefined : color(o.tint, 'tint');
        const scale = o.scale === undefined ? undefined : num(o.scale, 'scale', 0.1, 6);
        const tags = o.tags === undefined ? [] : Array.isArray(o.tags) ? o.tags.map((t: unknown) => str(t, 'tag', 32)) : fail('tags must be an array of strings');
        if (ownedCount() >= CAPS.spawned) fail(`at most ${CAPS.spawned} live spawned entities per module`);
        if (moduleEntities() >= MODULE_ENTITY_BUDGET) fail(`the island holds at most ${MODULE_ENTITY_BUDGET} creation entities`);
        const e = sim.spawn({ kind, x, z, shape, tint, scale, tags, owner: mod.id });
        if (o.speed !== undefined) e.base.speed = num(o.speed, 'speed', 0, 5);
        if (o.hp !== undefined) e.hp = e.base.maxHp = num(o.hp, 'hp', 1, 5000);
        for (const l of sim.listeners) if (l !== rt) l.onSpawn?.(e);
        rt.credit(mod, 'spawn', x, z);
        return rt.view(e);
      },
      remove: (x: unknown) => {
        running('api.ent.remove');
        const e = rt.resolve(x);
        if (e.owner !== mod.id) fail(`can only remove your own entities (entity ${e.id} is a '${e.kind}'); use api.ent.kill or api.ent.damage for creatures`);
        sim.remove(e);
      },
      kill: (x: unknown, o: any = {}) => {
        running('api.ent.kill');
        const e = rt.resolve(x);
        if (!e.inhabitant && e.kind !== 'animal') fail('kill works on humans, monsters and animals; remove your own entities with api.ent.remove');
        e.harmedBy = mod.id;
        kill(sim, e, { amount: e.hp, type: o.type ? String(o.type) : 'slash', sourceId: -1, sourceKind: mod.id, deathType: o.deathType });
        rt.credit(mod, 'kill', e.x, e.z);
      },
      goTo: (x: unknown, gx: unknown, gz: unknown) => {
        running('api.ent.goTo');
        const e = rt.resolve(x);
        return sim.goTo(e, num(gx, 'x', 0, SIZE - 0.001), num(gz, 'z', 0, SIZE - 0.001));
      },
      moveToward: (x: unknown, gx: unknown, gz: unknown, speed?: unknown) => {
        running('api.ent.moveToward');
        const e = rt.resolve(x);
        sim.moveToward(e, num(gx, 'x', 0, SIZE), num(gz, 'z', 0, SIZE), speed === undefined ? sim.stat(e, 'speed') : num(speed, 'speed', 0, 10));
      },
      setPos: (x: unknown, px: unknown, pz: unknown) => {
        running('api.ent.setPos');
        const e = rt.resolve(x);
        if (e.owner !== mod.id) fail('setPos only moves your own entities (move creatures with goTo or moveToward)');
        e.x = num(px, 'x', 0, SIZE - 0.001);
        e.z = num(pz, 'z', 0, SIZE - 0.001);
        sim.stop(e);
      },
      stop: (x: unknown) => sim.stop(rt.resolve(x)),
      modify: (x: unknown, stat: unknown, o: any) => {
        running('api.ent.modify');
        const e = rt.resolve(x);
        if (!STATS.includes(stat as Stat)) fail(`stat must be one of ${STATS.join(', ')}`);
        const mul = o?.mul === undefined ? 1 : num(o.mul, 'mul', 0, 20);
        const add = o?.add === undefined ? 0 : num(o.add, 'add', -1000, 1000);
        const m = (e.mods[stat as Stat] ??= {});
        const before = sim.stat(e, 'maxHp');
        m[mod.id] = { mul, add };
        if (stat === 'maxHp') {
          const after = sim.stat(e, 'maxHp');
          e.hp = Math.min(after, e.hp + Math.max(0, after - before));
        }
        rt.credit(mod, 'modify', e.x, e.z);
      },
      clearModify: (x: unknown, stat: unknown) => {
        const e = rt.resolve(x);
        if (!STATS.includes(stat as Stat)) fail(`stat must be one of ${STATS.join(', ')}`);
        const m = e.mods[stat as Stat];
        if (m) {
          delete m[mod.id];
          if (!Object.keys(m).length) delete e.mods[stat as Stat];
        }
        if (stat === 'maxHp') e.hp = Math.min(e.hp, sim.stat(e, 'maxHp'));
      },
      addTag: (x: unknown, tag: unknown) => {
        const e = rt.resolve(x);
        const t = str(tag, 'tag', 32);
        if (!e.tags.includes(t)) {
          if (e.tags.length >= 16) fail('at most 16 tags per entity');
          e.tags.push(t);
          e.tagOwners[t] = mod.id;
        }
      },
      removeTag: (x: unknown, tag: unknown) => {
        const e = rt.resolve(x);
        const t = str(tag, 'tag', 32);
        e.tags = e.tags.filter((g) => g !== t);
        delete e.tagOwners[t];
      },
      setCoreState: (x: unknown, state: unknown) => {
        running('api.ent.setCoreState');
        const e = rt.resolve(x);
        const s = str(state, 'state', 20);
        if (!CORE_STATES.has(s)) fail(`state must be one of ${[...CORE_STATES].join(', ')}`);
        if (!e.inhabitant || e.id === sim.championId || ['captive', 'downed', 'bound', 'carry', 'sacrifice'].includes(e.state)) return false;
        if (e.monster && s === 'hunt') {
          e.monster.huntAt.unshift(sim.clockMs);
          return true;
        }
        e.state = s;
        e.stateUntil = sim.tick + 80;
        sim.stop(e);
        return true;
      },
      setTrait: (x: unknown, trait: unknown, on: unknown) => {
        running('api.ent.setTrait');
        const e = rt.resolve(x);
        if (!e.monster) fail('setTrait works on monsters');
        if (trait !== 'flies' && trait !== 'swims') fail("trait must be 'flies' or 'swims'");
        e.monster[trait] = !!on;
        sim.stop(e);
        rt.credit(mod, 'trait', e.x, e.z);
      },
      revive: (x: unknown) => {
        running('api.ent.revive');
        const c = rt.resolve(x);
        if (c.kind !== 'corpse' || !c.corpse || c.corpse.bones) fail('revive needs a fresh corpse (not bones)');
        const data = c.data.__revive as any;
        if (!data) fail('this corpse cannot be revived');
        const e: Entity = structuredClone(data);
        e.id = sim.nextId++;
        e.x = c.x;
        e.z = c.z;
        e.state = e.kind === 'monster' ? 'return' : 'idle';
        e.roll = 0; e.lift = 0; e.squash = 1; e.path = null; e.want = null; e.target = -1;
        e.carrying = undefined; e.carriedBy = undefined; e.burnUntil = undefined;
        initZones(e);
        e.hp = sim.stat(e, 'maxHp') * 0.5;
        e.tags = [...e.tags.filter((t) => t !== 'champion'), 'risen'];
        if (e.human?.job === 'champion') e.human.job = 'farmer';
        sim.ents.set(e.id, e);
        for (const o of sim.monsters()) o.monster!.neighbors = o.monster!.neighbors.map((n) => (n === data.id ? e.id : n));
        sim.remove(c);
        sim.burst('smoke', e.x, e.z);
        rt.credit(mod, 'revive', e.x, e.z);
        return rt.view(e);
      },
      damage: (x: unknown, n: unknown, o: any = {}) => {
        running('api.ent.damage');
        const e = rt.resolve(x);
        const v = num(n, 'damage', 0, 10000);
        if (e.owner === mod.id) {
          e.hp -= v;
          if (e.hp <= 0) sim.remove(e);
          return { killed: e.hp <= 0, downed: false };
        }
        if (!e.inhabitant && e.kind !== 'animal') fail('can only damage humans, monsters, animals or your own entities');
        const type = o.type === undefined ? 'slash' : str(o.type, 'type', 20);
        if (!(DMG_TYPES as readonly string[]).includes(type) && !['poison', 'cold', 'magic'].includes(type)) fail(`type must be one of ${DMG_TYPES.join(', ')}, poison, cold, magic`);
        let sourceId: number | undefined;
        if (o.source !== undefined) sourceId = rt.resolve(o.source, 'source').id;
        e.harmedBy = mod.id;
        rt.credit(mod, 'damage', e.x, e.z);
        const r = applyDamage(sim, e, v, { type, sourceId });
        return { killed: r.killed, downed: r.downed };
      },
      heal: (x: unknown, n: unknown) => {
        const e = rt.resolve(x);
        const v = num(n, 'heal', 0, 10000);
        if (e.owner === mod.id) { e.hp = Math.min(e.base.maxHp, e.hp + v); return; }
        if (!e.inhabitant) fail('can only heal humans, monsters or your own entities');
        heal(sim, e, v);
      },
    };

    const vis = {
      defineShape: (id: unknown, def: any) => {
        defineOnly('api.vis.defineShape');
        const sid = str(id, 'shape id', 40);
        const parsed = validateShape(def);
        claim(mod.shapes, sim.shapes.has(sid), sid, 'shape', CAPS.shapes);
        sim.shapes.set(sid, parsed);
      },
      defineEmitter: (id: unknown, def: any) => {
        defineOnly('api.vis.defineEmitter');
        const eid = str(id, 'emitter id', 40);
        const parsed = validateEmitter(def);
        claim(mod.emitters, sim.emitters.has(eid), eid, 'emitter', CAPS.emitters);
        sim.emitters.set(eid, parsed);
      },
      setShape: (x: unknown, id: unknown) => {
        const e = rt.resolve(x);
        const s = checkShape(id);
        if (e.shape === s) return;
        e.shape = s;
        rt.credit(mod, 'shape', e.x, e.z);
      },
      setTint: (x: unknown, c: unknown) => {
        const e = rt.resolve(x);
        const t = color(c, 'tint');
        if (e.tint === t) return;
        e.tint = t;
        rt.credit(mod, 'tint', e.x, e.z);
      },
      setScale: (x: unknown, s: unknown) => {
        const e = rt.resolve(x);
        e.scale = num(s, 'scale', 0.1, 6);
      },
      attach: (x: unknown, id: unknown) => {
        running('api.vis.attach');
        const e = rt.resolve(x);
        const em = checkEmitter(id);
        if (sim.attached.get(e.id)?.has(em)) return;
        if (sim.attachedCount() >= CAPS.attached) fail(`at most ${CAPS.attached} attached emitters on the island`);
        sim.attach(e, em);
        rt.credit(mod, 'particles', e.x, e.z);
      },
      detach: (x: unknown, id: unknown) => sim.detach(rt.resolve(x), checkEmitter(id)),
      burst: (id: unknown, x: unknown, y: unknown, z: unknown) => {
        running('api.vis.burst');
        const em = checkEmitter(id);
        const bx = num(x, 'x', -8, SIZE + 8), by = num(y, 'y', -5, 30), bz = num(z, 'z', -8, SIZE + 8);
        sim.out.emitterOps.push({ op: 'burst', emitter: em, x: bx, y: by, z: bz });
        rt.credit(mod, 'particles', bx, bz);
      },
      emote: (x: unknown, text: unknown, seconds: unknown) => {
        running('api.vis.emote');
        const e = rt.resolve(x);
        sim.emote(e, str(text, 'emote', 8), num(seconds ?? 2, 'seconds', 0.2, 20));
        rt.credit(mod, 'emote', e.x, e.z);
      },
      say: (x: unknown, text: unknown, seconds: unknown) => {
        running('api.vis.say');
        const e = rt.resolve(x);
        sim.emote(e, str(text, 'speech', 40), num(seconds ?? 3, 'seconds', 0.2, 20), true);
        rt.credit(mod, 'speech', e.x, e.z);
      },
      atmosphere: (o: any) => {
        running('api.vis.atmosphere');
        if (!o || typeof o !== 'object') fail('atmosphere needs an options object');
        const a: Atmosphere = {};
        if (o.skyTint !== undefined) a.skyTint = color(o.skyTint, 'skyTint');
        if (o.fogColor !== undefined) a.fogColor = color(o.fogColor, 'fogColor');
        if (o.lightTint !== undefined) a.lightTint = color(o.lightTint, 'lightTint');
        if (o.fogDensity !== undefined) a.fogDensity = num(o.fogDensity, 'fogDensity', 0, 1);
        if (o.darkness !== undefined) a.darkness = num(o.darkness, 'darkness', 0, 1);
        if (o.light !== undefined) a.light = num(o.light, 'light', 0, 1);
        if (o.weather !== undefined) {
          if (!['none', 'rain', 'fog', 'ash'].includes(o.weather)) fail("weather must be 'none', 'rain', 'fog' or 'ash'");
          a.weather = o.weather;
        }
        const before = JSON.stringify(sim.atmosphere);
        Object.assign(sim.atmosphere, a);
        if (JSON.stringify(sim.atmosphere) !== before) {
          sim.out.atmosphereDirty = true;
          rt.credit(mod, 'atmosphere', SIZE / 2, SIZE / 2);
        }
      },
      clearAtmosphere: () => {
        sim.atmosphere = {};
        sim.out.atmosphereDirty = true;
      },
    };

    const game = {
      get day() { return sim.day; },
      get favorToday() { return Object.freeze({ ...sim.favor }); },
      get food() { return sim.food; },
      get foodCap() { return sim.foodCap; },
      get championId() { return sim.championId; },
      get villageCenter() { return pos(sim.layout.village); },
      get villageAltar() { return pos(sim.layout.villageAltar); },
      get highAltar() { return pos(sim.layout.highAltar); },
      get villageRadius() { return sim.layout.wallRadius; },
      get regions() { return Object.freeze(REGION_NAMES.map((name, id) => Object.freeze({ id, name, center: pos(sim.layout.seeds[id]) }))); },
      get lairs() {
        return Object.freeze([1, 2, 3, 4, 5, 6].map((r) => {
          const m = sim.monsters().find((x) => x.monster!.region === r);
          const s = sim.byRole(`lair:${r}`);
          return Object.freeze({ region: r, ...pos(sim.layout.lairs[r]), found: !!s?.tags.includes('found'), monsterId: m ? m.id : null });
        }));
      },
      get creations() { return Object.freeze(sim.creations.map((c) => Object.freeze({ title: c.title, god: c.god, domain: c.domain, day: c.day }))); },
    };

    const village = {
      addFood: (n: unknown) => {
        running('api.village.addFood');
        const v = num(n, 'food', -50, 50);
        daily('food');
        if ((mod.foodCount += Math.abs(v)) > CAPS.foodPerDay) fail(`at most ${CAPS.foodPerDay} food per module per day`);
        sim.food = Math.max(0, Math.min(sim.foodCap, sim.food + v));
        rt.credit(mod, 'food', sim.layout.village.x, sim.layout.village.z);
      },
      spawnVillager: (o: any = {}) => {
        running('api.village.spawnVillager');
        const job = o.job === undefined ? undefined : (JOBS as readonly string[]).includes(o.job) ? (o.job as Job) : fail(`job must be one of ${JOBS.join(', ')}`);
        const level = o.level === undefined ? 1 : int(o.level, 'level', 1, 10);
        const e = addNewcomer(sim, { job, level });
        if (!e) return null;
        rt.credit(mod, 'spawn', e.x, e.z);
        return rt.view(e);
      },
    };

    const monster = {
      addHunt: (x: unknown, clockMs: unknown) => {
        running('api.monster.addHunt');
        const e = rt.resolve(x);
        if (!e.monster) fail('addHunt needs a monster');
        if (e.monster.huntAt.length >= 12) return false;
        e.monster.huntAt.push(num(clockMs, 'clockMs'));
        e.monster.huntAt.sort((a, b) => a - b);
        return true;
      },
    };

    const champion = {
      setWeapon: (o: any) => {
        running('api.champion.setWeapon');
        const type = str(o?.type ?? 'slash', 'type', 10);
        if (!(DMG_TYPES as readonly string[]).includes(type)) fail(`type must be one of ${DMG_TYPES.join(', ')}`);
        cs(sim).weapon = { type, mul: num(o?.mul ?? 1, 'mul', 0.5, 3) };
      },
    };

    const api = {
      id: mod.id,
      get time() {
        return sim.time;
      },
      perHour: (x: unknown) => (num(x, 'x') * sim.msPerTick) / 3_600_000,
      rand: () => mod.rng.next(),
      randInt: (a: unknown, b: unknown) => mod.rng.int(Math.floor(num(a, 'a')), Math.floor(num(b, 'b'))),
      pick: <T>(arr: T[]) => (Array.isArray(arr) ? mod.rng.pick(arr) : fail('pick needs an array')),
      chance: (p: unknown) => mod.rng.chance(num(p, 'p', 0, 1)),
      get state() {
        return mod.state;
      },
      set state(v: Record<string, unknown>) {
        if (!v || typeof v !== 'object') fail('api.state must be an object');
        mod.state = v;
      },
      schedule: (ticks: unknown, type: unknown, payload?: unknown) => {
        running('api.schedule');
        const t = int(ticks, 'ticks', 1, 36000);
        const ty = str(type, 'event type', 40);
        if (rt.schedules.filter((s) => s.mod === mod.id).length >= CAPS.schedules) fail(`at most ${CAPS.schedules} pending schedules per module`);
        rt.schedules.push({ due: sim.tick + t, mod: mod.id, type: ty, payload: payload === undefined ? null : JSON.parse(JSON.stringify(payload)) });
      },
      world, ent, vis, game, village, monster, champion,
      data: (x: unknown) => {
        const e = rt.resolve(x);
        return (e.data[mod.id] ??= {});
      },
      dataOf: (x: unknown, moduleId: unknown) => {
        const e = rt.resolve(x);
        const d = e.data[str(moduleId, 'module id', 80)];
        return d === undefined ? undefined : Object.freeze(structuredClone(d));
      },
      events: {
        on: (type: unknown, fn: unknown) => {
          defineOnly('api.events.on');
          const t = str(type, 'event type', 40);
          if (typeof fn !== 'function') fail('events.on needs a function');
          const list = mod.listeners.get(t) ?? [];
          list.push(fn as any);
          mod.listeners.set(t, list);
        },
        emit: (type: unknown, payload?: unknown) => {
          running('api.events.emit');
          rt.emit(str(type, 'event type', 40), payload, null);
        },
      },
      log: (text: unknown, importance: unknown = 1) => {
        const t = str(text, 'log text', 200);
        const imp = int(importance, 'importance', 1, 3);
        daily('log');
        if (++mod.logCount > CAPS.logsPerDay) return;
        sim.log(t, imp, mod.id);
      },
    };
    for (const k of ['world', 'ent', 'vis', 'events', 'village', 'monster', 'champion'] as const) Object.freeze(api[k]);
    return Object.freeze(api);
  }

  emit(type: string, payload: unknown, only: string | null) {
    if (this.emitDepth > 4) return;
    this.emitDepth++;
    try {
      for (const m of this.mods) {
        if (only && m.id !== only) continue;
        const fns = m.listeners.get(type);
        if (!fns) continue;
        for (const fn of fns) this.call(m, `event ${type}`, () => fn(m.api, payload));
      }
    } finally {
      this.emitDepth--;
    }
  }

  // ---------- SimListener: dispatch in activation order ----------

  private each(hook: HookName, ...args: unknown[]) {
    for (const m of this.mods) {
      const fn = m.def.hooks?.[hook];
      if (typeof fn !== 'function' || m.status !== 'active') continue;
      this.call(m, hook, () => fn(m.api, ...args.map((a) => (a && typeof a === 'object' && 'kind' in (a as object) && 'id' in (a as object) ? this.view(a as Entity) : a))));
    }
  }

  onHour() { this.each('onHour'); }
  onDawn() { this.each('onDawn'); }
  onDusk() { this.each('onDusk'); }
  onMidnight() { this.each('onMidnight'); }
  onTick() {
    if (this.schedules.length) {
      const due = this.schedules.filter((s) => s.due <= this.sim.tick);
      if (due.length) {
        this.schedules = this.schedules.filter((s) => s.due > this.sim.tick);
        for (const s of due) {
          const m = this.byId.get(s.mod);
          if (m && m.status === 'active') this.emit(s.type, s.payload, s.mod);
        }
      }
    }
    this.each('onTick');
  }
  onSpawn(e: Entity) { this.each('onSpawn', e); }
  onDeath(e: Entity, info: DeathInfo) {
    // remember enough to revive (api.ent.revive)
    this.each('onDeath', e, Object.freeze({ ...info }));
  }
  onDamage(e: Entity, info: DeathInfo) { this.each('onDamage', e, Object.freeze({ ...info })); }
  onSacrifice(info: { faction: Faction; altar: string; victimKind: string; favor: number }) { this.each('onSacrifice', Object.freeze({ ...info })); }
  onCapture(m: Entity, v: Entity) { this.each('onCapture', m, v); }
  onArrive(e: Entity) {
    if (e.owner) this.each('onArrive', e);
  }

  // ---------- persistence ----------

  stateSize(mod: ModuleRecord): number {
    let n = JSON.stringify(mod.state).length;
    for (const d of mod.tileData.values()) n += JSON.stringify(d).length + 8;
    for (const e of this.sim.ents.values()) {
      const d = e.data[mod.id];
      if (d) n += JSON.stringify(d).length + 8;
    }
    return n;
  }

  serialize(): SavedModules {
    const out: SavedModules = { order: this.mods.map((m) => m.id), mods: {}, schedules: this.schedules.map((s) => ({ ...s })) };
    for (const m of this.mods) {
      out.mods[m.id] = {
        status: m.status,
        state: JSON.parse(JSON.stringify(m.state)),
        tileData: [...m.tileData].filter(([, o]) => Object.keys(o).length).map(([i, o]) => [i, JSON.parse(JSON.stringify(o))]),
        rng: m.rng.state,
        totalFaults: m.totalFaults,
      };
    }
    return out;
  }

  enforceStateCaps(): string[] {
    const hit: string[] = [];
    for (const m of this.mods) {
      if (m.status === 'active' && this.stateSize(m) > MODULE_STATE_CAP) {
        this.quarantine(m, `module state exceeds ${MODULE_STATE_CAP / 1024} KB`);
        hit.push(m.id);
      }
    }
    return hit;
  }
}

export function validateShape(def: any): ShapeDef {
  if (!def || !Array.isArray(def.parts)) fail('shape needs { parts: [...] }');
  if (def.parts.length < 1 || def.parts.length > 12) fail('a shape has 1–12 parts');
  const parts: ShapePart[] = def.parts.map((p: any, i: number) => {
    const at = `parts[${i}]`;
    if (!['box', 'sphere', 'cylinder', 'cone'].includes(p?.prim)) fail(`${at}.prim must be box | sphere | cylinder | cone`);
    const v3 = (v: any, name: string, min: number, max: number) => {
      if (!Array.isArray(v) || v.length !== 3) fail(`${at}.${name} must be [x, y, z]`);
      return v.map((n: unknown, k: number) => num(n, `${at}.${name}[${k}]`, min, max)) as [number, number, number];
    };
    const part: ShapePart = {
      prim: p.prim,
      size: v3(p.size, 'size', 0.01, 10),
      pos: v3(p.pos ?? [0, 0, 0], 'pos', -10, 10),
      color: p.color === 'tint' ? 'tint' : color(p.color, `${at}.color`),
    };
    if (p.rot !== undefined) part.rot = v3(p.rot, 'rot', -720, 720);
    if (p.emissive !== undefined) part.emissive = num(p.emissive, `${at}.emissive`, 0, 1);
    if (p.opacity !== undefined) part.opacity = num(p.opacity, `${at}.opacity`, 0.2, 1);
    if (p.anim !== undefined) {
      if (!['bob', 'spin', 'pulse', 'sway'].includes(p.anim?.type)) fail(`${at}.anim.type must be bob | spin | pulse | sway`);
      part.anim = { type: p.anim.type, speed: num(p.anim.speed, `${at}.anim.speed`, 0, 50), amount: num(p.anim.amount, `${at}.anim.amount`, 0, 10) };
    }
    return part;
  });
  return { parts };
}

export function validateEmitter(def: any): EmitterDef {
  if (!def || typeof def !== 'object') fail('emitter needs an options object');
  const e: EmitterDef = {
    color: color(def.color, 'emitter color'),
    size: num(def.size ?? 0.2, 'size', 0.01, 3),
    rate: num(def.rate ?? 5, 'rate', 0, 200),
    life: num(def.life ?? 1, 'life', 0.05, 10),
    speed: num(def.speed ?? 1, 'speed', 0, 30),
    spread: num(def.spread ?? 0.5, 'spread', 0, 1),
    gravity: num(def.gravity ?? 0, 'gravity', -30, 30),
  };
  if (def.color2 !== undefined) e.color2 = color(def.color2, 'color2');
  if (def.glow !== undefined) e.glow = !!def.glow;
  return e;
}

void monsterMaxHp;
void humanMaxHp;
