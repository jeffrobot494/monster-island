// Climbing queries against the ground (docs/climbing-phase1-plan.md, Part B). Positions in tiles, heights and
// distances in meters, slopes in m/m. Pure: the controller and the tests use them. Phase 2 adds the feature-mesh
// triangles behind the same functions.
import { M, type Ground } from '../sim/ground';

export const WALL = Math.tan((50 * Math.PI) / 180); // steeper than this on a cliff tile: a wall
export const LEDGE = Math.tan((40 * Math.PI) / 180); // flatter than this: somewhere to stand
export const PROBE = 0.25; // m

/** A face: the horizontal unit vector OUT of it (downhill), and its slope (m/m). */
export interface Face { nx: number; nz: number; slope: number }

/** Gradient-based face at (x, z), averaged over a 2 m square (5 samples), so the triangle seams don't jitter it. */
export function faceAt(g: Ground, x: number, z: number): Face {
  const o = 1 / M;
  let gx = 0, gz = 0;
  for (const [dx, dz] of [[0, 0], [o, o], [-o, o], [o, -o], [-o, -o]]) {
    const [sx, sz] = g.slope(x + dx, z + dz);
    gx += sx / 5;
    gz += sz / 5;
  }
  const s = Math.hypot(gx, gz);
  return s > 1e-6 ? { nx: -gx / s, nz: -gz / s, slope: s } : { nx: 0, nz: 0, slope: 0 };
}

/** The face right under a point (central differences over ±0.1 m, no averaging): for "can I stand here?", where the
 *  2 m average of faceAt would feel a wall that's still a body-width away. */
export function localFace(g: Ground, x: number, z: number): Face {
  const e = 0.1 / M;
  const gx = (g.y(x + e, z) - g.y(x - e, z)) / 0.2, gz = (g.y(x, z + e) - g.y(x, z - e)) / 0.2;
  const s = Math.hypot(gx, gz);
  return s > 1e-6 ? { nx: -gx / s, nz: -gz / s, slope: s } : { nx: 0, nz: 0, slope: 0 };
}

/** Directional slope (m/m) from (x, z) along a horizontal unit direction, over PROBE: + is uphill. */
export function slopeAlong(g: Ground, x: number, z: number, dx: number, dz: number): number {
  return (g.y(x + (dx * PROBE) / M, z + (dz * PROBE) / M) - g.y(x, z)) / PROBE;
}

/**
 * Horizontal distance (m) from (x, z) along −n (into the face) to where the ground first reaches height y, or null
 * if it doesn't within maxM. 0 when the ground at (x, z) is already at or above y.
 */
export function distToFace(g: Ground, x: number, z: number, nx: number, nz: number, y: number, maxM = 2): number | null {
  const at = (d: number) => g.y(x - (nx * d) / M, z - (nz * d) / M);
  if (at(0) >= y) return 0;
  for (let d = 0.1; d <= maxM + 1e-9; d += 0.1) {
    if (at(d) < y) continue;
    let lo = d - 0.1, hi = d;
    for (let k = 0; k < 6; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid) >= y) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  return null;
}

/**
 * The steepest face around (x, z) that reaches height y within maxM (8 probes), or null: air grabs and re-grabs.
 * 1 m, not the design's 0.6: heightmap faces lean back, so at hand height a 78° face is ~0.7 m from a climber's body.
 */
export function wallNear(g: Ground, x: number, z: number, y: number, maxM = 1): Face | null {
  if (g.y(x, z) >= y) return null;
  let best: Face | null = null;
  for (let a = 0; a < 8; a++) {
    const dx = Math.cos((a / 8) * Math.PI * 2), dz = Math.sin((a / 8) * Math.PI * 2);
    const d = distToFace(g, x, z, -dx, -dz, y, maxM);
    if (d === null) continue;
    const f = faceAt(g, x + (dx * d) / M, z + (dz * d) / M);
    // a wall, and facing us
    if (f.slope <= WALL || f.nx * dx + f.nz * dz > -0.3) continue;
    if (!best || f.slope > best.slope) best = f;
  }
  return best;
}
