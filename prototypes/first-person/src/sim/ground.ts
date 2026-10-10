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

export const RES = 2; // mesh vertices per tile (a vertex every 4 m)
export const NV = SIZE * RES + 1;

export class Ground {
  /** smoothed height at each tile center (m) */
  h = new Float32Array(SIZE * SIZE);
  /** height at each mesh vertex (m); the terrain mesh uses these exactly (F26) */
  v = new Float32Array(NV * NV);
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
    for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) this.vert(i, j);
    this.version++;
  }

  /** Re-derive heights around changed tiles (indices). Returns the touched vertex box. */
  update(indices: Iterable<number>): [number, number, number, number] {
    let x0 = SIZE, x1 = 0, z0 = SIZE, z1 = 0;
    for (const i of indices) {
      const x = i % SIZE, z = Math.floor(i / SIZE);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    if (x0 > x1) return [0, -1, 0, -1];
    const cl = (v: number) => Math.min(SIZE - 1, Math.max(0, v));
    for (let z = cl(z0 - 1); z <= cl(z1 + 1); z++) for (let x = cl(x0 - 1); x <= cl(x1 + 1); x++) this.raw[z * SIZE + x] = this.rawAt(x, z);
    for (let z = cl(z0 - 2); z <= cl(z1 + 2); z++) for (let x = cl(x0 - 2); x <= cl(x1 + 2); x++) this.smooth(x, z);
    const vi0 = Math.max(0, (x0 - 3) * RES), vi1 = Math.min(NV - 1, (x1 + 4) * RES);
    const vj0 = Math.max(0, (z0 - 3) * RES), vj1 = Math.min(NV - 1, (z1 + 4) * RES);
    for (let j = vj0; j <= vj1; j++) for (let i = vi0; i <= vi1; i++) this.vert(i, j);
    this.version++;
    return [vi0, vi1, vj0, vj1];
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

  /** bilinear height of the smoothed tile-center field */
  private field(x: number, z: number): number {
    const gx = Math.min(SIZE - 1.001, Math.max(0, x - 0.5));
    const gz = Math.min(SIZE - 1.001, Math.max(0, z - 0.5));
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const i = iz * SIZE + ix;
    const a = this.h[i], b = this.h[i + 1], c = this.h[i + SIZE], d = this.h[i + SIZE + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  private vert(i: number, j: number) {
    const x = i / RES, z = j / RES;
    this.v[j * NV + i] = this.field(x, z) + detail(x * 1.7, z * 1.7);
  }

  /** Ground height (m) at a point in tile units: exactly the mesh triangle under it. */
  y(x: number, z: number): number {
    const gx = Math.min(NV - 1.0001, Math.max(0, x * RES));
    const gz = Math.min(NV - 1.0001, Math.max(0, z * RES));
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const o = j * NV + i;
    const a = this.v[o], b = this.v[o + 1], c = this.v[o + NV], d = this.v[o + NV + 1];
    if ((i + j) & 1) {
      // diagonal b–c
      return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
    }
    // diagonal a–d
    return fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (c - a) * fz + (d - c) * fx;
  }

  /** Terrain normal (unnormalized y-up slope vector) for tilting bodies on the ground. */
  slope(x: number, z: number): [number, number] {
    const e = 0.06;
    return [(this.y(x + e, z) - this.y(x - e, z)) / (2 * e * M), (this.y(x, z + e) - this.y(x, z - e)) / (2 * e * M)];
  }
}
