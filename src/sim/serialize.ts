import { Sim, type DayStats } from './sim';
import { SIZE } from './world';
import type { Atmosphere, Entity } from './types';

export const SCHEMA_VERSION = 1;

export interface SavedCore {
  v: number;
  seed: number;
  tick: number;
  rng: number;
  nextId: number;
  tiles: [string, number][]; // RLE
  elev: [number, number][]; // sparse [index, elevation]
  layout: Sim['layout'];
  ents: Entity[];
  attached: [number, string[]][];
  atmosphere: Atmosphere;
  dayStats: DayStats;
  history: DayStats[];
  repathQueue: number[];
}

export function serializeCore(sim: Sim): SavedCore {
  const tiles: [string, number][] = [];
  for (const t of sim.grid.types) {
    const last = tiles[tiles.length - 1];
    if (last && last[0] === t) last[1]++;
    else tiles.push([t, 1]);
  }
  const elev: [number, number][] = [];
  sim.grid.elev.forEach((v, i) => {
    if (v) elev.push([i, Math.round(v * 1000) / 1000]);
  });
  return {
    v: SCHEMA_VERSION,
    seed: sim.seed,
    tick: sim.tick,
    rng: sim.rng.state,
    nextId: sim.nextId,
    tiles,
    elev,
    layout: sim.layout,
    ents: [...sim.ents.values()].map((e) => structuredClone(e)),
    attached: [...sim.attached].map(([id, s]) => [id, [...s]]),
    atmosphere: { ...sim.atmosphere },
    dayStats: structuredClone(sim.dayStats),
    history: structuredClone(sim.history),
    repathQueue: [...sim.repathQueue],
  };
}

export function deserializeCore(s: SavedCore): Sim {
  if (s.v !== SCHEMA_VERSION) throw new Error(`unsupported save schema ${s.v}`);
  const sim = new Sim(s.seed);
  sim.tick = s.tick;
  sim.rng.state = s.rng >>> 0;
  sim.nextId = s.nextId;
  let i = 0;
  for (const [t, n] of s.tiles) for (let k = 0; k < n; k++) sim.grid.types[i++] = t;
  if (i !== SIZE * SIZE) throw new Error('corrupt tile data');
  for (const [j, v] of s.elev) sim.grid.elev[j] = v;
  sim.layout = s.layout;
  for (const e of s.ents) sim.ents.set(e.id, structuredClone(e));
  for (const [id, list] of s.attached) sim.attached.set(id, new Set(list));
  sim.atmosphere = { ...s.atmosphere };
  sim.dayStats = structuredClone(s.dayStats);
  sim.history = structuredClone(s.history);
  sim.repathQueue = [...s.repathQueue];
  sim.grid.changed.clear();
  return sim;
}
