// Island generation on terraformer terrain (generateIsland with `terrain`): the ground heights come from the
// terraformer; this picks the village and High Place sites, flattens them, cuts graded roads (ramps up cliffs,
// fords and causeways over water) and marks unwalkable ground as 'cliff'. Edits go to `base` (m, per Ground vertex).
import { NV, RES, WATER_Y } from './ground';
import { SIZE, type TileGrid } from './world';
import { createField, sampleBase, solidMask, type TerrainSettings } from './terrain-import';

interface P {
  x: number;
  z: number;
}

/** steepest walkable rise between neighboring vertices (4 m apart): 45° */
const MAX_RISE = 4;
/** rise per tile a graded road keeps to (~24°) */
const ROAD_RISE = 3.5;
/** where the sea floor is raised for fords, piers and filled land */
const FILL_Y = WATER_Y + 0.4;
/** heights are stored in saves at this resolution (m), so a reloaded island is identical */
export const BASE_QUANTUM = 0.02;

const STRUCTURE = new Set(['wall', 'house', 'gate']);
/** tiles the final cliff pass leaves alone: structures and what generation laid on purpose */
const KEEP = new Set(['wall', 'house', 'gate', 'road', 'shrine-floor']);
const isWater = (t: string) => t === 'deep-water' || t === 'shallow-water';

export class ImportedTerrain {
  readonly base: Float32Array;
  /** rock stands 1–2.5 m above the ground here (spires, arch legs): never walkable, never built on */
  readonly solid: Uint8Array;
  /** tiles on a laid road: kept walkable by markCliffs, whatever grading did to their slopes */
  private laid = new Uint8Array(SIZE * SIZE);

  constructor(readonly settings: TerrainSettings) {
    const f = createField(settings);
    this.base = sampleBase(settings, f);
    this.solid = solidMask(settings, f);
  }

  /** base height (m) at a point (tiles), bilinear between vertices */
  at(x: number, z: number): number {
    const gx = Math.min(NV - 1.001, Math.max(0, x * RES)), gz = Math.min(NV - 1.001, Math.max(0, z * RES));
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const b = this.base, o = j * NV + i;
    return (b[o] * (1 - fx) + b[o + 1] * fx) * (1 - fz) + (b[o + NV] * (1 - fx) + b[o + NV + 1] * fx) * fz;
  }

  /** height (m) at a tile's center */
  h(x: number, z: number): number {
    return this.base[(z * RES + 1) * NV + x * RES + 1];
  }

  /** the steepest rise (m) between neighboring vertices of a tile */
  rise(x: number, z: number): number {
    const b = this.base;
    let m = 0;
    for (let dj = 0; dj <= RES; dj++) for (let di = 0; di <= RES; di++) {
      const o = (z * RES + dj) * NV + x * RES + di;
      if (di < RES) m = Math.max(m, Math.abs(b[o] - b[o + 1]));
      if (dj < RES) m = Math.max(m, Math.abs(b[o] - b[o + NV]));
    }
    return m;
  }

  /** Set every vertex within r tiles of (cx, cz) to y, blending back to the terrain over `blend` more tiles. */
  flatten(cx: number, cz: number, r: number, blend: number, y: number) {
    const R = r + blend;
    for (let j = Math.max(0, Math.floor((cz - R) * RES)); j <= Math.min(NV - 1, Math.ceil((cz + R) * RES)); j++) {
      for (let i = Math.max(0, Math.floor((cx - R) * RES)); i <= Math.min(NV - 1, Math.ceil((cx + R) * RES)); i++) {
        const d = Math.hypot(i / RES - cx, j / RES - cz);
        if (d > R) continue;
        const t = d <= r ? 1 : 1 - (d - r) / blend;
        const k = t * t * (3 - 2 * t);
        this.base[j * NV + i] += (y - this.base[j * NV + i]) * k;
      }
    }
  }

  /** heights of the land tiles within r of (cx, cz), and how many tiles there are water or rock */
  private disk(cx: number, cz: number, r: number) {
    const hs: number[] = [];
    let bad = 0, n = 0;
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || z < 0 || x >= SIZE || z >= SIZE || Math.hypot(x - cx, z - cz) > r) continue;
      n++;
      const h = this.h(x, z);
      if (h < WATER_Y + 0.5 || this.solid[z * SIZE + x]) bad++;
      else hs.push(h);
    }
    hs.sort((a, b) => a - b);
    const med = hs.length ? hs[hs.length >> 1] : WATER_Y + 2;
    let dev = 0;
    for (const h of hs) dev += Math.abs(h - med);
    return { med, dev: hs.length ? dev / hs.length : Infinity, bad: n ? bad / n : 1 };
  }

  /**
   * The village: the most level, most solid 11-tile disk near the procedural site (`want`), flattened. The wall ring
   * (radius 9) and fields (to 15) must fit inside the map with room for the harbor road.
   */
  placeVillage(want: P): P {
    let best = want, bs = Infinity;
    for (let z = 18; z <= SIZE - 19; z += 2) for (let x = 18; x <= SIZE - 19; x += 2) {
      const dw = Math.hypot(x - want.x, z - want.z), dc = Math.hypot(x - SIZE / 2, z - SIZE / 2);
      if (dw > 26 || dc < 30) continue;
      const d = this.disk(x, z, 11);
      const s = d.dev + d.bad * 40 + dw * 0.08;
      if (s < bs) { bs = s; best = { x, z }; }
    }
    const d = this.disk(best.x, best.z, 11);
    this.flatten(best.x, best.z, 11, 5, Math.max(d.med, WATER_Y + 2));
    return best;
  }

  /**
   * The High Place: a high, level, solid spot within 30 tiles of the center and at least 30 from the village, no more
   * than 70 m above it (a road has to climb there), flattened into a plaza.
   */
  placeHighPlace(village: P): P {
    const vy = this.h(village.x, village.z);
    const C = SIZE / 2;
    let best: P = { x: C, z: C }, bs = -Infinity;
    for (let z = C - 30; z <= C + 30; z++) for (let x = C - 30; x <= C + 30; x++) {
      if (Math.hypot(x - C, z - C) > 30 || Math.hypot(x - village.x, z - village.z) < 30) continue;
      const d = this.disk(x, z, 3);
      if (d.bad > 0) continue;
      const s = Math.min(d.med, vy + 70) - d.dev * 6 - Math.hypot(x - C, z - C) * 0.3;
      if (s > bs) { bs = s; best = { x, z }; }
    }
    this.flatten(best.x, best.z, 4, 4, this.disk(best.x, best.z, 3).med);
    return best;
  }

  /** Ground too steep to walk, or under standing rock, becomes 'cliff' (walkable land types only, never `keep`). */
  markCliffs(grid: TileGrid, keep: Set<string> = KEEP) {
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x, t = grid.types[i];
      if (keep.has(t) || this.laid[i] || !grid.def(t).walkable) continue;
      if (this.solid[i] || this.rise(x, z) > MAX_RISE) grid.types[i] = 'cliff';
    }
  }

  /**
   * The cheapest 4-connected tile path from any tile in `from` to any tile in `to` (A* when `to` is one tile).
   * Cliffs and water can be crossed at a price; walls, houses, standing rock and the map's 2-tile rim cannot.
   */
  path(grid: TileGrid, from: number[], to: Set<number>): number[] | null {
    const N = SIZE * SIZE;
    // Float64: float32 costs round, so an equal path looks shorter and re-queues forever
    const g = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const target = to.size === 1 ? [...to][0] : -1;
    const hx = target % SIZE, hz = (target / SIZE) | 0;
    const heur = (i: number) => (target < 0 ? 0 : (Math.abs((i % SIZE) - hx) + Math.abs(((i / SIZE) | 0) - hz)) * 0.8);
    const heap = new Heap();
    for (const i of from) {
      g[i] = 0;
      heap.push(i, heur(i));
    }
    while (heap.size) {
      const i = heap.pop();
      if (done[i]) continue;
      done[i] = 1;
      if (to.has(i)) {
        const out: number[] = [];
        for (let k = i; k >= 0; k = prev[k]) out.push(k);
        return out.reverse();
      }
      const x = i % SIZE, z = (i / SIZE) | 0, hi = this.h(x, z);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 2 || nz < 2 || nx >= SIZE - 2 || nz >= SIZE - 2) continue;
        const j = nz * SIZE + nx, t = grid.types[j];
        if (t === 'wall' || t === 'house' || this.solid[j]) continue;
        const d = grid.def(t);
        // deep water dear enough that a road fords canyon channels but doesn't go round the coast
        let c = d.walkable ? Math.min(3, d.moveCost) : isWater(t) ? (t === 'deep-water' ? 25 : 6) : 4;
        c += 3 * Math.max(0, Math.abs(Math.max(FILL_Y, this.h(nx, nz)) - Math.max(FILL_Y, hi)) - ROAD_RISE);
        const ng = g[i] + c;
        if (ng >= g[j]) continue;
        g[j] = ng;
        prev[j] = i;
        heap.push(j, ng + heur(j));
      }
    }
    return null;
  }

  /**
   * Lay a road along a tile path: `all` makes every tile road (village streets), otherwise only the tiles a walker
   * couldn't cross. Then grade it: tile-center heights kept within ROAD_RISE of each other (ends fixed), never
   * below FILL_Y, written to each tile's vertices (an edge shared with the next road tile takes the midpoint).
   */
  road(grid: TileGrid, path: number[], all: boolean, region: number) {
    const n = path.length;
    if (!n) return;
    const p = path.map((i) => Math.max(FILL_Y, this.h(i % SIZE, (i / SIZE) | 0)));
    for (let k = 1; k < n - 1; k++) p[k] = Math.min(p[k - 1] + ROAD_RISE, Math.max(p[k - 1] - ROAD_RISE, p[k]));
    for (let k = n - 2; k >= 1; k--) p[k] = Math.min(p[k + 1] + ROAD_RISE, Math.max(p[k + 1] - ROAD_RISE, p[k]));
    for (let k = 0; k < n; k++) {
      const i = path[k], x = i % SIZE, z = (i / SIZE) | 0, t = grid.types[i];
      const crossing = !grid.def(t).walkable;
      if (STRUCTURE.has(t)) continue;
      if (all || crossing) grid.types[i] = 'road';
      this.laid[i] = 1;
      if (grid.region[i] === 255) grid.region[i] = region;
      if (!crossing && Math.abs(p[k] - this.h(x, z)) < 0.5 && this.rise(x, z) <= MAX_RISE) continue; // already fine
      for (let dj = 0; dj <= RES; dj++) for (let di = 0; di <= RES; di++) {
        let y = p[k];
        for (const nk of [k - 1, k + 1]) {
          if (nk < 0 || nk >= n) continue;
          const nx = path[nk] % SIZE, nz = (path[nk] / SIZE) | 0;
          // the vertex row/column this tile shares with that neighbor
          if ((nx > x && di === RES) || (nx < x && di === 0) || (nz > z && dj === RES) || (nz < z && dj === 0)) y = (p[k] + p[nk]) / 2;
        }
        this.base[(z * RES + dj) * NV + x * RES + di] = y;
      }
    }
  }

  /** A graded road from a to b; true if one was found. */
  connect(grid: TileGrid, a: P, b: P, all: boolean): boolean {
    const path = this.path(grid, [a.z * SIZE + a.x], new Set([b.z * SIZE + b.x]));
    if (path) this.road(grid, path, all, grid.region[a.z * SIZE + a.x]);
    return !!path;
  }

  /** walkable tiles reachable from `start` */
  reach(grid: TileGrid, start: P): Uint8Array {
    const seen = new Uint8Array(SIZE * SIZE);
    const q = [start.z * SIZE + start.x];
    seen[q[0]] = 1;
    while (q.length) {
      const i = q.pop()!, x = i % SIZE, z = (i / SIZE) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;
        const j = nz * SIZE + nx;
        if (seen[j] || !grid.def(grid.types[j]).walkable) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    return seen;
  }

  /**
   * Join every walkable area of at least `min` tiles to the one around `start` with a graded road; smaller ones
   * become cliff. Roads change slopes beside them, so cliffs are re-marked and this repeats until nothing changes.
   */
  connectAll(grid: TileGrid, start: P, min = 30) {
    for (let pass = 0; pass < 4; pass++) {
      this.markCliffs(grid);
      let joined = false;
      for (;;) {
        const seen = this.reach(grid, start);
        const reached = new Set<number>();
        for (let i = 0; i < seen.length; i++) if (seen[i]) reached.add(i);
        // the largest unreached area first
        let biggest: number[] = [];
        const comp = new Uint8Array(SIZE * SIZE);
        for (let s = 0; s < seen.length; s++) {
          if (seen[s] || comp[s] || !grid.def(grid.types[s]).walkable) continue;
          const tiles = [s], q = [s];
          comp[s] = 1;
          while (q.length) {
            const i = q.pop()!, x = i % SIZE, z = (i / SIZE) | 0;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, nz = z + dz;
              if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;
              const j = nz * SIZE + nx;
              if (comp[j] || seen[j] || !grid.def(grid.types[j]).walkable) continue;
              comp[j] = 1;
              tiles.push(j);
              q.push(j);
            }
          }
          if (tiles.length > biggest.length) biggest = tiles;
        }
        if (biggest.length < min) break;
        const path = this.path(grid, biggest, reached);
        if (!path) {
          for (const i of biggest) grid.types[i] = 'cliff';
          continue;
        }
        this.road(grid, path, false, grid.region[path[0]]);
        joined = true;
      }
      if (!joined && pass > 0) break;
    }
    // what is still cut off (small ledges, places no road reaches) can't be walked to: rock
    this.markCliffs(grid);
    const seen = this.reach(grid, start);
    for (let i = 0; i < seen.length; i++) if (!seen[i] && grid.def(grid.types[i]).walkable) grid.types[i] = 'cliff';
  }

  /**
   * Last step: walkable tiles below the sea (piers, fords, filled land) are raised to just above it, heights are
   * quantized as saves store them, and the grid takes them.
   */
  finish(grid: TileGrid) {
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
      const t = grid.types[z * SIZE + x];
      if (!grid.def(t).walkable && !STRUCTURE.has(t)) continue;
      for (let dj = 0; dj <= RES; dj++) for (let di = 0; di <= RES; di++) {
        const o = (z * RES + dj) * NV + x * RES + di;
        if (this.base[o] < FILL_Y) this.base[o] = FILL_Y;
      }
    }
    for (let i = 0; i < this.base.length; i++) this.base[i] = Math.round(this.base[i] / BASE_QUANTUM) * BASE_QUANTUM;
    grid.base = this.base;
    grid.orig = new Float32Array(SIZE * SIZE);
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) grid.orig[z * SIZE + x] = grid.height(x, z);
  }
}

/** binary min-heap of tile indices by priority */
class Heap {
  private ids: number[] = [];
  private pri: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, p: number) {
    const ids = this.ids, pri = this.pri;
    let k = ids.length;
    ids.push(id);
    pri.push(p);
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (pri[up] <= p) break;
      ids[k] = ids[up];
      pri[k] = pri[up];
      k = up;
    }
    ids[k] = id;
    pri[k] = p;
  }
  pop(): number {
    const ids = this.ids, pri = this.pri;
    const top = ids[0], lastId = ids.pop()!, lastP = pri.pop()!;
    const n = ids.length;
    if (n) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && pri[c + 1] < pri[c]) c++;
        if (pri[c] >= lastP) break;
        ids[k] = ids[c];
        pri[k] = pri[c];
        k = c;
      }
      ids[k] = lastId;
      pri[k] = lastP;
    }
    return top;
  }
}
