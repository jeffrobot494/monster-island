// The arena's shape (src/arena/README.md), pure and seeded: the bowl's ground heights, and the rock that stands on it
// (pillars, a plateau with a ramp, arches, towers with overhangs, walls, hop blocks). The sim uses it for heights and
// for which tiles are blocked; the client builds the rock mesh and the climbing surface from the same triangles.
// Positions in tiles, sizes and heights in meters, like the rest of the game.
//
// Everything standing on the floor is aligned to the 8 m tile grid, and the bowl's wall rises from the edge of the
// last floor tile: the sim blocks whole tiles and won't let the champion stand at ground level on a blocked one,
// so a rock face inside a tile would stop the champion meters short of it, unable to start a climb.
import { Rng, hashSeed } from '../sim/rng';
import { M, NV, RES } from '../sim/ground';
import { SIZE } from '../sim/world';

export type Density = 'none' | 'some' | 'lots';

/** What shapes the arena; changing any of it rebuilds the arena. */
export interface ArenaShape {
  /** floor radius (tiles; 8 m each) */
  radius: number;
  /** the bowl's wall (m above the floor) */
  wallH: number;
  density: Density;
  /** layout seed: which obstacles go where */
  seed: number;
}

export const DEFAULT_SHAPE: ArenaShape = { radius: 22, wallH: 60, density: 'some', seed: 1 };

export const C = SIZE / 2;
/** the floor (m) */
export const FLOOR_Y = 2;
/** a ramp's foot stands this high (m): the sim takes feet above 0.3 m on a blocked tile as up on the rock, and a
 *  step up to 0.5 m is still a walk */
const RAMP_FOOT = 0.45;

/**
 * A convex block of rock: a footprint polygon (meters) at y0, and the same polygon (or a tapered one, `top`) at the
 * top, each top vertex at its own height (`ty`; a flat top has them all equal, a ramp doesn't).
 */
export interface Prism {
  pts: [number, number][];
  y0: number;
  top: [number, number][];
  ty: number[];
  color: string;
}

interface Hill {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** A tile rectangle: x0..x1 × z0..z1, inclusive. */
interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface ArenaLayout {
  shape: ArenaShape;
  prisms: Prism[];
  hills: Hill[];
  /** the high ground: a rock plateau's middle and top (tiles, m), reached up its ramp */
  plateau: { x: number; z: number; top: number } | null;
  /** the champion's spawn (tile coords) */
  spawn: { x: number; z: number };
  /** monster gates (lairs 1–6), at the foot of the wall */
  gates: { x: number; z: number }[];
  racks: { x: number; z: number; yaw: number }[];
  guardPosts: { x: number; z: number }[];
}

const STONE = ['#b9ab94', '#a89a84', '#c4b69c', '#9e927e'];

/** Is this tile part of the arena floor (the rest is the bowl's wall)? */
export function inArena(shape: ArenaShape, x: number, z: number): boolean {
  return Math.hypot(x + 0.5 - C, z + 0.5 - C) <= shape.radius;
}

/** A block over a tile rectangle, flat-topped at h (m above the floor), its top tapered in by `taper` (0–1). */
function block(r: Rect, y0: number, h: number, color: string, taper = 0): Prism {
  const pts: [number, number][] = [[r.x0 * M, r.z0 * M], [(r.x1 + 1) * M, r.z0 * M], [(r.x1 + 1) * M, (r.z1 + 1) * M], [r.x0 * M, (r.z1 + 1) * M]];
  const cx = ((r.x0 + r.x1 + 1) / 2) * M, cz = ((r.z0 + r.z1 + 1) / 2) * M;
  const top = pts.map(([x, z]) => [x + (cx - x) * taper, z + (cz - z) * taper] as [number, number]);
  return { pts, y0, top, ty: [h, h, h, h].map((v) => FLOOR_Y + v), color };
}

/** Plan the arena: deterministic from the shape. */
export function planArena(shape: ArenaShape): ArenaLayout {
  const R = shape.radius;
  const rng = new Rng(hashSeed(shape.seed, 'arena', R, shape.density));
  const spawn = { x: C + 0.5, z: Math.floor(C + R * 0.45) + 0.5 };
  const gates: { x: number; z: number }[] = [];
  for (let k = 0; k < 6; k++) {
    const a = -Math.PI / 2 + (k / 6) * Math.PI * 2 + Math.PI / 6; // none straight behind the spawn
    gates.push({ x: C + Math.cos(a) * (R - 1.6), z: C + Math.sin(a) * (R - 1.6) });
  }
  const prisms: Prism[] = [];
  const hills: Hill[] = [];
  // tiles already spoken for (with a margin): obstacles keep apart, off the spawn and the middle, out of the gates
  const taken = new Uint8Array(SIZE * SIZE);
  const claim = (r: Rect, margin: number) => {
    for (let z = r.z0 - margin; z <= r.z1 + margin; z++) for (let x = r.x0 - margin; x <= r.x1 + margin; x++) if (x >= 0 && z >= 0 && x < SIZE && z < SIZE) taken[z * SIZE + x] = 1;
  };
  const disk = (cx: number, cz: number, r: number) => {
    for (let z = Math.floor(cz - r); z <= cz + r; z++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= r) taken[z * SIZE + x] = 1;
  };
  disk(spawn.x, spawn.z, 4);
  disk(C, C, 2.5);
  for (const g of gates) disk(g.x, g.z, 3.5);
  const fits = (r: Rect) => {
    for (let z = r.z0 - 1; z <= r.z1 + 1; z++) for (let x = r.x0 - 1; x <= r.x1 + 1; x++) {
      if (!inArena(shape, x, z) || Math.hypot(x + 0.5 - C, z + 0.5 - C) > R - 1.5 || taken[z * SIZE + x]) return false;
    }
    return true;
  };
  /** a free w × d tile rectangle somewhere on the floor, claimed with a 1-tile margin */
  const place = (w: number, d: number, tries = 120): Rect | null => {
    for (let k = 0; k < tries; k++) {
      const a = rng.next() * Math.PI * 2, dist = Math.sqrt(rng.next()) * (R - 2);
      const x0 = Math.floor(C + Math.cos(a) * dist - w / 2), z0 = Math.floor(C + Math.sin(a) * dist - d / 2);
      const r = { x0, z0, x1: x0 + w - 1, z1: z0 + d - 1 };
      if (fits(r)) {
        claim(r, 1);
        return r;
      }
    }
    return null;
  };
  const color = () => rng.pick(STONE)!;
  const along = () => rng.chance(0.5); // an x-long or a z-long piece

  const area = (R * R) / (22 * 22);
  const mul = shape.density === 'none' ? 0 : shape.density === 'lots' ? 2 * area : area;
  const n = (base: number) => Math.round(base * mul);

  // the high ground: a plateau north of the middle, its ramp coming down toward the spawn
  let plateau: ArenaLayout['plateau'] = null;
  if (shape.density !== 'none') {
    const s = R >= 18 ? 3 : 2, h = 12;
    const x0 = Math.floor(C - s / 2), z0 = Math.floor(C - R * 0.42 - s / 2);
    const top: Rect = { x0, z0, x1: x0 + s - 1, z1: z0 + s - 1 };
    const rampLen = 4;
    const ramp: Rect = { x0: x0 + Math.floor((s - 1) / 2), z0: top.z1 + 1, x1: x0 + Math.floor((s - 1) / 2), z1: top.z1 + rampLen };
    if (fits({ ...top, z1: ramp.z1 })) {
      const col = color();
      prisms.push(block(top, FLOOR_Y - 1, h, col));
      // the ramp: a wedge from the plateau's edge (full height) down to a low step at its foot
      const pts: [number, number][] = [[ramp.x0 * M, ramp.z0 * M], [(ramp.x1 + 1) * M, ramp.z0 * M], [(ramp.x1 + 1) * M, (ramp.z1 + 1) * M], [ramp.x0 * M, (ramp.z1 + 1) * M]];
      prisms.push({ pts, y0: FLOOR_Y - 1, top: pts, ty: [h, h, RAMP_FOOT, RAMP_FOOT].map((v) => FLOOR_Y + v), color: col });
      claim({ ...top, z1: ramp.z1 }, 1);
      claim({ ...ramp, z0: ramp.z1 + 1, z1: ramp.z1 + 2 }, 0); // room at the ramp's foot
      plateau = { x: (x0 + s / 2), z: (z0 + s / 2), top: FLOOR_Y + h };
    }
  }
  // pillars: rock needles to climb and fight around
  for (let k = 0; k < n(11); k++) {
    const s = rng.chance(0.3) ? 2 : 1;
    const r = place(s, s);
    // a slight taper, small enough that the face is still in reach from the floor tile at knee height
    if (r) prisms.push(block(r, FLOOR_Y - 1, 10 + rng.next() * 20, color(), rng.next() * 0.15));
  }
  // arches: walk under them, climb their legs, stand on the span
  for (let k = 0; k < n(3); k++) {
    const len = 4 + rng.int(0, 1), x = along();
    const r = place(x ? len : 1, x ? 1 : len);
    if (!r) continue;
    const h = 9 + rng.next() * 5, col = color();
    const leg = (a: number) => (x ? { x0: a, z0: r.z0, x1: a, z1: r.z0 } : { x0: r.x0, z0: a, x1: r.x0, z1: a });
    prisms.push(block(leg(x ? r.x0 : r.z0), FLOOR_Y - 1, h, col), block(leg(x ? r.x1 : r.z1), FLOOR_Y - 1, h, col));
    prisms.push(block(r, FLOOR_Y + h, h + 2.5, col));
  }
  // towers with an overhanging cap: a ceiling to climb up to
  for (let k = 0; k < n(2); k++) {
    const r = place(1, 1);
    if (!r) continue;
    const h = 16 + rng.next() * 6, col = color();
    prisms.push(block(r, FLOOR_Y - 1, h, col));
    prisms.push(block({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 }, FLOOR_Y + h, h + 2.5, col, -0.6));
  }
  // walls: cover from a charge, and a short climb
  for (let k = 0; k < n(6); k++) {
    const len = 2 + rng.int(0, 1), x = along();
    const r = place(x ? len : 1, x ? 1 : len);
    if (r) prisms.push(block(r, FLOOR_Y - 1, 2.4 + rng.next() * 1.2, color()));
  }
  // hop blocks: steps a jump clears (a jump lands on ~1.35 m), three in a row
  for (let k = 0; k < n(4); k++) {
    const x = along();
    const r = place(x ? 3 : 1, x ? 1 : 3);
    if (!r) continue;
    const col = color();
    for (let j = 0; j < 3; j++) {
      const t = x ? { x0: r.x0 + j, z0: r.z0, x1: r.x0 + j, z1: r.z0 } : { x0: r.x0, z0: r.z0 + j, x1: r.x0, z1: r.z0 + j };
      prisms.push(block(t, FLOOR_Y - 1, 1.1 * (j + 1), col));
    }
  }
  // low hills (terrain): rolling ground the monsters walk over too, kept clear of the rock
  for (let k = 0; k < n(5); k++) {
    const r = 2.5 + rng.next() * 2.5;
    const w = Math.ceil(r * 2);
    const p = place(w, w);
    if (p) hills.push({ x: (p.x0 + p.x1 + 1) / 2, z: (p.z0 + p.z1 + 1) / 2, r, h: 2.5 + rng.next() * 3.5 });
  }

  // spear racks: one at the spawn, the rest spread out
  const racks: ArenaLayout['racks'] = [{ x: spawn.x + 1.4, z: spawn.z, yaw: 0 }];
  for (let k = 0; k < 3; k++) {
    const p = place(1, 1);
    if (p) racks.push({ x: p.x0 + 0.5, z: p.z0 + 0.5, yaw: rng.next() * Math.PI });
  }
  const guardPosts = [-1.6, -0.6, 0.6, 1.6].map((dx) => ({ x: spawn.x + dx, z: spawn.z - 1.6 }));
  return { shape, prisms, hills, plateau, spawn, gates, racks, guardPosts };
}

/** The floor's height (m) at a point (tiles), hills included. */
function floorAt(L: ArenaLayout, x: number, z: number): number {
  let y = FLOOR_Y;
  for (const h of L.hills) {
    const t = Math.hypot(x - h.x, z - h.z) / h.r;
    if (t < 1) y = Math.max(y, FLOOR_Y + h.h * (0.5 + 0.5 * Math.cos(t * Math.PI)));
  }
  return y;
}

/**
 * Ground heights at every Ground vertex, quantized as island saves are (island-import.ts). A vertex on the edge of
 * any floor tile is floor; the rest is the top of the bowl's wall, so the wall rises sheer from the last floor tile.
 */
export function arenaBase(L: ArenaLayout): Float32Array {
  const base = new Float32Array(NV * NV);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
    const x = i / RES, z = j / RES;
    let floor = false;
    for (const tz of [Math.ceil(z) - 1, Math.floor(z)]) for (const tx of [Math.ceil(x) - 1, Math.floor(x)]) if (inArena(L.shape, tx, tz)) floor = true;
    const y = floor ? floorAt(L, x, z) : FLOOR_Y + L.shape.wallH;
    base[j * NV + i] = Math.round(y / 0.02) * 0.02;
  }
  return base;
}

function inPoly(pts: [number, number][], px: number, pz: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Per tile, 1 where rock stands at body height (from within 2.5 m of the floor): the sim's blocked tiles. */
export function solidTiles(L: ArenaLayout): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE);
  for (const p of L.prisms) {
    if (p.y0 > FLOOR_Y + 2.5) continue; // a span overhead
    const xs = p.pts.map((q) => q[0] / M), zs = p.pts.map((q) => q[1] / M);
    for (let z = Math.floor(Math.min(...zs)); z < Math.ceil(Math.max(...zs)); z++) for (let x = Math.floor(Math.min(...xs)); x < Math.ceil(Math.max(...xs)); x++) {
      if (x >= 0 && z >= 0 && x < SIZE && z < SIZE && inPoly(p.pts, (x + 0.5) * M, (z + 0.5) * M)) out[z * SIZE + x] = 1;
    }
  }
  return out;
}

/** The rock as a triangle soup in meters (non-indexed, outward-facing) with an sRGB hex color per triangle. Bottoms
 *  are only built for rock off the ground (spans, caps): a buried bottom would read as a ceiling. */
export function prismTriangles(prisms: Prism[]): { pos: number[]; colors: string[] } {
  const pos: number[] = [], colors: string[] = [];
  const tri = (a: number[], b: number[], c: number[], want: [number, number, number], col: string) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) [b, c] = [c, b];
    pos.push(...a, ...b, ...c);
    colors.push(col);
  };
  for (const p of prisms) {
    const n = p.pts.length;
    let cx = 0, cz = 0;
    for (const [x, z] of p.pts) { cx += x / n; cz += z / n; }
    const B = p.pts.map(([x, z]) => [x, p.y0, z]);
    const T = p.top.map(([x, z], k) => [x, p.ty[k], z]);
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const ox = (p.pts[k][0] + p.pts[k1][0]) / 2 - cx, oz = (p.pts[k][1] + p.pts[k1][1]) / 2 - cz;
      tri(B[k], B[k1], T[k1], [ox, 0, oz], p.color);
      tri(B[k], T[k1], T[k], [ox, 0, oz], p.color);
      if (k > 0 && k < n - 1) {
        tri(T[0], T[k], T[k1], [0, 1, 0], p.color);
        if (p.y0 > FLOOR_Y) tri(B[0], B[k], B[k1], [0, -1, 0], p.color);
      }
    }
  }
  return { pos, colors };
}
