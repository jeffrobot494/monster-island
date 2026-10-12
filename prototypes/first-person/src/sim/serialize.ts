// Save format (§15). Schema 2: incompatible with the monster-island prototype.
import { Sim } from './sim';
import { SIZE } from './world';
import { ensureSpears } from './spears';
import { groundChampion } from './champion';
import { NV } from './ground';
import { BASE_QUANTUM } from './island-import';
import type { TerrainSettings } from './terrain-import';
import type { Atmosphere, CreationRecord, CreationRequest, Entity, Faction } from './types';

export const SCHEMA_VERSION = 3;

function rle<T>(arr: ArrayLike<T>): [T, number][] {
  const out: [T, number][] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1]++;
    else out.push([v, 1]);
  }
  return out;
}
/**
 * Terraformer ground heights, in steps of BASE_QUANTUM: each the difference from the previous one, zigzag varint,
 * base64 (most steps fit a byte; about a third of the raw Int16 size).
 */
function packBase(base: Float32Array): string {
  const bytes: number[] = [];
  let prev = 0;
  for (let i = 0; i < base.length; i++) {
    const q = Math.round(base[i] / BASE_QUANTUM), d = q - prev;
    prev = q;
    let z = d >= 0 ? d * 2 : -d * 2 - 1;
    while (z >= 0x80) {
      bytes.push((z & 0x7f) | 0x80);
      z = Math.floor(z / 0x80);
    }
    bytes.push(z);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(bin);
}
function unpackBase(s: string): Float32Array {
  const bin = atob(s);
  const out = new Float32Array(NV * NV);
  let p = 0, prev = 0;
  for (let i = 0; i < out.length; i++) {
    let z = 0, mul = 1, b: number;
    do {
      if (p >= bin.length) throw new Error('corrupt terrain heights');
      b = bin.charCodeAt(p++);
      z += (b & 0x7f) * mul;
      mul *= 0x80;
    } while (b & 0x80);
    prev += z % 2 ? -(z + 1) / 2 : z / 2;
    // the same float arithmetic as generation's quantizing, so a reloaded island's ground is identical
    out[i] = prev * BASE_QUANTUM;
  }
  if (p !== bin.length) throw new Error('corrupt terrain heights');
  return out;
}

function unrle<T>(runs: [T, number][], into: { length: number; [i: number]: T }) {
  let i = 0;
  for (const [v, n] of runs) for (let k = 0; k < n; k++) into[i++] = v;
  if (i !== into.length) throw new Error('corrupt run-length data');
}

export interface SavedCore {
  v: number;
  seed: number;
  tick: number;
  rng: number;
  nextId: number;
  clockMs: number;
  msPerTick: number;
  timescale: number;
  createdClock: number;
  lastRealMs: number;
  tiles: [string, number][];
  region: [number, number][];
  elev: [number, number][];
  explored: [number, number][];
  stock: [number, number][];
  layout: Sim['layout'];
  ents: Entity[];
  attached: [number, string[]][];
  atmosphere: Atmosphere;
  food: number;
  timber: number;
  fold: number;
  favor: Record<Faction, number>;
  prayer: string;
  alarmUntil: number;
  raidUntil?: number;
  pendingCreations: CreationRequest[];
  domainHistory: Sim['domainHistory'];
  nightIndex: number;
  lastJudgedCalDay: number;
  creations: CreationRecord[];
  missingSystems: string[];
  championId: number;
  championPendingDawn: boolean;
  champState: unknown;
  dragging: number;
  gameOver: Sim['gameOver'];
  stats: Sim['stats'];
  /** terraformer islands: the settings, the ground heights and each tile's height when the island was made */
  terrain?: { settings: TerrainSettings; base: string; orig: [number, number][] };
}

export function serializeCore(sim: Sim): SavedCore {
  const elev: [number, number][] = [];
  sim.grid.elev.forEach((v, i) => {
    if (v) elev.push([i, Math.round(v * 1000) / 1000]);
  });
  const stockQ = Array.from(sim.stock, (v) => Math.round(v * 50));
  return {
    v: SCHEMA_VERSION,
    seed: sim.seed,
    tick: sim.tick,
    rng: sim.rng.state,
    nextId: sim.nextId,
    clockMs: sim.clockMs,
    msPerTick: sim.msPerTick,
    timescale: sim.timescale,
    createdClock: sim.createdClock,
    lastRealMs: sim.lastRealMs,
    tiles: rle(sim.grid.types),
    region: rle(sim.grid.region),
    elev,
    explored: rle(sim.explored),
    stock: rle(stockQ),
    layout: sim.layout,
    ents: [...sim.ents.values()].map((e) => structuredClone(e)),
    attached: [...sim.attached].map(([id, s]) => [id, [...s]]),
    atmosphere: { ...sim.atmosphere },
    food: sim.food,
    timber: sim.timber,
    fold: sim.fold,
    favor: { ...sim.favor },
    prayer: sim.prayer,
    alarmUntil: sim.alarmUntil,
    raidUntil: sim.raidUntil,
    pendingCreations: structuredClone(sim.pendingCreations),
    domainHistory: structuredClone(sim.domainHistory),
    nightIndex: sim.nightIndex,
    lastJudgedCalDay: sim.lastJudgedCalDay,
    creations: structuredClone(sim.creations),
    missingSystems: [...sim.missingSystems],
    championId: sim.championId,
    championPendingDawn: sim.championPendingDawn,
    champState: structuredClone((sim as any).champState ?? null),
    dragging: sim.dragging,
    gameOver: sim.gameOver ? { ...sim.gameOver } : null,
    stats: { ...sim.stats },
    terrain: sim.terrain && sim.grid.base && sim.grid.orig
      ? { settings: { ...sim.terrain }, base: packBase(sim.grid.base), orig: rle(Array.from(sim.grid.orig, (v) => Math.round(v * 1000) / 1000)) }
      : undefined,
  };
}

export function deserializeCore(s: SavedCore): Sim {
  if (s.v !== SCHEMA_VERSION) throw new Error(`unsupported save schema ${s.v}`);
  const sim = new Sim(s.seed);
  sim.tick = s.tick;
  sim.rng.state = s.rng >>> 0;
  sim.nextId = s.nextId;
  sim.clockMs = s.clockMs;
  sim.msPerTick = s.msPerTick;
  sim.timescale = s.timescale;
  sim.createdClock = s.createdClock;
  sim.lastRealMs = s.lastRealMs ?? 0;
  unrle(s.tiles, sim.grid.types);
  unrle(s.region, sim.grid.region);
  for (const [j, v] of s.elev) sim.grid.elev[j] = v;
  unrle(s.explored, sim.explored);
  const q = new Array<number>(SIZE * SIZE);
  unrle(s.stock, q);
  for (let i = 0; i < q.length; i++) sim.stock[i] = q[i] / 50;
  sim.layout = s.layout;
  for (const e of s.ents) sim.ents.set(e.id, structuredClone(e));
  for (const [id, list] of s.attached) sim.attached.set(id, new Set(list));
  sim.atmosphere = { ...s.atmosphere };
  sim.food = s.food;
  sim.timber = s.timber;
  sim.fold = s.fold;
  sim.favor = { ...s.favor };
  sim.prayer = s.prayer;
  sim.alarmUntil = s.alarmUntil;
  sim.raidUntil = s.raidUntil ?? 0;
  sim.pendingCreations = structuredClone(s.pendingCreations);
  sim.domainHistory = structuredClone(s.domainHistory);
  sim.nightIndex = s.nightIndex;
  sim.lastJudgedCalDay = s.lastJudgedCalDay;
  sim.creations = structuredClone(s.creations);
  sim.missingSystems = [...s.missingSystems];
  sim.championId = s.championId;
  sim.championPendingDawn = s.championPendingDawn;
  if (s.champState) (sim as any).champState = structuredClone(s.champState);
  sim.dragging = s.dragging;
  sim.gameOver = s.gameOver ? { ...s.gameOver } : null;
  sim.stats = { ...s.stats };
  sim.light = sim.computeLight();
  if (s.terrain) {
    sim.terrain = { ...s.terrain.settings };
    sim.grid.base = unpackBase(s.terrain.base);
    sim.grid.orig = new Float32Array(SIZE * SIZE);
    unrle(s.terrain.orig, sim.grid.orig);
  }
  sim.grid.changed.clear();
  sim.ground.rebuild();
  sim.grid.groundChanged.clear();
  ensureSpears(sim);
  // a champion saved up a cliff starts on the ground nearby (the client snaps to it)
  const champ = sim.champion();
  if (champ) groundChampion(sim, champ);
  const S = (sim as any).champState;
  if (S) {
    S.combat = [];
    S.correction = null;
    S.poses = [];
    S.ambushed ??= [];
  }
  return sim;
}
