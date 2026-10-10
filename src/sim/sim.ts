import { Rng, hashSeed } from './rng';
import { DUSK_TICK, TICKS_PER_DAY, timeInfo, type TimeInfo } from './time';
import { SIZE, TileGrid } from './world';
import { generateIsland, type IslandLayout } from './island-gen';
import { findPath, type CostTable } from './pathfind';
import { CORE_SHAPES, CORE_EMITTERS } from './core-defs';
import { makeName } from './names';
import type { Atmosphere, ChronicleEvent, EmitterDef, Entity, Faction, ShapeDef, Stat } from './types';

export const FACTIONS: Record<Faction, { count: number; maxHp: number; speed: number; strength: number; scale: number; cap: number; house: string; capacity: number }> = {
  monster: { count: 6, maxHp: 100, speed: 2.2, strength: 10, scale: 1.4, cap: 12, house: 'hut', capacity: 2 },
  human: { count: 14, maxHp: 40, speed: 2.6, strength: 3, scale: 0.9, cap: 28, house: 'cottage', capacity: 4 },
};

export const CORE_BEHAVIORS = ['sleep', 'go-home', 'seek-food', 'wander'] as const;
export const BERRY_RESTORES = 35;
export const MUSHROOM_RESTORES = 25;
export const MAX_REPATHS_PER_TICK = 30;
export const ENTITY_CAP = 450;

/** A behavior contributed by a module (wrapped by the module runtime for faults/attribution). */
export interface BehaviorEntry {
  id: string;
  owner: string;
  appliesTo(e: Entity): boolean;
  score(e: Entity): number;
  act(e: Entity): void;
}

export interface SimListener {
  onDawn?(): void;
  onDusk?(): void;
  onTick?(): void;
  onSpawn?(e: Entity): void;
  onDeath?(e: Entity): void;
  onEat?(e: Entity, food: Entity): void;
  onArrive?(e: Entity): void;
}

export interface FoodKind {
  restores: number;
  eatableBy?: Faction[];
  owner: string;
}

export interface DayStats {
  day: number;
  births: number;
  deaths: number;
  ate: Record<Faction, number>;
  slept: Record<Faction, number>;
  behaviorTicks: Record<string, number>;
}

export type EmitterOp =
  | { op: 'attach'; ent: number; emitter: string }
  | { op: 'detach'; ent: number; emitter: string }
  | { op: 'burst'; emitter: string; x: number; y: number; z: number };

export interface Emote {
  ent: number;
  text: string;
  seconds: number;
  speech: boolean;
}

function emptyDayStats(day: number): DayStats {
  return { day, births: 0, deaths: 0, ate: { monster: 0, human: 0 }, slept: { monster: 0, human: 0 }, behaviorTicks: {} };
}

export class Sim {
  seed: number;
  tick = 0;
  rng: Rng;
  grid = new TileGrid();
  layout!: IslandLayout;
  ents = new Map<number, Entity>();
  nextId = 1;

  shapes = new Map<string, ShapeDef>();
  emitters = new Map<string, EmitterDef>();
  defsVersion = 0;
  attached = new Map<number, Set<string>>();
  atmosphere: Atmosphere = {};

  behaviors: BehaviorEntry[] = [];
  ruleFns: { owner: string; fn: (kind: string, tile: string) => number | undefined }[] = [];
  foodKinds = new Map<string, FoodKind>();
  listeners: SimListener[] = [];

  costTables = new Map<string, CostTable>();
  private costVersion = -1;
  rulesVersion = 0;
  repathQueue: number[] = [];
  repathsThisTick = 0;

  dayStats: DayStats = emptyDayStats(0);
  history: DayStats[] = [];

  // per-tick output buffers, drained by the worker
  out = { emitterOps: [] as EmitterOp[], emotes: [] as Emote[], events: [] as ChronicleEvent[], atmosphereDirty: false };

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = new Rng(hashSeed(this.seed, 'sim'));
    for (const [id, s] of Object.entries(CORE_SHAPES)) this.shapes.set(id, s);
    for (const [id, e] of Object.entries(CORE_EMITTERS)) this.emitters.set(id, e);
    this.foodKinds.set('mushroom', { restores: MUSHROOM_RESTORES, owner: '' });
  }

  get time(): TimeInfo {
    return timeInfo(this.tick);
  }

  /** Create a fresh island from the seed. */
  generate() {
    this.layout = generateIsland(this.seed, this.grid);
    const L = this.layout;
    this.spawn({ kind: 'shrine', x: L.shrine.x + 0.5, z: L.shrine.z + 0.5, shape: 'shrine' });
    for (const b of L.bushes) {
      const e = this.spawn({ kind: 'berry-bush', x: b.x + 0.5, z: b.z + 0.5, shape: 'berry-bush-3' });
      e.berries = 3;
      e.growAt = this.tick + 300;
    }
    const houses: Record<Faction, Entity[]> = { monster: [], human: [] };
    for (const [faction, spots] of [['monster', L.huts], ['human', L.cottages]] as const) {
      const F = FACTIONS[faction];
      for (const p of spots) {
        const h = this.spawn({ kind: 'house', x: p.x + 0.5, z: p.z + 0.5, shape: F.house });
        h.faction = faction;
        h.capacity = F.capacity;
        h.yaw = this.rng.next() * Math.PI * 2;
        houses[faction].push(h);
      }
      for (let k = 0; k < F.count; k++) {
        const home = houses[faction][k % houses[faction].length];
        this.spawnInhabitant(faction, home);
      }
    }
    this.out.events.length = 0;
  }

  // ---------- entities ----------

  spawn(o: { kind: string; x: number; z: number; shape: string; tint?: string; scale?: number; tags?: string[]; owner?: string }): Entity {
    const e: Entity = {
      id: this.nextId++, kind: o.kind, inhabitant: false, x: o.x, z: o.z, yaw: 0,
      hp: 1, hunger: 0, base: { speed: 2, maxHp: 1, strength: 0, hungerRate: 0 }, mods: {},
      homeId: -1, behavior: '', tags: [...(o.tags ?? [])], tagOwners: {}, shape: o.shape,
      tint: o.tint ?? '#ffffff', scale: o.scale ?? 1, hidden: false, owner: o.owner ?? '',
      path: null, want: null, idleUntil: 0, target: -1, targetSince: 0, suppressed: {}, data: {},
    };
    for (const t of e.tags) e.tagOwners[t] = e.owner;
    this.ents.set(e.id, e);
    return e;
  }

  spawnInhabitant(faction: Faction, home: Entity, newborn = false): Entity {
    const F = FACTIONS[faction];
    const tint = faction === 'monster'
      ? this.rng.pick(['#8e5bb5', '#5b9e6e', '#c0593f', '#4f7fbf', '#b58a3a', '#7a6a5a'])!
      : this.rng.pick(['#d9a066', '#c47e57', '#8d5a3b', '#e3b98a', '#a8714a'])!;
    const e = this.spawn({ kind: faction, x: home.x, z: home.z + 0.9, shape: faction, tint, scale: newborn ? F.scale * 0.75 : F.scale });
    if (!this.walkableFor(faction, Math.floor(e.x), Math.floor(e.z))) {
      e.z = home.z;
    }
    e.faction = faction;
    e.inhabitant = true;
    e.name = makeName(this.rng, faction);
    e.base = { speed: F.speed, maxHp: F.maxHp, strength: F.strength, hungerRate: 1 };
    e.hp = F.maxHp;
    e.hunger = 20;
    e.homeId = home.id;
    e.behavior = 'wander';
    e.yaw = this.rng.next() * Math.PI * 2;
    for (const l of this.listeners) l.onSpawn?.(e);
    return e;
  }

  remove(e: Entity) {
    if (!this.ents.has(e.id)) return;
    this.ents.delete(e.id);
    if (this.attached.has(e.id)) {
      for (const em of this.attached.get(e.id)!) this.out.emitterOps.push({ op: 'detach', ent: e.id, emitter: em });
      this.attached.delete(e.id);
    }
    if (e.reservedBy !== undefined) {
      const r = this.ents.get(e.reservedBy);
      if (r && r.target === e.id) r.target = -1;
    }
  }

  kill(e: Entity, cause: string) {
    if (!e.inhabitant || !this.ents.has(e.id)) return;
    for (const l of this.listeners) l.onDeath?.(e);
    this.remove(e);
    const g = this.spawn({ kind: 'gravestone', x: e.x, z: e.z, shape: 'gravestone' });
    g.diedAt = this.tick;
    g.name = e.name;
    this.dayStats.deaths++;
    this.log(`${e.name} the ${e.faction} died (${cause}).`, 2, 'core', 'death');
  }

  stat(e: Entity, s: Stat): number {
    let v = e.base[s];
    const m = e.mods[s];
    if (m) {
      let mul = 1, add = 0;
      for (const k in m) {
        mul *= m[k].mul;
        add += m[k].add;
      }
      v = v * mul + add;
    }
    return Math.max(0, v);
  }

  inhabitants(faction?: Faction): Entity[] {
    const out: Entity[] = [];
    for (const e of this.ents.values()) if (e.inhabitant && (!faction || e.faction === faction)) out.push(e);
    return out;
  }

  /** Entity count toward the global cap (gravestones excluded). */
  entityCount(): number {
    let n = 0;
    for (const e of this.ents.values()) if (e.kind !== 'gravestone') n++;
    return n;
  }

  log(text: string, importance = 1, source = 'core', kind?: string) {
    const t = this.time;
    this.out.events.push({ tick: t.tick, day: t.day, text, importance, source, kind });
  }

  emote(e: Entity, text: string, seconds: number, speech = false) {
    this.out.emotes.push({ ent: e.id, text, seconds, speech });
  }

  attach(e: Entity, emitter: string) {
    let s = this.attached.get(e.id);
    if (!s) this.attached.set(e.id, (s = new Set()));
    if (s.has(emitter)) return;
    s.add(emitter);
    this.out.emitterOps.push({ op: 'attach', ent: e.id, emitter });
  }

  detach(e: Entity, emitter: string) {
    const s = this.attached.get(e.id);
    if (!s || !s.delete(emitter)) return;
    if (!s.size) this.attached.delete(e.id);
    this.out.emitterOps.push({ op: 'detach', ent: e.id, emitter });
  }

  attachedCount(): number {
    let n = 0;
    for (const s of this.attached.values()) n += s.size;
    return n;
  }

  // ---------- movement & paths ----------

  costsFor(kind: string): CostTable {
    const v = this.grid.defsVersion * 100000 + this.rulesVersion;
    if (v !== this.costVersion) {
      this.costTables.clear();
      this.costVersion = v;
    }
    let t = this.costTables.get(kind);
    if (!t) {
      t = new Map();
      for (const [id, d] of this.grid.defs) {
        let blocked = false, best: number | undefined;
        for (const r of this.ruleFns) {
          let c: number | undefined;
          try {
            c = r.fn(kind, id);
          } catch {
            c = undefined;
          }
          if (typeof c !== 'number' || Number.isNaN(c) || c < 0) continue;
          if (c === Infinity) blocked = true;
          else if (best === undefined || c > best) best = c;
        }
        const base = d.walkable ? d.moveCost : Infinity;
        t.set(id, blocked ? Infinity : best !== undefined ? Math.max(0.05, best) : base);
      }
      this.costTables.set(kind, t);
    }
    return t;
  }

  invalidateCosts() {
    this.rulesVersion++;
    for (const e of this.ents.values()) if (e.path) this.requeue(e);
  }

  walkableFor(kind: string, x: number, z: number): boolean {
    if (!this.grid.inBounds(x, z)) return false;
    return isFinite(this.costsFor(kind).get(this.grid.get(x, z)) ?? Infinity);
  }

  /** A tile changed type: requeue every path that crosses it. */
  tileChanged(i: number) {
    for (const e of this.ents.values()) if (e.path && e.path.pts.includes(i)) this.requeue(e);
  }

  /** Move an inhabitant standing on a tile it can't walk on to the nearest walkable tile. */
  private unstrand(e: Entity) {
    const cx = Math.floor(e.x), cz = Math.floor(e.z);
    for (let r = 1; r <= 8; r++) {
      let best: [number, number] | null = null, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!this.walkableFor(e.kind, cx + dx, cz + dz)) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = [cx + dx, cz + dz]; }
      }
      if (best) {
        e.x = best[0] + 0.5;
        e.z = best[1] + 0.5;
        this.stop(e);
        this.out.emitterOps.push({ op: 'burst', emitter: 'puff', x: e.x, y: this.grid.height(best[0], best[1]) + 0.3, z: e.z });
        return;
      }
    }
  }

  requeue(e: Entity) {
    if (!e.path) return;
    e.want = { gx: e.path.gx, gz: e.path.gz };
    if (!this.repathQueue.includes(e.id)) this.repathQueue.push(e.id);
  }

  /** Path entity to a tile. Computes now if within the tick's budget, else queues. */
  goTo(e: Entity, gx: number, gz: number): boolean {
    gx = Math.floor(gx);
    gz = Math.floor(gz);
    if ((e.path && e.path.gx === gx && e.path.gz === gz) || (e.want && e.want.gx === gx && e.want.gz === gz)) return true;
    if (!this.walkableFor(e.kind, gx, gz)) return false;
    if (this.repathsThisTick < MAX_REPATHS_PER_TICK) return this.computePath(e, gx, gz);
    e.want = { gx, gz };
    if (!this.repathQueue.includes(e.id)) this.repathQueue.push(e.id);
    return true;
  }

  private computePath(e: Entity, gx: number, gz: number): boolean {
    this.repathsThisTick++;
    e.want = null;
    const pts = findPath(this.grid, this.costsFor(e.kind), Math.floor(e.x), Math.floor(e.z), gx, gz);
    if (!pts) {
      e.path = null;
      this.onPathFailed(e);
      return false;
    }
    e.path = { pts, i: 0, gx, gz };
    return true;
  }

  private onPathFailed(e: Entity) {
    if (e.target >= 0) {
      const f = this.ents.get(e.target);
      if (f) {
        f.reservedBy = -2;
        f.reservedUntil = this.tick + 200;
      }
      e.target = -1;
    }
    e.idleUntil = this.tick + 10;
  }

  stop(e: Entity) {
    e.path = null;
    e.want = null;
  }

  private processRepaths() {
    while (this.repathQueue.length && this.repathsThisTick < MAX_REPATHS_PER_TICK) {
      const id = this.repathQueue.shift()!;
      const e = this.ents.get(id);
      if (!e || !e.want) continue;
      this.computePath(e, e.want.gx, e.want.gz);
    }
  }

  /** Straight-line step at e's speed, no pathing. */
  moveToward(e: Entity, x: number, z: number) {
    const step = this.stat(e, 'speed') / 10;
    const dx = x - e.x, dz = z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    const k = Math.min(1, step / d);
    e.x = Math.min(SIZE - 0.01, Math.max(0, e.x + dx * k));
    e.z = Math.min(SIZE - 0.01, Math.max(0, e.z + dz * k));
    e.yaw = Math.atan2(dx, dz);
  }

  private advancePath(e: Entity) {
    const p = e.path;
    if (!p) return;
    const costs = this.costsFor(e.kind);
    const tileCost = costs.get(this.grid.get(Math.floor(e.x), Math.floor(e.z))) ?? 1;
    let budget = this.stat(e, 'speed') / 10 / Math.min(4, Math.max(0.5, isFinite(tileCost) ? tileCost : 1));
    while (budget > 0 && p.i < p.pts.length) {
      const ti = p.pts[p.i];
      const tx = (ti % SIZE) + 0.5, tz = Math.floor(ti / SIZE) + 0.5;
      const dx = tx - e.x, dz = tz - e.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) e.yaw = Math.atan2(dx, dz);
      if (d <= budget) {
        e.x = tx;
        e.z = tz;
        budget -= d;
        p.i++;
      } else {
        e.x += (dx / d) * budget;
        e.z += (dz / d) * budget;
        budget = 0;
      }
    }
    if (p.i >= p.pts.length) {
      e.path = null;
      for (const l of this.listeners) l.onArrive?.(e);
      this.onArriveCore(e);
    }
  }

  // ---------- food ----------

  isFood(f: Entity, eater: Entity): number {
    if (f.kind === 'berry-bush') return (f.berries ?? 0) > 0 ? BERRY_RESTORES : 0;
    const k = this.foodKinds.get(f.kind);
    if (!k) return 0;
    if (k.eatableBy && eater.faction && !k.eatableBy.includes(eater.faction)) return 0;
    return k.restores;
  }

  private available(f: Entity, eater: Entity) {
    if (f.reservedBy === undefined || f.reservedBy === eater.id) return true;
    if ((f.reservedUntil ?? 0) <= this.tick) return true;
    if (f.reservedBy >= 0) {
      const r = this.ents.get(f.reservedBy);
      if (!r || r.target !== f.id || r.behavior !== 'seek-food') return true;
    }
    return false;
  }

  nearestFood(e: Entity, maxR: number): Entity | null {
    let best: Entity | null = null, bd = maxR * maxR;
    for (const f of this.ents.values()) {
      if (f.inhabitant || !this.isFood(f, e) || !this.available(f, e)) continue;
      const d = (f.x - e.x) ** 2 + (f.z - e.z) ** 2;
      if (d <= bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  }

  feed(e: Entity, n: number) {
    e.hunger = Math.max(0, Math.min(100, e.hunger - n));
  }

  private eat(e: Entity, f: Entity) {
    const restores = this.isFood(f, e);
    if (!restores) return;
    this.feed(e, restores);
    if (e.faction) this.dayStats.ate[e.faction]++;
    if (f.kind === 'berry-bush') {
      f.berries = (f.berries ?? 1) - 1;
      f.shape = `berry-bush-${f.berries}`;
      if (f.growAt === undefined || f.growAt < this.tick) f.growAt = this.tick + 300;
      f.reservedBy = undefined;
    }
    for (const l of this.listeners) l.onEat?.(e, f);
    if (f.kind !== 'berry-bush') this.remove(f);
    this.emote(e, '😋', 1.5);
  }

  // ---------- behaviors ----------

  home(e: Entity): Entity | undefined {
    return this.ents.get(e.homeId);
  }

  atHome(e: Entity): boolean {
    const h = this.home(e);
    return !!h && Math.abs(e.x - h.x) < 0.8 && Math.abs(e.z - h.z) < 0.8;
  }

  isSuppressed(e: Entity, id: string) {
    const u = e.suppressed[id];
    if (u === undefined) return false;
    if (u <= this.tick) {
      delete e.suppressed[id];
      return false;
    }
    return true;
  }

  private coreScore(e: Entity, id: string, t: TimeInfo): number {
    switch (id) {
      case 'sleep':
        return t.isNight && (e.behavior === 'sleep' || this.atHome(e)) ? 100 : 0;
      case 'go-home':
        return t.isNight && this.home(e) ? 90 : 0;
      case 'seek-food':
        if (e.hunger <= 30) return 0;
        if (e.behavior === 'seek-food' && e.target >= 0 && this.ents.has(e.target)) return e.hunger;
        return this.nearestFood(e, 10) ? e.hunger : 0;
      case 'wander':
        return 10;
    }
    return 0;
  }

  private chooseBehavior(e: Entity, t: TimeInfo) {
    let bestId = '', best = -1;
    let bestEntry: BehaviorEntry | null = null;
    for (const id of CORE_BEHAVIORS) {
      if (this.isSuppressed(e, id)) continue;
      let s = this.coreScore(e, id, t);
      if (id === e.behavior) s += 5;
      if (s > best) {
        best = s;
        bestId = id;
      }
    }
    for (const b of this.behaviors) {
      if (this.isSuppressed(e, b.id) || !b.appliesTo(e)) continue;
      let s = b.score(e);
      s = Number.isFinite(s) ? Math.min(100, Math.max(0, s)) : 0;
      if (b.id === e.behavior) s += 5;
      if (s > best) {
        best = s;
        bestId = b.id;
        bestEntry = b;
      }
    }
    if (bestId !== e.behavior) this.leaveBehavior(e, e.behavior, bestId);
    e.behavior = bestId || 'wander';
    return bestEntry;
  }

  private leaveBehavior(e: Entity, from: string, _to: string) {
    if (from === 'sleep') {
      e.hidden = false;
      const h = this.home(e);
      if (h) this.updateHouseSleep(h);
    }
    if (from === 'seek-food' && e.target >= 0) {
      const f = this.ents.get(e.target);
      if (f && f.reservedBy === e.id) f.reservedBy = undefined;
      e.target = -1;
    }
    if (from !== _to) this.stop(e);
  }

  private actCore(e: Entity, id: string, t: TimeInfo) {
    switch (id) {
      case 'sleep': {
        if (!e.hidden) {
          e.hidden = true;
          this.stop(e);
          if (e.faction) this.dayStats.slept[e.faction]++;
          const h = this.home(e);
          if (h) {
            e.x = h.x;
            e.z = h.z;
            this.updateHouseSleep(h);
          }
        }
        if (e.hunger < 50 && t.tick % 30 === 0) e.hp = Math.min(this.stat(e, 'maxHp'), e.hp + 1);
        break;
      }
      case 'go-home': {
        const h = this.home(e);
        if (h && !e.path && !e.want) this.goTo(e, h.x, h.z);
        break;
      }
      case 'seek-food': {
        let f = e.target >= 0 ? this.ents.get(e.target) : undefined;
        if (!f || !this.isFood(f, e)) {
          f = this.nearestFood(e, 10) ?? undefined;
          if (!f) return;
          e.target = f.id;
          e.targetSince = t.tick;
          f.reservedBy = e.id;
          f.reservedUntil = t.tick + 200;
          if (!this.goTo(e, f.x, f.z)) return;
        }
        if (t.tick - e.targetSince > 200) {
          // reservation lapsed: let it go
          if (f.reservedBy === e.id) f.reservedBy = undefined;
          e.target = -1;
          this.stop(e);
          return;
        }
        if (Math.hypot(f.x - e.x, f.z - e.z) < 0.9) {
          this.stop(e);
          this.eat(e, f);
          e.target = -1;
        } else if (!e.path && !e.want) {
          this.goTo(e, f.x, f.z);
        }
        break;
      }
      case 'wander': {
        if (e.path || e.want || e.idleUntil > t.tick) return;
        const h = this.home(e);
        const cx = h ? h.x : e.x, cz = h ? h.z : e.z;
        for (let k = 0; k < 6; k++) {
          const x = Math.floor(cx + this.rng.int(-6, 6)), z = Math.floor(cz + this.rng.int(-6, 6));
          if (this.walkableFor(e.kind, x, z) && this.goTo(e, x, z)) break;
        }
        e.idleUntil = t.tick + this.rng.int(5, 40);
        break;
      }
    }
  }

  private onArriveCore(e: Entity) {
    if (e.behavior === 'wander') e.idleUntil = this.tick + this.rng.int(10, 60);
  }

  updateHouseSleep(h: Entity) {
    let sleepers = 0;
    for (const e of this.ents.values()) if (e.inhabitant && e.homeId === h.id && e.hidden && e.behavior === 'sleep') sleepers++;
    if (sleepers > 0) this.attach(h, 'zzz');
    else this.detach(h, 'zzz');
    const base = h.faction === 'monster' ? 'hut' : 'cottage';
    const lit = sleepers > 0 && this.time.isNight;
    h.shape = lit ? `${base}-lit` : base;
  }

  // ---------- the tick ----------

  step() {
    this.tick++;
    this.repathsThisTick = 0;
    const t = this.time;

    if (t.dayTick === 0) this.dawn(t);
    if (t.dayTick === DUSK_TICK) for (const l of this.listeners) l.onDusk?.();

    // food growth
    if (t.tick % 100 === 0) this.spawnMushroom();
    for (const f of this.ents.values()) {
      if (f.kind === 'berry-bush' && (f.berries ?? 0) < 3 && (f.growAt ?? 0) <= t.tick) {
        f.berries = (f.berries ?? 0) + 1;
        f.shape = `berry-bush-${f.berries}`;
        f.growAt = t.tick + 300;
      }
    }

    this.processRepaths();

    const dying: Entity[] = [];
    for (const e of [...this.ents.values()]) {
      if (!this.ents.has(e.id)) continue;
      if (!e.inhabitant) {
        if (e.path || e.want) this.advancePath(e);
        continue;
      }
      // needs
      e.hunger = Math.min(100, e.hunger + this.stat(e, 'hungerRate') / 30);
      if (e.hunger >= 100) e.hp -= 1 / 30;
      const maxHp = this.stat(e, 'maxHp');
      if (e.hp > maxHp) e.hp = maxHp;
      if (e.hp <= 0) {
        dying.push(e);
        continue;
      }
      if (!e.path && !e.want && !e.hidden && !this.walkableFor(e.kind, Math.floor(e.x), Math.floor(e.z))) this.unstrand(e);
      // behavior
      const entry = this.chooseBehavior(e, t);
      this.dayStats.behaviorTicks[e.behavior] = (this.dayStats.behaviorTicks[e.behavior] ?? 0) + 1;
      if (entry) entry.act(e);
      else this.actCore(e, e.behavior, t);
      if (this.ents.has(e.id) && (e.path || e.want) && !e.hidden) this.advancePath(e);
    }
    for (const e of dying) {
      const by = e.harmedBy ?? '';
      this.kill(e, e.hunger >= 100 && !by ? 'starvation' : by ? `wounds from ${by}` : 'wounds');
    }

    for (const l of this.listeners) l.onTick?.();
  }

  private dawn(t: TimeInfo) {
    if (t.day > 0) {
      this.history.push(this.dayStats);
      if (this.history.length > 5) this.history.shift();
    }
    this.dayStats = emptyDayStats(t.day);
    // gravestones fade after 3 days
    for (const g of [...this.ents.values()]) {
      if (g.kind === 'gravestone' && t.tick - (g.diedAt ?? 0) >= 3 * TICKS_PER_DAY) this.remove(g);
    }
    // births
    for (const faction of ['monster', 'human'] as Faction[]) {
      const pop = this.inhabitants(faction);
      if (!pop.length) continue;
      const avg = pop.reduce((s, e) => s + e.hunger, 0) / pop.length;
      if (avg >= 40) continue;
      let count = pop.length;
      for (const h of this.ents.values()) {
        if (h.kind !== 'house' || h.faction !== faction) continue;
        if (count >= FACTIONS[faction].cap) break;
        const residents = pop.filter((e) => e.homeId === h.id).length;
        if (residents >= (h.capacity ?? 0)) continue;
        if (!this.rng.chance(0.3)) continue;
        const baby = this.spawnInhabitant(faction, h, true);
        count++;
        this.dayStats.births++;
        this.log(`${baby.name} was born to the ${faction}s.`, 1, 'core', 'birth');
      }
    }
    for (const h of this.ents.values()) if (h.kind === 'house') this.updateHouseSleep(h);
    for (const l of this.listeners) l.onDawn?.();
  }

  private spawnMushroom() {
    let n = 0;
    for (const e of this.ents.values()) if (e.kind === 'mushroom') n++;
    if (n >= 15) return;
    for (let k = 0; k < 10; k++) {
      const x = this.rng.int(0, SIZE - 1), z = this.rng.int(0, SIZE - 1);
      if (this.grid.get(x, z) !== 'forest') continue;
      this.spawn({ kind: 'mushroom', x: x + 0.5, z: z + 0.5, shape: 'mushroom' });
      return;
    }
  }

  /** Drain chronicle/visual output accumulated since the last call. */
  drainOut() {
    const o = this.out;
    this.out = { emitterOps: [], emotes: [], events: [], atmosphereDirty: false };
    return o;
  }
}
