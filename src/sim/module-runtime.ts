// The host side of the module contract (§5): per-module api, frozen views, attribution, caps, faults.
import { Rng, hashSeed } from './rng';
import { CORE_BEHAVIORS, ENTITY_CAP, type BehaviorEntry, type Sim, type SimListener } from './sim';
import { timeInfo } from './time';
import { SIZE } from './world';
import { STATS, type Atmosphere, type EmitterDef, type Entity, type Faction, type ShapeDef, type ShapePart, type Stat } from './types';

export interface ModuleTest {
  name: string;
  start?: 'dawn' | 'dusk';
  ticks: number;
  setup?: (api: any) => void;
  check: (api: any) => unknown;
}

export interface ModuleDef {
  id: string;
  title: string;
  description?: string;
  requires?: string[];
  define?: (api: any) => void;
  init?: (api: any) => void;
  hooks?: Partial<Record<'onTick' | 'onDawn' | 'onDusk' | 'onSpawn' | 'onDeath' | 'onEat' | 'onArrive', (...a: any[]) => unknown>>;
  behaviors?: { id: string; appliesTo?: (api: any, e: any) => unknown; score: (api: any, e: any) => number; act: (api: any, e: any) => void }[];
  rules?: { moveCost?: (kind: string, tile: string) => number | undefined };
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
  shapes: Set<string>;
  emitters: Set<string>;
  tiles: Set<string>;
  foods: Set<string>;
  timeMs: number; // accumulated since the last stats sample
  visible: VisibleEffect | null; // first visible effect
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

const RESERVED_KINDS = new Set(['monster', 'human', 'house', 'shrine', 'gravestone', 'berry-bush']);
const HEX = /^#[0-9a-fA-F]{6}$/;
export const MODULE_STATE_CAP = 8 * 1024;
const CAPS = { spawned: 150, shapes: 8, emitters: 6, tiles: 4, foods: 3, setTilePerDay: 300, attached: 32, logsPerDay: 30, schedules: 200 };

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
  const n = num(v, name, min, max);
  return Math.floor(n);
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

  /** Provide saved module data; applied as each module is (re)installed with first=false. */
  restore(saved: SavedModules | null) {
    this.saved = saved;
    if (saved) this.schedules = saved.schedules.map((s) => ({ ...s }));
  }

  // ---------- install ----------

  /**
   * Install a module. first=true runs define+init (first install); first=false runs define only (reload).
   * Throws on a bad def or a define/init error (the caller decides whether that's fatal).
   */
  install(id: string, def: ModuleDef, first: boolean, status: 'active' | 'quarantined' = 'active') {
    if (!def || typeof def !== 'object') throw new Error('default export must be an object');
    if (def.id !== id) throw new Error(`module id must be '${id}' (got '${def.id}')`);
    if (typeof def.title !== 'string' || !def.title) throw new Error('module must have a title');
    if (this.byId.has(id)) throw new Error(`module '${id}' is already installed`);
    for (const r of def.requires ?? []) {
      const dep = this.byId.get(r);
      if (!dep) throw new Error(`requires '${r}', which is not installed`);
    }
    const saved = this.saved?.mods[id];
    const mod: ModuleRecord = {
      id, def, status, phase: 'define', api: null,
      state: !first && saved ? structuredClone(saved.state) : {},
      tileData: new Map(!first && saved ? saved.tileData.map(([i, o]) => [i, structuredClone(o)]) : []),
      rng: new Rng(!first && saved ? saved.rng : hashSeed(this.sim.seed, 'mod', id)),
      listeners: new Map(), faultDay: -1, faultCount: 0, totalFaults: saved?.totalFaults ?? 0,
      setTileDay: -1, setTileCount: 0, logDay: -1, logCount: 0,
      shapes: new Set(), emitters: new Set(), tiles: new Set(), foods: new Set(),
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
      // a reloaded module whose define throws can't run; keep it, quarantined
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

  /** Remove every registration of a failed first install (used only when define/init throws). */
  private uninstallRaw(mod: ModuleRecord) {
    this.deactivate(mod);
    this.mods = this.mods.filter((m) => m !== mod);
    this.byId.delete(mod.id);
    for (const s of mod.shapes) this.sim.shapes.delete(s);
    for (const s of mod.emitters) this.sim.emitters.delete(s);
    for (const t of mod.tiles) this.sim.grid.removeTileType(t);
    for (const f of mod.foods) this.sim.foodKinds.delete(f);
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
        appliesTo: (e) => (b.appliesTo ? !!this.call(mod, `behavior ${b.id}.appliesTo`, () => b.appliesTo!(mod.api, this.view(e))) : true),
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
    const mc = def.rules?.moveCost;
    if (typeof mc === 'function') {
      this.sim.ruleFns.push({
        owner: mod.id,
        fn: (kind, tile) => {
          const r = this.call(mod, 'rules.moveCost', () => mc(kind, tile));
          return typeof r === 'number' ? r : undefined;
        },
      });
      this.sim.invalidateCosts();
    }
  }

  private deactivate(mod: ModuleRecord) {
    this.sim.behaviors = this.sim.behaviors.filter((b) => b.owner !== mod.id);
    const hadRules = this.sim.ruleFns.some((r) => r.owner === mod.id);
    this.sim.ruleFns = this.sim.ruleFns.filter((r) => r.owner !== mod.id);
    if (hadRules) this.sim.invalidateCosts();
  }

  quarantine(mod: ModuleRecord, reason: string) {
    const was = mod.status;
    mod.status = 'quarantined';
    this.deactivate(mod);
    if (was !== 'quarantined' || reason.startsWith('define failed')) {
      this.sim.log(`The work "${mod.def.title}" falters and is stilled (${reason}).`, 2, mod.id, 'quarantine');
      this.opts.onQuarantine?.(mod.id, reason);
    }
  }

  setStatus(id: string, status: 'active' | 'quarantined') {
    const mod = this.byId.get(id);
    if (!mod || mod.status === status) return;
    if (status === 'quarantined') this.quarantine(mod, 'disabled by the petitioner');
    else {
      mod.status = 'active';
      mod.faultCount = 0;
      this.activate(mod);
    }
  }

  // ---------- calls & faults ----------

  /** Run module code with fault capture and timing. Returns undefined on fault or if inactive. */
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
    const day = this.sim.time.day;
    if (mod.faultDay !== day) {
      mod.faultDay = day;
      mod.faultCount = 0;
    }
    mod.faultCount++;
    mod.totalFaults++;
    const e = err as Error;
    const message = e instanceof Error ? `${e.name === 'ApiError' || e instanceof ApiError ? 'api: ' : `${e.name}: `}${e.message}` : String(err);
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
    v = Object.freeze({
      id: e.id, kind: e.kind, faction: e.faction, name: e.name, inhabitant: e.inhabitant,
      x: e.x, z: e.z, hp: e.hp, maxHp: this.sim.stat(e, 'maxHp'), hunger: e.hunger,
      speed: this.sim.stat(e, 'speed'), strength: this.sim.stat(e, 'strength'), hungerRate: this.sim.stat(e, 'hungerRate'),
      homeId: e.homeId, behavior: e.behavior, tags: Object.freeze([...e.tags]), owner: e.owner,
      shape: e.shape, tint: e.tint, scale: e.scale, hidden: e.hidden,
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
    const tileXZ = (x: unknown, z: unknown) => {
      const ix = int(x, 'x', 0, SIZE - 1), iz = int(z, 'z', 0, SIZE - 1);
      return [ix, iz] as const;
    };
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

    const world = {
      size: SIZE,
      tile: (x: unknown, z: unknown) => {
        const ix = num(x, 'x'), iz = num(z, 'z');
        return sim.grid.get(Math.floor(ix), Math.floor(iz));
      },
      setTile: (x: unknown, z: unknown, type: unknown) => {
        running('api.world.setTile');
        const [ix, iz] = tileXZ(x, z);
        const t = str(type, 'tile type', 40);
        if (!sim.grid.defs.has(t)) fail(`unknown tile type '${t}'`);
        const day = sim.time.day;
        if (mod.setTileDay !== day) {
          mod.setTileDay = day;
          mod.setTileCount = 0;
        }
        if (sim.grid.get(ix, iz) === t) return;
        if (++mod.setTileCount > CAPS.setTilePerDay) fail(`at most ${CAPS.setTilePerDay} setTile calls per module per day`);
        sim.grid.set(ix, iz, t);
        sim.tileChanged(sim.grid.idx(ix, iz));
        rt.credit(mod, 'tile', ix + 0.5, iz + 0.5);
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
        const max = limit === undefined ? 4096 : int(limit, 'limit', 0, 4096);
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
          if (d <= R * R && d < bd) {
            bd = d;
            best = { x: tx, z: tz };
          }
        }
        return best;
      },
      height: (x: unknown, z: unknown) => sim.grid.height(Math.floor(num(x, 'x')), Math.floor(num(z, 'z'))),
      walkable: (kind: unknown, x: unknown, z: unknown) => sim.walkableFor(str(kind, 'kind', 40), Math.floor(num(x, 'x')), Math.floor(num(z, 'z'))),
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
          if (q.behavior !== undefined && e.behavior !== q.behavior) continue;
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
        if (RESERVED_KINDS.has(kind)) fail(`kind '${kind}' is reserved by the core; module entities are never inhabitants`);
        const x = num(o.x, 'x', 0, SIZE - 0.001), z = num(o.z, 'z', 0, SIZE - 0.001);
        const shape = checkShape(o.shape);
        const tint = o.tint === undefined ? undefined : color(o.tint, 'tint');
        const scale = o.scale === undefined ? undefined : num(o.scale, 'scale', 0.1, 5);
        const tags = o.tags === undefined ? [] : Array.isArray(o.tags) ? o.tags.map((t: unknown) => str(t, 'tag', 32)) : fail('tags must be an array of strings');
        if (ownedCount() >= CAPS.spawned) fail(`at most ${CAPS.spawned} live spawned entities per module`);
        if (sim.entityCount() >= ENTITY_CAP) fail(`the island is full (${ENTITY_CAP} entities)`);
        const e = sim.spawn({ kind, x, z, shape, tint, scale, tags, owner: mod.id });
        for (const l of sim.listeners) if (l !== rt) l.onSpawn?.(e);
        rt.credit(mod, 'spawn', x, z);
        return rt.view(e);
      },
      remove: (x: unknown) => {
        running('api.ent.remove');
        const e = rt.resolve(x);
        if (e.inhabitant) {
          e.harmedBy = mod.id;
          sim.kill(e, mod.def.title);
        } else if (e.owner === mod.id) sim.remove(e);
        else fail(`can only remove your own entities or inhabitants (entity ${e.id} is a '${e.kind}')`);
      },
      goTo: (x: unknown, gx: unknown, gz: unknown) => {
        running('api.ent.goTo');
        const e = rt.resolve(x);
        return sim.goTo(e, num(gx, 'x', 0, SIZE - 0.001), num(gz, 'z', 0, SIZE - 0.001));
      },
      moveToward: (x: unknown, gx: unknown, gz: unknown) => {
        running('api.ent.moveToward');
        const e = rt.resolve(x);
        sim.moveToward(e, num(gx, 'x', 0, SIZE), num(gz, 'z', 0, SIZE));
      },
      setPos: (x: unknown, px: unknown, pz: unknown) => {
        running('api.ent.setPos');
        const e = rt.resolve(x);
        const nx = num(px, 'x', 0, SIZE - 0.001), nz = num(pz, 'z', 0, SIZE - 0.001);
        if (e.inhabitant && !sim.walkableFor(e.kind, Math.floor(nx), Math.floor(nz))) fail(`tile (${Math.floor(nx)},${Math.floor(nz)}) is not walkable for '${e.kind}'`);
        e.x = nx;
        e.z = nz;
        sim.stop(e);
      },
      stop: (x: unknown) => sim.stop(rt.resolve(x)),
      modify: (x: unknown, stat: unknown, o: any) => {
        running('api.ent.modify');
        const e = rt.resolve(x);
        if (!STATS.includes(stat as Stat)) fail(`stat must be one of ${STATS.join(', ')}`);
        const mul = o?.mul === undefined ? 1 : num(o.mul, 'mul', 0, 100);
        const add = o?.add === undefined ? 0 : num(o.add, 'add', -1000, 1000);
        const m = (e.mods[stat as Stat] ??= {});
        m[mod.id] = { mul, add };
        if (stat === 'maxHp') e.hp = Math.min(e.hp, sim.stat(e, 'maxHp'));
      },
      clearModify: (x: unknown, stat: unknown) => {
        const e = rt.resolve(x);
        if (!STATS.includes(stat as Stat)) fail(`stat must be one of ${STATS.join(', ')}`);
        const m = e.mods[stat as Stat];
        if (m) {
          delete m[mod.id];
          if (!Object.keys(m).length) delete e.mods[stat as Stat];
        }
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
      suppress: (x: unknown, behaviorId: unknown, ticks: unknown) => {
        running('api.ent.suppress');
        const e = rt.resolve(x);
        const b = str(behaviorId, 'behavior id', 40);
        if (!(CORE_BEHAVIORS as readonly string[]).includes(b) && !sim.behaviors.some((x) => x.id === b)) fail(`unknown behavior '${b}'`);
        e.suppressed[b] = sim.tick + int(ticks, 'ticks', 1, 18000);
      },
      damage: (x: unknown, n: unknown) => {
        running('api.ent.damage');
        const e = rt.resolve(x);
        const v = num(n, 'damage', 0, 10000);
        if (!e.inhabitant && e.owner !== mod.id) fail('can only damage inhabitants or your own entities');
        e.hp -= v;
        if (e.inhabitant) e.harmedBy = mod.id;
        else if (e.hp <= 0) sim.remove(e);
      },
      heal: (x: unknown, n: unknown) => {
        const e = rt.resolve(x);
        const v = num(n, 'heal', 0, 10000);
        if (!e.inhabitant) fail('can only heal inhabitants');
        e.hp = Math.min(sim.stat(e, 'maxHp'), e.hp + v);
      },
      feed: (x: unknown, n: unknown) => {
        const e = rt.resolve(x);
        const v = num(n, 'feed', -100, 100);
        if (!e.inhabitant) fail('can only feed inhabitants');
        sim.feed(e, v);
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
        e.scale = num(s, 'scale', 0.1, 5);
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
      detach: (x: unknown, id: unknown) => {
        const e = rt.resolve(x);
        sim.detach(e, checkEmitter(id));
      },
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
        if (o.weather !== undefined) {
          if (!['none', 'rain', 'snow'].includes(o.weather)) fail("weather must be 'none', 'rain' or 'snow'");
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

    const api = {
      id: mod.id,
      get time() {
        return timeInfo(sim.tick);
      },
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
        const t = int(ticks, 'ticks', 1, 18000);
        const ty = str(type, 'event type', 40);
        if (rt.schedules.filter((s) => s.mod === mod.id).length >= CAPS.schedules) fail(`at most ${CAPS.schedules} pending schedules per module`);
        rt.schedules.push({ due: sim.tick + t, mod: mod.id, type: ty, payload: payload === undefined ? null : JSON.parse(JSON.stringify(payload)) });
      },
      world,
      ent,
      data: (x: unknown) => {
        const e = rt.resolve(x);
        return (e.data[mod.id] ??= {});
      },
      dataOf: (x: unknown, moduleId: unknown) => {
        const e = rt.resolve(x);
        const d = e.data[str(moduleId, 'module id', 80)];
        return d === undefined ? undefined : Object.freeze(structuredClone(d));
      },
      food: {
        register: (kind: unknown, o: any) => {
          defineOnly('api.food.register');
          const k = str(kind, 'food kind', 32);
          if (RESERVED_KINDS.has(k) || k === 'mushroom') fail(`'${k}' is a core kind`);
          const restores = num(o?.restores, 'restores', 1, 100);
          let eatableBy: Faction[] | undefined;
          if (o?.eatableBy !== undefined) {
            if (!Array.isArray(o.eatableBy) || o.eatableBy.some((f: unknown) => f !== 'monster' && f !== 'human')) fail("eatableBy must be an array of 'monster' | 'human'");
            eatableBy = [...o.eatableBy];
          }
          const existing = sim.foodKinds.get(k);
          if (existing && existing.owner !== mod.id) fail(`food kind '${k}' is already registered by another module`);
          if (!existing && mod.foods.size >= CAPS.foods) fail(`at most ${CAPS.foods} food kinds per module`);
          mod.foods.add(k);
          sim.foodKinds.set(k, { restores, eatableBy, owner: mod.id });
        },
      },
      vis,
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
        const day = sim.time.day;
        if (mod.logDay !== day) {
          mod.logDay = day;
          mod.logCount = 0;
        }
        if (++mod.logCount > CAPS.logsPerDay) return;
        sim.log(t, imp, mod.id);
      },
    };
    return makeFrozenApi(api);
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

  private each(hook: keyof NonNullable<ModuleDef['hooks']>, ...args: (Entity | undefined)[]) {
    for (const m of this.mods) {
      const fn = m.def.hooks?.[hook];
      if (typeof fn !== 'function' || m.status !== 'active') continue;
      this.call(m, hook, () => fn(m.api, ...args.map((a) => (a ? this.view(a) : a))));
    }
  }

  onDawn() {
    this.each('onDawn');
  }
  onDusk() {
    this.each('onDusk');
  }
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
  onSpawn(e: Entity) {
    this.each('onSpawn', e);
  }
  onDeath(e: Entity) {
    this.each('onDeath', e);
  }
  onEat(e: Entity, food: Entity) {
    this.each('onEat', e, food);
  }
  onArrive(e: Entity) {
    this.each('onArrive', e);
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

  /** Enforce the per-module state cap; returns ids that were quarantined. */
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

function makeFrozenApi<T extends Record<string, any>>(api: T): T {
  // freeze the namespaces, never through getters (api.state is the module's own mutable object)
  for (const k of ['world', 'ent', 'vis', 'food', 'events']) Object.freeze(api[k]);
  return Object.freeze(api);
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
