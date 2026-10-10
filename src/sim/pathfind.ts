import { SIZE, type TileGrid } from './world';

/** tile type id → move cost (Infinity = blocked), for one entity kind */
export type CostTable = Map<string, number>;

class Heap {
  idx: number[] = [];
  pri: number[] = [];
  push(i: number, p: number) {
    const a = this.idx, b = this.pri;
    let n = a.length;
    a.push(i);
    b.push(p);
    while (n > 0) {
      const parent = (n - 1) >> 1;
      if (b[parent] <= b[n]) break;
      [a[parent], a[n]] = [a[n], a[parent]];
      [b[parent], b[n]] = [b[n], b[parent]];
      n = parent;
    }
  }
  pop(): number {
    const a = this.idx, b = this.pri;
    const top = a[0];
    const li = a.pop()!, lp = b.pop()!;
    if (a.length) {
      a[0] = li;
      b[0] = lp;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1;
        let m = n;
        if (l < a.length && b[l] < b[m]) m = l;
        if (r < a.length && b[r] < b[m]) m = r;
        if (m === n) break;
        [a[m], a[n]] = [a[n], a[m]];
        [b[m], b[n]] = [b[n], b[m]];
        n = m;
      }
    }
    return top;
  }
  get size() {
    return this.idx.length;
  }
}

const g = new Float64Array(SIZE * SIZE);
const from = new Int32Array(SIZE * SIZE);
const seen = new Uint32Array(SIZE * SIZE);
let stamp = 0;

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * A* on the tile grid. Returns tile indices from start (exclusive) to goal (inclusive),
 * [] if already there, or null if unreachable. The start tile is allowed to be unwalkable
 * (so stranded entities can walk out).
 */
export function findPath(grid: TileGrid, costs: CostTable, sx: number, sz: number, gx: number, gz: number, maxNodes = 4096): number[] | null {
  if (!grid.inBounds(gx, gz)) return null;
  const cost = (i: number) => costs.get(grid.types[i]) ?? Infinity;
  const goal = gz * SIZE + gx;
  const start = sz * SIZE + sx;
  if (start === goal) return [];
  if (!isFinite(cost(goal))) return null;
  stamp = (stamp + 1) >>> 0;
  if (stamp === 0) {
    seen.fill(0);
    stamp = 1;
  }
  const open = new Heap();
  g[start] = 0;
  from[start] = -1;
  seen[start] = stamp;
  open.push(start, 0);
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) break;
    if (++expanded > maxNodes) return null;
    const cx = cur % SIZE, cz = (cur / SIZE) | 0;
    for (const [dx, dz, step] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;
      const ni = nz * SIZE + nx;
      const c = cost(ni);
      if (!isFinite(c)) continue;
      if (dx && dz && (!isFinite(cost(cz * SIZE + nx)) || !isFinite(cost(nz * SIZE + cx)))) continue;
      const ng = g[cur] + step * c;
      if (seen[ni] === stamp && ng >= g[ni]) continue;
      seen[ni] = stamp;
      g[ni] = ng;
      from[ni] = cur;
      const h = Math.hypot(nx - gx, nz - gz);
      open.push(ni, ng + h);
    }
  }
  if (seen[goal] !== stamp) return null;
  const out: number[] = [];
  for (let i = goal; i !== start; i = from[i]) out.push(i);
  return out.reverse();
}
