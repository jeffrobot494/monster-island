// Save format (§15). Schema 2: incompatible with the monster-island prototype.
import { Sim } from './sim';
import { SIZE } from './world';
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
  sim.grid.changed.clear();
  sim.ground.rebuild();
  sim.grid.groundChanged.clear();
  const S = (sim as any).champState;
  if (S) {
    S.combat = [];
    S.correction = null;
    S.poses = [];
    S.ambushed ??= [];
  }
  return sim;
}
