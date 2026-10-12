// The feature mesh as something to collide with, stand on and climb (docs/climbing-phase2-plan.md, Part A): spires,
// arch legs and spans, overhangs. A triangle soup in meters, hashed per tile. Queries take positions in tiles and
// heights and distances in meters, like climb-surface.ts. Pure: the controller and the tests use it.
import { M } from '../sim/ground';
import { SIZE } from '../sim/world';

/** triangles reach this far (m) past their bounding box into the hash, so a point query reads only its own tile */
const PAD = 1.6;
/** steeper than 50° (or facing down): a wall for the body test */
export const WALL_NY = Math.cos((50 * Math.PI) / 180);
const SMOOTH = 1.5; // m: normals are blended over this radius

export class FeatureSurface {
  readonly count: number;
  /** per triangle: 9 floats (three vertices, meters) */
  readonly tri: Float32Array;
  /** per triangle: the unit normal */
  readonly nrm: Float32Array;
  private start = new Int32Array(SIZE * SIZE + 1);
  private list: Int32Array;
  private stamp: Uint32Array;
  private pass = 0;

  /** `pos`: non-indexed triangle positions in meters (x, y, z per vertex). */
  constructor(pos: ArrayLike<number>) {
    this.count = Math.floor(pos.length / 9);
    this.tri = Float32Array.from(pos as ArrayLike<number>).subarray(0, this.count * 9);
    this.nrm = new Float32Array(this.count * 3);
    this.stamp = new Uint32Array(this.count);
    const T = this.tri, cells = new Int32Array(SIZE * SIZE);
    const box = (t: number) => {
      const o = t * 9;
      const cl = (v: number) => Math.min(SIZE - 1, Math.max(0, Math.floor(v / M)));
      return [cl(Math.min(T[o], T[o + 3], T[o + 6]) - PAD), cl(Math.max(T[o], T[o + 3], T[o + 6]) + PAD), cl(Math.min(T[o + 2], T[o + 5], T[o + 8]) - PAD), cl(Math.max(T[o + 2], T[o + 5], T[o + 8]) + PAD)];
    };
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      const ax = T[o + 3] - T[o], ay = T[o + 4] - T[o + 1], az = T[o + 5] - T[o + 2];
      const bx = T[o + 6] - T[o], by = T[o + 7] - T[o + 1], bz = T[o + 8] - T[o + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      this.nrm.set([nx, ny, nz], t * 3);
      const [x0, x1, z0, z1] = box(t);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells[z * SIZE + x]++;
    }
    for (let i = 0; i < SIZE * SIZE; i++) this.start[i + 1] = this.start[i] + cells[i];
    this.list = new Int32Array(this.start[SIZE * SIZE]);
    const fill = this.start.slice(0, SIZE * SIZE);
    for (let t = 0; t < this.count; t++) {
      const [x0, x1, z0, z1] = box(t);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.list[fill[z * SIZE + x]++] = t;
    }
  }

  /** the triangles that may touch a point in tile (x, z) */
  private at(x: number, z: number): Int32Array {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= SIZE || iz >= SIZE) return this.list.subarray(0, 0);
    const i = iz * SIZE + ix;
    return this.list.subarray(this.start[i], this.start[i + 1]);
  }

  ny(t: number): number {
    return this.nrm[t * 3 + 1];
  }

  /** The highest upward-facing surface under (x, z) at or below yMax: its height and triangle, or null. */
  floor(x: number, z: number, yMax: number): { y: number; t: number } | null {
    const T = this.tri, N = this.nrm, px = x * M, pz = z * M;
    let best: { y: number; t: number } | null = null;
    for (const t of this.at(x, z)) {
      if (N[t * 3 + 1] <= 0.1) continue;
      const o = t * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
      const v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const y = u * T[o + 1] + v * T[o + 4] + (1 - u - v) * T[o + 7];
      if (y <= yMax && (!best || y > best.y)) best = { y, t };
    }
    return best;
  }

  /** A horizontal ray from (x, z) at height y along the unit (dx, dz): the nearest front face within maxM. */
  ray(x: number, z: number, y: number, dx: number, dz: number, maxM: number): { d: number; t: number } | null {
    const T = this.tri, N = this.nrm, ox = x * M, oz = z * M;
    const ex = x + (dx * maxM) / M, ez = z + (dz * maxM) / M;
    const pass = ++this.pass;
    let best: { d: number; t: number } | null = null;
    for (let iz = Math.floor(Math.min(z, ez)); iz <= Math.floor(Math.max(z, ez)); iz++) {
      for (let ix = Math.floor(Math.min(x, ex)); ix <= Math.floor(Math.max(x, ex)); ix++) {
        for (const t of this.at(ix, iz)) {
          if (this.stamp[t] === pass) continue;
          this.stamp[t] = pass;
          if (N[t * 3] * dx + N[t * 3 + 2] * dz >= 0) continue; // back face
          // Möller–Trumbore with the direction (dx, 0, dz)
          const o = t * 9;
          const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
          const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
          const px = -dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y; // D × e2
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-9) continue;
          const sx = ox - T[o], sy = y - T[o + 1], sz = oz - T[o + 2];
          const u = (sx * px + sy * py + sz * pz) / det;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dz * qz) / det;
          if (v < 0 || u + v > 1) continue;
          const d = (e2x * qx + e2y * qy + e2z * qz) / det;
          if (d >= 0 && d <= maxM && (!best || d < best.d)) best = { d, t };
        }
      }
    }
    return best;
  }

  /** squared distance (m²) from a point (m) to triangle t */
  private dist2(t: number, px: number, py: number, pz: number): number {
    const T = this.tri, o = t * 9;
    const [qx, qy, qz] = closest(px, py, pz, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
    return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  }

  /** The normal at a point (tiles, m) on triangle t, blended with its neighbors' over SMOOTH m. */
  normalAt(x: number, y: number, z: number, t: number): [number, number, number] {
    const N = this.nrm, px = x * M, pz = z * M;
    const tx = N[t * 3], ty = N[t * 3 + 1], tz = N[t * 3 + 2];
    let sx = 0, sy = 0, sz = 0;
    for (const u of this.at(x, z)) {
      const ux = N[u * 3], uy = N[u * 3 + 1], uz = N[u * 3 + 2];
      if (ux * tx + uy * ty + uz * tz <= 0) continue; // the far side of a thin feature
      const d = Math.sqrt(this.dist2(u, px, y, pz));
      if (d >= SMOOTH) continue;
      const w = SMOOTH - d;
      sx += ux * w; sy += uy * w; sz += uz * w;
    }
    const l = Math.hypot(sx, sy, sz);
    return l > 1e-6 ? [sx / l, sy / l, sz / l] : [tx, ty, tz];
  }

  /** The first wall-like triangle (steeper than 50°, or facing down) within r (m) of a point (tiles, m), or −1. */
  sphereHit(x: number, z: number, y: number, r: number): number {
    const N = this.nrm, px = x * M, pz = z * M, r2 = r * r;
    for (const t of this.at(x, z)) {
      if (N[t * 3 + 1] >= WALL_NY) continue;
      if (this.dist2(t, px, y, pz) < r2) return t;
    }
    return -1;
  }
}

/** The closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closest(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): [number, number, number] {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [ax + abx * v, ay + aby * v, az + abz * v];
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [ax + acx * w, ay + acy * w, az + acz * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w];
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}
