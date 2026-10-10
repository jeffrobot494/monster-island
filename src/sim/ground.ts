// The shared ground height function (spec §2). The sim, the champion controller and the terrain mesh all use it, so
// feet, eyes and the terrain mesh agree. Positions in tiles, heights in meters.
import { SIZE, type TileGrid } from './world';

export const M = 8; // meters per tile
export const WATER_Y = -1.0;
const DETAIL = 0.35;
const STRUCT = new Set(['wall', 'house']);

function hash2(x: number, z: number): number {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function detail(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz - 0.5) * 2 * DETAIL;
}

export class Ground {
  /** smoothed height at each tile center (m) */
  h = new Float32Array(SIZE * SIZE);
  /** raw (unsmoothed) height at each tile center */
  private raw = new Float32Array(SIZE * SIZE);
  version = 0;

  constructor(private grid: TileGrid) {
    this.rebuild();
  }

  private rawAt(x: number, z: number): number {
    const g = this.grid;
    const t = g.get(x, z);
    if (STRUCT.has(t)) {
      // structures sit flush on the surrounding ground
      let lo = Infinity;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = g.get(x + dx, z + dz);
        if (STRUCT.has(n)) continue;
        lo = Math.min(lo, g.height(x + dx, z + dz));
      }
      return (Number.isFinite(lo) ? lo : 0.2) * M;
    }
    return g.height(x, z) * M;
  }

  rebuild() {
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) this.raw[z * SIZE + x] = this.rawAt(x, z);
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) this.smooth(x, z);
    this.version++;
  }

  /** Re-derive heights around changed tiles (indices). */
  update(indices: Iterable<number>) {
    const touched = new Set<number>();
    for (const i of indices) {
      const x = i % SIZE, z = Math.floor(i / SIZE);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;
        this.raw[nz * SIZE + nx] = this.rawAt(nx, nz);
      }
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;
        touched.add(nz * SIZE + nx);
      }
    }
    for (const i of touched) this.smooth(i % SIZE, Math.floor(i / SIZE));
    this.version++;
  }

  private smooth(x: number, z: number) {
    // 3×3 [1 2 1] blur, so cliffs between tiles become slopes instead of steps
    let s = 0, w = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = Math.min(SIZE - 1, Math.max(0, x + dx)), nz = Math.min(SIZE - 1, Math.max(0, z + dz));
      const k = (dx === 0 ? 2 : 1) * (dz === 0 ? 2 : 1);
      s += this.raw[nz * SIZE + nx] * k;
      w += k;
    }
    this.h[z * SIZE + x] = s / w;
  }

  /** Ground height (m) at a point in tile units. */
  y(x: number, z: number): number {
    const gx = Math.min(SIZE - 1.001, Math.max(0, x - 0.5));
    const gz = Math.min(SIZE - 1.001, Math.max(0, z - 0.5));
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const i = iz * SIZE + ix;
    const a = this.h[i], b = this.h[i + 1], c = this.h[i + SIZE], d = this.h[i + SIZE + 1];
    const base = a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    return base + detail(x * 1.7, z * 1.7);
  }
}
