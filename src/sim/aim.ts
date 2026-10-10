// Hit zone by aim (spec §5.2, F2): the client casts the look ray into the target's oriented box, takes the entry
// point normalized to the box (h = height 0..1, s = side −1..1 with + on the target's right, f = forward −1..1),
// and maps it to a zone by body plan.
import type { Zone } from './types';
import { BODY, SHAPE_M } from './body';

export type Plan = 'biped' | 'quad' | 'serpent';

export function planFor(arch: string): Plan {
  if (arch === 'reem' || arch === 'rahab' || arch === 'goat' || arch === 'ox') return 'quad';
  if (arch === 'saraph' || arch === 'tannin') return 'serpent';
  return 'biped';
}

export function zoneFor(arch: string, h: number, s: number, f: number): Zone {
  const plan = planFor(arch);
  const side = (l: Zone, r: Zone) => (s < 0 ? l : r);
  if (plan === 'biped') {
    const arm = Math.abs(s) > 0.55 && h >= 0.45 && h <= 0.82;
    if (arch === 'nephil' && arm && s > 0) return 'sig'; // the club arm
    if ((arch === 'lilit' && arm && h < 0.6) || (arch === 'anak' && arm)) return 'sig'; // talons / grasping hands
    if (arch === 'seir' && h > 0.9) return 'sig'; // horns
    if (h > 0.82) return 'head';
    if (h < 0.45) return side('legL', 'legR');
    if (arm) return side('armL', 'armR');
    return 'torso';
  }
  if (plan === 'quad') {
    if (arch === 'reem' && f > 0.8 && h > 0.45) return 'sig'; // horns
    if (f > 0.55) return arch === 'rahab' ? 'sig' : 'head'; // rahab's jaws are its signature
    if (h < 0.4) return f > 0 ? side('armL', 'armR') : side('legL', 'legR');
    return 'torso';
  }
  if (arch === 'saraph' && h > 0.6 && Math.abs(s) > 0.5) return 'sig'; // wings
  if (f > 0.6) return 'head';
  if (f < -0.5) return side('legL', 'legR'); // the tail
  if (arch === 'tannin' && h > 0.5) return 'sig'; // coils
  return 'torso';
}

/** The oriented box (meters) a creature is hit-tested against. */
export function hitBox(arch: string | null, scale: number): { len: number; wid: number; hgt: number } {
  const b = arch ? BODY[arch] : undefined;
  if (!b) return { len: 0.3, wid: 0.3, hgt: 1.8 * scale };
  const k = scale * SHAPE_M;
  return { len: (b.half + b.r) * k, wid: b.r * k, hgt: b.height * k };
}

/**
 * Ray (origin, dir; meters) against a box standing at (x, y, z) facing yaw. Returns the entry distance and the
 * normalized entry point, or null. `fat` widens the box (m) so near-misses still count.
 */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x: number, y: number, z: number, yaw: number, box: { len: number; wid: number; hgt: number }, fat = 0,
): { t: number; h: number; s: number; f: number } | null {
  const fx = Math.sin(yaw), fz = Math.cos(yaw); // forward
  const rx = -fz, rz = fx; // the creature's right
  const px = ox - x, py = oy - y, pz = oz - z;
  const o = [px * fx + pz * fz, px * rx + pz * rz, py];
  const d = [dx * fx + dz * fz, dx * rx + dz * rz, dy];
  const lo = [-box.len - fat, -box.wid - fat, -fat], hi = [box.len + fat, box.wid + fat, box.hgt + fat];
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < lo[k] || o[k] > hi[k]) return null;
      continue;
    }
    let a = (lo[k] - o[k]) / d[k], b = (hi[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  const ef = o[0] + d[0] * t0, es = o[1] + d[1] * t0, eh = o[2] + d[2] * t0;
  const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return { t: t0, f: cl(ef / Math.max(0.01, box.len), -1, 1), s: cl(es / Math.max(0.01, box.wid), -1, 1), h: cl(eh / Math.max(0.01, box.hgt), 0, 1) };
}
