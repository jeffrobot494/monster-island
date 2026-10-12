// Climbing queries against the ground (docs/climbing-phase1-plan.md, Part B). Positions in tiles, heights and
// distances in meters, slopes in m/m. Pure: the controller and the tests use them. The controller combines them with
// the feature mesh (feature-surface.ts).
import { M, type Ground } from '../sim/ground';

export const WALL = Math.tan((50 * Math.PI) / 180); // steeper than this on a cliff tile: a wall
export const LEDGE = Math.tan((40 * Math.PI) / 180); // flatter than this: somewhere to stand
export const PROBE = 0.25; // m

/** A face: the horizontal unit vector OUT of it (downhill), its slope (m/m), and whether it leans past vertical. */
export interface Face { nx: number; nz: number; slope: number; over?: boolean }

/** The face of a unit 3D normal (a feature-mesh triangle): 99 for the slope of anything vertical or past it. */
export function faceOf(nx: number, ny: number, nz: number): Face {
  const h = Math.hypot(nx, nz);
  if (h < 1e-6) return { nx: 0, nz: 0, slope: ny > 0 ? 0 : 99, over: ny < 0 };
  return { nx: nx / h, nz: nz / h, slope: ny > 1e-3 ? h / ny : 99, over: ny < -0.02 };
}

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
