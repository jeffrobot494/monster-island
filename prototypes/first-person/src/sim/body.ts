// Physical bodies in meters (spec §2, F12, F14): radius, reach and capsule half-length per archetype. The sim works in
// tiles, so helpers return tiles (meters / 8).
import type { Entity } from './types';
import { M, type Ground } from './ground';

export const SHAPE_M = 2.25; // meters per shape unit (F1)

interface Body { r: number; reach: number; half: number; height: number }

/** height = shape height (units) × SHAPE_M at scale 1; scaled by e.scale at runtime */
export const BODY: Record<string, Body> = {
  // values in shape units at scale 1; with base scales: nephil ≈ 5 m tall, 1 m radius, 3.4 m reach
  nephil: { r: 0.2, reach: 0.69, half: 0, height: 1.0 },
  saraph: { r: 0.205, reach: 0.82, half: 0.34, height: 0.85 },
  seir: { r: 0.18, reach: 0.68, half: 0, height: 0.9 },
  lilit: { r: 0.16, reach: 0.82, half: 0, height: 0.85 },
  rahab: { r: 0.25, reach: 0.64, half: 0.54, height: 0.4 },
  anak: { r: 0.19, reach: 0.61, half: 0, height: 0.8 },
  reem: { r: 0.235, reach: 0.65, half: 0.31, height: 0.6 },
  ziz: { r: 0.2, reach: 0.72, half: 0.2, height: 0.6 },
  tannin: { r: 0.25, reach: 0.72, half: 0.42, height: 0.4 },
  goat: { r: 0.13, reach: 0, half: 0.16, height: 0.4 },
  ox: { r: 0.22, reach: 0, half: 0.31, height: 0.65 },
};
/** humans and anything else */
const HUMAN: Body = { r: 0.3 / SHAPE_M, reach: 0, half: 0, height: 0.8 };

function bodyOf(e: Entity): Body {
  return BODY[e.monster?.archetype ?? e.animal?.species ?? ''] ?? HUMAN;
}

/** size factor: base-shape units × entity scale × meters per unit (scale already includes level growth) */
const meters = (e: Entity, units: number) => units * e.scale * SHAPE_M;

/** body radius in tiles */
export function bodyR(e: Entity): number {
  if (e.kind === 'human') return 0.3 / M;
  return meters(e, bodyOf(e).r) / M;
}

/** attack reach in tiles (monsters), measured from the front point */
export function reachT(e: Entity): number {
  return meters(e, bodyOf(e).reach) / M;
}

/** capsule half-length in tiles (0 for upright bodies) */
export function halfT(e: Entity): number {
  return meters(e, bodyOf(e).half) / M;
}

export function heightM(e: Entity): number {
  return meters(e, bodyOf(e).height);
}

/** attack reach in meters */
export function reachM(e: Entity): number {
  return reachT(e) * M;
}

/** Feet height (m, absolute): the ground plus a climber's or a flyer's altitude. */
export function feetY(ground: Ground, e: Entity): number {
  return ground.y(e.x, e.z) + (e.human?.alt ?? 0) + (e.monster?.alt ?? 0);
}

/** Can monster m's attacks reach champion c vertically? (docs/climbing-phase1-plan.md, Rules) `cFeet` overrides c's
 *  feet height (a recent pose). */
export function champReachable(ground: Ground, m: Entity, c: Entity, cFeet = feetY(ground, c)): boolean {
  const dy = cFeet - feetY(ground, m);
  return dy > -(reachM(m) + 1.8) && dy < heightM(m) + reachM(m) - 1;
}

/** The capsule's front point (where long creatures bite from). */
export function frontPoint(e: Entity): { x: number; z: number } {
  const h = halfT(e);
  return { x: e.x + Math.sin(e.yaw) * h, z: e.z + Math.cos(e.yaw) * h };
}

/** Distance (tiles) from a point to the entity's capsule axis (not minus the radius). */
export function axisDist(e: Entity, x: number, z: number): number {
  const h = halfT(e);
  if (h <= 0) return Math.hypot(x - e.x, z - e.z);
  const ax = Math.sin(e.yaw), az = Math.cos(e.yaw);
  const t = Math.max(-h, Math.min(h, (x - e.x) * ax + (z - e.z) * az));
  return Math.hypot(x - (e.x + ax * t), z - (e.z + az * t));
}

/** Distance between body surfaces (tiles), ≥ 0 when apart. */
export function gap(a: Entity, b: Entity): number {
  return Math.min(axisDist(a, b.x, b.z), axisDist(b, a.x, a.z)) - bodyR(a) - bodyR(b);
}

/** Closest point on the entity's capsule axis to (x, z). */
export function axisPoint(e: Entity, x: number, z: number): { x: number; z: number } {
  const h = halfT(e);
  if (h <= 0) return { x: e.x, z: e.z };
  const ax = Math.sin(e.yaw), az = Math.cos(e.yaw);
  const t = Math.max(-h, Math.min(h, (x - e.x) * ax + (z - e.z) * az));
  return { x: e.x + ax * t, z: e.z + az * t };
}

/** Absolute angle (rad) between a facing yaw and the direction from (x, z) to (tx, tz). */
export function bearingOff(yaw: number, x: number, z: number, tx: number, tz: number): number {
  let d = Math.atan2(tx - x, tz - z) - yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}
