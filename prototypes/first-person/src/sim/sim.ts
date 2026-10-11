// The core simulation: entities, the game clock, movement, the tick. Systems live in village.ts, monster-ai.ts,
// combat.ts, champion.ts, favor.ts, vision.ts; this file owns state and the per-tick order.
import { Rng, hashSeed } from './rng';
import { DAY_MS, HOUR_MS, MS_PER_REAL_TICK, baseLight, calDay, hourOf, isNightHour, type TimeInfo } from './clock';
import { SIZE, TileGrid } from './world';
import { generateIsland, type IslandLayout } from './island-gen';
import type { TerrainSettings } from './terrain-import';
import { findPath, type CostTable } from './pathfind';
import { CORE_EMITTERS, CORE_SHAPES } from './core-defs';
import type { Atmosphere, ChronicleEvent, CreationRecord, CreationRequest, EmitterDef, Entity, Faction, ShapeDef, Stat } from './types';
import { populate } from './populate';
import { stepHuman, villageHour, villageMidnight, foodTick } from './village';
import { stepMonster, monsterMidnight } from './monster-ai';
import { stepCorpse, stepBurning, stepAnimal } from './combat';
import { stepChampion, championDawn, checkSuccession, processInputs, type ChampInput, type Order } from './champion';
import { Ground } from './ground';
import { bodyR } from './body';
import { judgment } from './favor';
import { updateVision } from './vision';
import { stepSpear } from './spears';
import { raidHour } from './monster-ai';

export const ENTITY_CAP = 600;
export const MAX_REPATHS_PER_TICK = 4;
/** Module behaviors must score above this to take an inhabitant away from its core AI for a tick. */
export const CORE_BASELINE = 50;
export const LOCKED_STATES = new Set(['captive', 'downed', 'bound', 'carry', 'sacrifice', 'dead']);

export interface BehaviorEntry {
  id: string;
  owner: string;
  appliesTo(e: Entity): boolean;
  score(e: Entity): number;
  act(e: Entity): void;
}

export interface DamageInfo {
  amount: number;
  type: string;
  targetKind: string;
  targetFaction?: Faction;
  sourceKind: string;
  sourceFaction?: Faction;
}

export interface DeathInfo {
  amount: number;
  type: string;
  zone?: string;
  sourceId: number;
  sourceKind: string;
  deathType?: string;
}

export interface SimListener {
  onTick?(): void;
  onHour?(): void;
  onDawn?(): void;
  onDusk?(): void;
  onMidnight?(): void;
  onSpawn?(e: Entity): void;
  onDeath?(e: Entity, info: DeathInfo): void;
  onDamage?(e: Entity, info: DeathInfo): void;
  onSacrifice?(info: { faction: Faction; altar: 'village' | 'high'; victimKind: string; favor: number }): void;
  onCapture?(monster: Entity, victim: Entity): void;
  onArrive?(e: Entity): void;
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

export interface Alert {
  kind: 'scream' | 'missing' | 'shofar' | 'judgment' | 'lair' | 'death' | 'info' | 'champion' | 'forbidden' | 'gameover' | 'altar' | 'creation';
  text: string;
  /** entity to point at (scream) */
  ent?: number;
  until?: number; // tick
}

export interface SoundEvent {
  kind: string;
  x: number;
  z: number;
  /** body size, for pitch */
  size?: number;
}

export interface GameStats {
  monsterKills: number;
  villagerDeaths: number;
  humanSacrifices: number;
  monsterSacrifices: number;
}

export class Sim {
  seed: number;
  tick = 0;
  rng: Rng;
  grid = new TileGrid();
  layout!: IslandLayout;
  /** the terraformer settings this island's ground came from (null: procedural) */
  terrain: TerrainSettings | null = null;
  ents = new Map<number, Entity>();
  nextId = 1;

  // clock
  clockMs = 0;
  msPerTick = MS_PER_REAL_TICK;
  timescale = 1;
  createdClock = 0;
  lastRealMs = 0;

  // visuals / defs
  shapes = new Map<string, ShapeDef>();
  emitters = new Map<string, EmitterDef>();
  defsVersion = 0;
  attached = new Map<number, Set<string>>();
  atmosphere: Atmosphere = {};

  // modules
  behaviors: BehaviorEntry[] = [];
  ruleFns: { owner: string; fn: (kind: string, tile: string) => number | undefined }[] = [];
  damageRules: { owner: string; fn: (info: DamageInfo) => number | undefined }[] = [];
  listeners: SimListener[] = [];

  // paths
  costTables = new Map<string, CostTable>();
  private costVersion = -1;
  rulesVersion = 0;
  /** bumped when a module changes tiles (work-site caches rebuild) */
  tileEpoch = 0;
  productionRules: { owner: string; fn: (job: string) => number | undefined }[] = [];
  repathQueue: number[] = [];
  repathsThisTick = 0;

  // game state
  explored = new Uint8Array(SIZE * SIZE);
  exploredChanged: number[] = [];
  stock = new Float32Array(SIZE * SIZE).fill(1);
  food = 300;
  foodCap = 500;
  timber = 0;
  fold = 6;
  favor: Record<Faction, number> = { human: 0, monster: 0 };
  prayer = '';
  alarmUntil = 0;
  alarmCooldownUntil = 0;
  /** clockMs the current raid on the village ends (0 = none); rolled each evening */
  raidUntil = 0;
  pendingCreations: CreationRequest[] = [];
  domainHistory: Record<Faction, { night: number; domain: string }[]> = { human: [], monster: [] };
  nightIndex = 0;
  lastJudgedCalDay = -1;
  creations: CreationRecord[] = [];
  missingSystems = ['Pain', 'Aging', 'Desire and birth', 'Cooking and the oven', 'Hunger', 'Sleep', 'Metalworking', 'Speech among monsters'];
  championId = -1;
  championPendingDawn = false;
  /** the champion's current internal order (autopilot, dev scripts) */
  order: Order | null = null;
  /** client input queued for the next tick (§9.3) */
  inputs: ChampInput[] = [];
  /** the result of the last interact/finish input, for the client */
  actionError: string | null = null;
  /** the shared ground height function (meters) */
  ground: Ground = new Ground(this.grid);
  dragging = -1;
  gameOver: { winner: Faction; day: number } | null = null;
  stats: GameStats = { monsterKills: 0, villagerDeaths: 0, humanSacrifices: 0, monsterSacrifices: 0 };

  /** off in validator clones: no creation requests are queued */
  judgmentEnabled = true;
  /** dev: the champion cannot drop below 1 HP */
  invincible = false;
  /** dev: no fog of war */
  revealAll = false;

  /** cached per tick */
  light = 1;

  out = { emitterOps: [] as EmitterOp[], emotes: [] as Emote[], events: [] as ChronicleEvent[], alerts: [] as Alert[], atmosphereDirty: false, sounds: [] as SoundEvent[], toasts: [] as string[], hurt: 0 as number | undefined };

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = new Rng(hashSeed(this.seed, 'sim'));
    for (const [id, s] of Object.entries(CORE_SHAPES)) this.shapes.set(id, s);
    for (const [id, e] of Object.entries(CORE_EMITTERS)) this.emitters.set(id, e);
  }

  get time(): TimeInfo {
    const hour = hourOf(this.clockMs);
    return {
      tick: this.tick, clockMs: this.clockMs, day: this.day, hour, isNight: isNightHour(hour), msPerTick: this.msPerTick, light: this.light,
    };
  }

  /** 1-based game day; an island created in the afternoon doesn't count its first midnight (R3) */
  get day(): number {
    const d = calDay(this.clockMs) - calDay(this.createdClock);
    return Math.max(1, d + (hourOf(this.createdClock) >= 12 ? 0 : 1));
  }

  get hour(): number {
    return hourOf(this.clockMs);
  }

  computeLight(): number {
    const L = baseLight(this.hour);
    const a = this.atmosphere;
    return Math.max(0, Math.min(1, L * (1 - (a.darkness ?? 0)) + (a.light ?? 0) * (1 - L)));
  }

  /** Create a fresh island. clockMs is local wall time (see clock.ts). */
  generate(clockMs: number, timescale = 1, terrain: TerrainSettings | null = null) {
    this.clockMs = this.createdClock = clockMs;
    this.timescale = timescale;
    this.msPerTick = MS_PER_REAL_TICK * timescale;
    this.terrain = terrain;
    this.layout = generateIsland(this.seed, this.grid, terrain);
    this.ground.rebuild();
    this.grid.groundChanged.clear();
    populate(this);
    this.light = this.computeLight();
    updateVision(this, true);
    this.out.events.length = 0;
  }

  // ---------- entities ----------

  spawn(o: { kind: string; x: number; z: number; shape: string; tint?: string; scale?: number; tags?: string[]; owner?: string }): Entity {
    const e: Entity = {
      id: this.nextId++, kind: o.kind, inhabitant: false, x: o.x, z: o.z, yaw: 0,
      hp: 1, base: { speed: 1, maxHp: 1, strength: 1, sight: 1 }, mods: {}, level: 1, xp: 0,
      state: '', stateUntil: 0, target: -1, tags: [...(o.tags ?? [])], tagOwners: {}, shape: o.shape,
      tint: o.tint ?? '#ffffff', scale: o.scale ?? 1, lift: 0, roll: 0, squash: 1, hidden: false, owner: o.owner ?? '',
      path: null, want: null, idleUntil: 0, data: {},
    };
    for (const t of e.tags) e.tagOwners[t] = e.owner;
    this.ents.set(e.id, e);
    return e;
  }

  remove(e: Entity) {
    if (!this.ents.has(e.id)) return;
    this.ents.delete(e.id);
    if (this.attached.has(e.id)) {
      for (const em of this.attached.get(e.id)!) this.out.emitterOps.push({ op: 'detach', ent: e.id, emitter: em });
      this.attached.delete(e.id);
    }
    if (this.dragging === e.id) this.dragging = -1;
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
    return Math.max(s === 'maxHp' ? 1 : 0, v);
  }

  maxHp(e: Entity): number {
    return this.stat(e, 'maxHp');
  }

  humans(): Entity[] {
    const out: Entity[] = [];
    for (const e of this.ents.values()) if (e.kind === 'human') out.push(e);
    return out;
  }

  monsters(): Entity[] {
    const out: Entity[] = [];
    for (const e of this.ents.values()) if (e.kind === 'monster') out.push(e);
    return out;
  }

  champion(): Entity | undefined {
    const c = this.ents.get(this.championId);
    return c && c.kind === 'human' ? c : undefined;
  }

  byRole(role: string): Entity | undefined {
    for (const e of this.ents.values()) if (e.role === role) return e;
    return undefined;
  }

  entityCount(): number {
    let n = 0;
    for (const e of this.ents.values()) if (e.kind !== 'blood') n++;
    return n;
  }

  log(text: string, importance = 1, source = 'core', kind?: string) {
    this.out.events.push({ tick: this.tick, clockMs: this.clockMs, day: this.day, text, importance, source, kind });
  }

  alert(a: Alert) {
    this.out.alerts.push(a);
  }

  emote(e: Entity, text: string, seconds: number, speech = false) {
    if (e.id === this.championId) {
      this.toast(text);
      return;
    }
    this.out.emotes.push({ ent: e.id, text, seconds, speech });
  }

  /** A particle burst; y is meters above sea level (defaults to 1 m above the ground). */
  burst(emitter: string, x: number, z: number, y?: number) {
    const ty = y ?? this.ground.y(x, z) + 1;
    this.out.emitterOps.push({ op: 'burst', emitter, x, y: ty, z });
  }

  /** A burst anchored on an entity's body (F13): feet, center or head. */
  burstOn(emitter: string, e: Entity, anchor: 'feet' | 'center' | 'head' = 'center') {
    const h = (e.kind === 'human' ? 1.8 : 2.25 * e.scale * 0.8);
    const k = anchor === 'feet' ? 0.1 : anchor === 'head' ? 0.9 : 0.55;
    this.burst(emitter, e.x, e.z, this.ground.y(e.x, e.z) + h * k + e.lift);
  }

  /** A positional sound for the client (dropped there if out of earshot). */
  sound(kind: string, x: number, z: number, size?: number) {
    this.out.sounds.push({ kind, x, z, size });
  }

  /** A short message for the player (champion emotes become toasts, F23). */
  toast(text: string) {
    this.out.toasts.push(text);
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

  /** Movement class used for cost tables and rules.moveCost. */
  moveKey(e: Entity): string {
    if (e.monster) {
      const lost = !!e.zones?.sig && e.zones.sig.state !== 'ok';
      return `monster:${e.monster.archetype}|${e.monster.flies && !lost ? 'f' : ''}${e.monster.swims && !lost ? 's' : ''}`;
    }
    return e.kind;
  }

  costsFor(key: string): CostTable {
    const v = this.grid.defsVersion * 100000 + this.rulesVersion;
    if (v !== this.costVersion) {
      this.costTables.clear();
      this.costVersion = v;
    }
    let t = this.costTables.get(key);
    if (!t) {
      t = new Map();
      const [named, flags = ''] = key.split('|');
      const plain = named.split(':')[0];
      const flies = flags.includes('f');
      const swims = flags.includes('s');
      for (const [id, d] of this.grid.defs) {
        let blocked = false, best: number | undefined;
        for (const r of this.ruleFns) {
          for (const k of plain === named ? [named] : [named, plain]) {
            let c: number | undefined;
            try {
              c = r.fn(k, id);
            } catch {
              c = undefined;
            }
            if (typeof c !== 'number' || Number.isNaN(c) || c < 0) continue;
            if (c === Infinity) blocked = true;
            else if (best === undefined || c > best) best = c;
            break;
          }
        }
        let base = d.walkable ? d.moveCost : Infinity;
        if (flies) base = id === 'deep-water' ? 2 : 1;
        if (swims && id === 'shallow-water') base = 1.3;
        if (plain === 'animal' && id === 'road') base = 3;
        if (plain === 'monster' && isFinite(base) && !flies) base = 1 + (base - 1) / 2; // monsters pay half the terrain penalty
        t.set(id, blocked ? Infinity : best !== undefined ? Math.max(0.05, best) : base);
      }
      this.costTables.set(key, t);
    }
    return t;
  }

  invalidateCosts() {
    this.rulesVersion++;
    for (const e of this.ents.values()) if (e.path) this.requeue(e);
  }

  walkableFor(e: Entity | string, x: number, z: number): boolean {
    x = Math.floor(x);
    z = Math.floor(z);
    if (!this.grid.inBounds(x, z)) return false;
    const key = typeof e === 'string' ? e : this.moveKey(e);
    return isFinite(this.costsFor(key).get(this.grid.get(x, z)) ?? Infinity);
  }

  /** Nearest tile walkable for e within r of (x, z), or null. */
  nearestWalkable(e: Entity | string, x: number, z: number, r = 4): { x: number; z: number } | null {
    const cx = Math.floor(x), cz = Math.floor(z);
    if (this.walkableFor(e, cx, cz)) return { x: cx, z: cz };
    for (let d = 1; d <= r; d++) {
      let best: { x: number; z: number } | null = null, bd = Infinity;
      for (let dz = -d; dz <= d; dz++) for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        if (!this.walkableFor(e, cx + dx, cz + dz)) continue;
        const dd = dx * dx + dz * dz;
        if (dd < bd) { bd = dd; best = { x: cx + dx, z: cz + dz }; }
      }
      if (best) return best;
    }
    return null;
  }

  tileChanged(i: number) {
    this.tileEpoch++;
    for (const e of this.ents.values()) if (e.path && e.path.pts.includes(i)) this.requeue(e);
  }

  requeue(e: Entity) {
    if (!e.path) return;
    e.want = { gx: e.path.gx, gz: e.path.gz };
    if (!this.repathQueue.includes(e.id)) this.repathQueue.push(e.id);
  }

  /** Path entity to a tile. Computes now if within the tick's budget, else queues. False if the goal is unwalkable. */
  goTo(e: Entity, gx: number, gz: number): boolean {
    gx = Math.floor(gx);
    gz = Math.floor(gz);
    if ((e.path && e.path.gx === gx && e.path.gz === gz) || (e.want && e.want.gx === gx && e.want.gz === gz)) return true;
    if (!this.walkableFor(e, gx, gz)) {
      const n = this.nearestWalkable(e, gx, gz, 3);
      if (!n) return false;
      gx = n.x;
      gz = n.z;
      if ((e.path && e.path.gx === gx && e.path.gz === gz) || (e.want && e.want.gx === gx && e.want.gz === gz)) return true;
    }
    if (this.repathsThisTick < MAX_REPATHS_PER_TICK) return this.computePath(e, gx, gz);
    e.want = { gx, gz };
    if (!this.repathQueue.includes(e.id)) this.repathQueue.push(e.id);
    return true;
  }

  private computePath(e: Entity, gx: number, gz: number): boolean {
    this.repathsThisTick++;
    e.want = null;
    const pts = findPath(this.grid, this.costsFor(this.moveKey(e)), Math.floor(e.x), Math.floor(e.z), gx, gz);
    if (!pts) {
      e.path = null;
      e.idleUntil = this.tick + 10;
      return false;
    }
    e.path = { pts, i: 0, gx, gz, wp: this.smoothPath(e, pts) };
    return true;
  }

  /** String-pull a tile path (F27): skip waypoints when the straight line costs no more than the tiles it replaces. */
  private smoothPath(e: Entity, pts: number[]): { x: number; z: number }[] {
    const costs = this.costsFor(this.moveKey(e));
    const cost = (i: number) => costs.get(this.grid.types[i]) ?? Infinity;
    const center = (i: number) => ({ x: (i % SIZE) + 0.5, z: Math.floor(i / SIZE) + 0.5 });
    const out: { x: number; z: number }[] = [];
    let ax = e.x, az = e.z, k = 0;
    while (k < pts.length) {
      let best = k;
      let maxCost = cost(pts[k]);
      for (let j = k + 1; j < pts.length && j < k + 24; j++) {
        maxCost = Math.max(maxCost, cost(pts[j]));
        const c = center(pts[j]);
        if (!this.lineOk(ax, az, c.x, c.z, costs, maxCost)) break;
        best = j;
      }
      const c = center(pts[best]);
      out.push(c);
      ax = c.x;
      az = c.z;
      k = best + 1;
    }
    // spread the final stop inside its tile so workers don't stand on one spot
    if (out.length) {
      const last = out[out.length - 1];
      const h = ((e.id * 2654435761) >>> 0) / 4294967296, h2 = ((e.id * 40503 + pts.length * 977) >>> 0) % 1000 / 1000;
      last.x += (h - 0.5) * 0.7;
      last.z += (h2 - 0.5) * 0.7;
    }
    return out;
  }

  /** Supercover walk of the segment's tiles: all must be passable at no more than maxCost. */
  lineOk(x0: number, z0: number, x1: number, z1: number, costs: CostTable, maxCost: number): boolean {
    let ix = Math.floor(x0), iz = Math.floor(z0);
    const ex = Math.floor(x1), ez = Math.floor(z1);
    const dx = x1 - x0, dz = z1 - z0;
    const sx = Math.sign(dx), sz = Math.sign(dz);
    const tdx = sx ? Math.abs(1 / dx) : Infinity, tdz = sz ? Math.abs(1 / dz) : Infinity;
    let tx = sx ? (sx > 0 ? ix + 1 - x0 : x0 - ix) * tdx : Infinity;
    let tz = sz ? (sz > 0 ? iz + 1 - z0 : z0 - iz) * tdz : Infinity;
    for (let n = 0; n < 200; n++) {
      const c = costs.get(this.grid.get(ix, iz)) ?? Infinity;
      if (!Number.isFinite(c) || c > maxCost + 1e-6) return false;
      if (ix === ex && iz === ez) return true;
      if (Math.abs(tx - tz) < 1e-9) {
        // passing exactly through a corner: both side cells must be clear
        const a = costs.get(this.grid.get(ix + sx, iz)) ?? Infinity, b = costs.get(this.grid.get(ix, iz + sz)) ?? Infinity;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        ix += sx;
        iz += sz;
        tx += tdx;
        tz += tdz;
      } else if (tx < tz) {
        ix += sx;
        tx += tdx;
      } else {
        iz += sz;
        tz += tdz;
      }
    }
    return false;
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

  /** True while e is walking a path or waiting for one. */
  moving(e: Entity): boolean {
    return !!(e.path || e.want);
  }

  /** Straight-line step at speed (tiles/s), no pathing. */
  moveToward(e: Entity, x: number, z: number, speed: number) {
    const step = speed / 10;
    const dx = x - e.x, dz = z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    const k = Math.min(1, step / d);
    e.x = Math.min(SIZE - 0.01, Math.max(0, e.x + dx * k));
    e.z = Math.min(SIZE - 0.01, Math.max(0, e.z + dz * k));
    e.yaw = Math.atan2(dx, dz);
  }

  /** Advance e along its path at `speed` tiles/s (terrain cost slows it). */
  advancePath(e: Entity, speed: number) {
    const p = e.path;
    if (!p) return;
    const costs = this.costsFor(this.moveKey(e));
    const tileCost = costs.get(this.grid.get(Math.floor(e.x), Math.floor(e.z))) ?? 1;
    let budget = speed / 10 / Math.min(3, Math.max(0.6, isFinite(tileCost) ? tileCost : 1));
    const n = p.wp ? p.wp.length : p.pts.length;
    while (budget > 0 && p.i < n) {
      let tx: number, tz: number;
      if (p.wp) {
        tx = p.wp[p.i].x;
        tz = p.wp[p.i].z;
      } else {
        const ti = p.pts[p.i];
        tx = (ti % SIZE) + 0.5;
        tz = Math.floor(ti / SIZE) + 0.5;
      }
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
    if (p.i >= n) {
      e.path = null;
      for (const l of this.listeners) l.onArrive?.(e);
    }
  }

  dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  // ---------- clock ----------

  /** Move the clock forward, firing hour/dawn/dusk/midnight for each boundary crossed, in order. */
  advanceClock(ms: number, live = true) {
    let left = ms;
    while (left > 0) {
      const toHour = HOUR_MS - (((this.clockMs % HOUR_MS) + HOUR_MS) % HOUR_MS);
      if (left < toHour) {
        this.clockMs += left;
        break;
      }
      this.clockMs += toHour;
      left -= toHour;
      this.onHourBoundary(live);
    }
  }

  private onHourBoundary(live: boolean) {
    const h = Math.round(hourOf(this.clockMs)) % 24;
    if (h === 0) this.midnight();
    villageHour(this);
    if (live) for (const l of this.listeners) l.onHour?.();
    if (h === 6) {
      championDawn(this);
      if (live) for (const l of this.listeners) l.onDawn?.();
    }
    if (h === 18 && live) for (const l of this.listeners) l.onDusk?.();
    if (live) raidHour(this, h);
    this.checkGameOver();
  }

  private midnight() {
    const cd = calDay(this.clockMs);
    if (cd === this.lastJudgedCalDay) return; // never twice for one date (R2)
    this.lastJudgedCalDay = cd;
    this.nightIndex++;
    judgment(this);
    villageMidnight(this);
    monsterMidnight(this);
    for (const l of this.listeners) l.onMidnight?.();
  }

  // ---------- the tick ----------

  step() {
    if (this.gameOver) return;
    this.tick++;
    this.repathsThisTick = 0;
    this.advanceClock(this.msPerTick);
    this.light = this.computeLight();
    this.processRepaths();
    if (this.grid.groundChanged.size) {
      this.ground.update(this.grid.groundChanged);
      this.grid.groundChanged.clear();
    }
    processInputs(this);
    foodTick(this);

    for (const e of [...this.ents.values()]) {
      if (!this.ents.has(e.id)) continue;
      if (e.burnUntil !== undefined) stepBurning(this, e);
      if (!this.ents.has(e.id)) continue;
      switch (e.kind) {
        case 'human':
          if (e.id === this.championId) stepChampion(this, e);
          else if (!this.moduleBehavior(e)) stepHuman(this, e);
          break;
        case 'monster':
          if (!this.moduleBehavior(e)) stepMonster(this, e);
          break;
        case 'animal':
          stepAnimal(this, e);
          break;
        case 'corpse':
        case 'part':
          stepCorpse(this, e);
          break;
        case 'spear':
          stepSpear(this, e);
          break;
        default:
          if (e.owner && (e.path || e.want)) this.advancePath(e, this.stat(e, 'speed'));
      }
    }
    if (this.tick % 2 === 0) this.separate();
    if (this.tick % 5 === 0) updateVision(this);
    if (this.championPendingDawn) checkSuccession(this);
    if (this.alarmUntil > this.tick && this.tick % 50 === 0) {
      const V = this.layout.village;
      if (!this.monsters().some((m) => m.state !== 'downed' && m.state !== 'bound' && Math.hypot(m.x - V.x, m.z - V.z) < 22)) this.alarmUntil = 0;
    }
    for (const l of this.listeners) l.onTick?.();
    this.checkGameOver();
  }

  /** Push overlapping walkers apart (§5.7); the champion is an immovable obstacle here. */
  private separate() {
    const cells = new Map<number, Entity[]>();
    const list: Entity[] = [];
    for (const e of this.ents.values()) {
      if (!e.inhabitant || e.hidden || e.carriedBy !== undefined || LOCKED_STATES.has(e.state) || e.state === 'sleep' || (e.monster?.alt ?? 0) > 3) continue;
      list.push(e);
      const k = Math.floor(e.x / 2) * 1000 + Math.floor(e.z / 2);
      let c = cells.get(k);
      if (!c) cells.set(k, (c = []));
      c.push(e);
    }
    for (const a of list) {
      const cx = Math.floor(a.x / 2), cz = Math.floor(a.z / 2);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const c = cells.get((cx + dx) * 1000 + cz + dz);
        if (!c) continue;
        for (const b of c) {
          if (b.id <= a.id) continue;
          const ddx = b.x - a.x, ddz = b.z - a.z;
          const d = Math.hypot(ddx, ddz);
          const min = bodyR(a) + bodyR(b);
          if (d >= min || d < 1e-6) continue;
          const over = Math.min(0.1, min - d);
          const nx = ddx / d, nz = ddz / d;
          const aChamp = a.id === this.championId, bChamp = b.id === this.championId;
          const ka = aChamp ? 0 : bChamp ? 1 : 0.5, kb = bChamp ? 0 : aChamp ? 1 : 0.5;
          this.nudge(a, -nx * over * ka, -nz * over * ka);
          this.nudge(b, nx * over * kb, nz * over * kb);
        }
      }
    }
  }

  private nudge(e: Entity, dx: number, dz: number) {
    if (!dx && !dz) return;
    const nx = e.x + dx, nz = e.z + dz;
    if (this.walkableFor(e, nx, nz)) {
      e.x = nx;
      e.z = nz;
    }
  }

  /** Champion move costs for the client controller (F19): 0 blocked, else round(cost × 20). */
  champCost(): Uint8Array {
    const out = new Uint8Array(SIZE * SIZE);
    const c = this.champion();
    const costs = this.costsFor(c ? this.moveKey(c) : 'human');
    for (let i = 0; i < out.length; i++) {
      const v = costs.get(this.grid.types[i]) ?? Infinity;
      out[i] = Number.isFinite(v) ? Math.max(1, Math.min(255, Math.round(v * 20))) : 0;
    }
    if (c) {
      const i = Math.floor(c.z) * SIZE + Math.floor(c.x);
      if (!out[i]) out[i] = 20; // never trapped inside a new wall
    }
    return out;
  }

  /** Let a module behavior take over an inhabitant for this tick. */
  private moduleBehavior(e: Entity): boolean {
    if (!this.behaviors.length || LOCKED_STATES.has(e.state)) return false;
    let best: BehaviorEntry | null = null, bs = CORE_BASELINE;
    for (const b of this.behaviors) {
      if (!b.appliesTo(e)) continue;
      let s = b.score(e);
      s = Number.isFinite(s) ? Math.min(100, Math.max(0, s)) : 0;
      if (s > bs) {
        bs = s;
        best = b;
      }
    }
    if (!best) {
      if (e.state.startsWith('mod:')) {
        e.state = '';
        this.stop(e);
      }
      return false;
    }
    if (e.state !== `mod:${best.id}`) {
      this.stop(e);
      e.state = `mod:${best.id}`;
    }
    best.act(e);
    if (this.ents.has(e.id) && (e.path || e.want)) this.advancePath(e, this.stat(e, 'speed'));
    return true;
  }

  checkGameOver() {
    if (this.gameOver) return;
    let humans = 0, monsters = 0;
    for (const e of this.ents.values()) {
      if (e.kind === 'human' && e.id !== this.championId) humans++;
      else if (e.kind === 'monster') monsters++;
    }
    if (monsters === 0 || humans === 0) {
      this.gameOver = { winner: monsters === 0 ? 'human' : 'monster', day: this.day };
      const text = monsters === 0 ? 'The last monster is dead. The island belongs to the humans.' : 'The last of the village is gone. The island belongs to the monsters.';
      this.log(text, 3, 'core', 'gameover');
      this.alert({ kind: 'gameover', text });
    }
  }

  drainOut() {
    const o = this.out;
    this.out = { emitterOps: [], emotes: [], events: [], alerts: [], atmosphereDirty: false, sounds: [], toasts: [], hurt: 0 };
    return o;
  }
}

export const DAY = DAY_MS;
