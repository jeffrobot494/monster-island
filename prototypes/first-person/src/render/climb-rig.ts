// Monster bodies as climbable surfaces (docs/climbing-phase3-plan.md, Part B): the climb volumes of a view in world
// meters on this frame's pose, a rider's place on them, and the rules for getting on. The controller sees only
// MountBody, so it stays free of three.js.
import * as THREE from 'three';
import { CLIMB, RIDE } from '../sim/climb-body';
import { SHAPE_M } from '../sim/body';
import { F_BOUND, F_CORPSE, F_DOWNED, F_MONSTER } from '../protocol';
import { ZONE_BIT, type Rig } from './rigs';
import type { Entities, View } from './entities';
import type { MountBody, MountHow } from '../input/controller';

/** a capsule this frame: axis a→b (m), radius (m), and the joint that carries it */
export interface Cap { i: number; a: THREE.Vector3; b: THREE.Vector3; r: number; frame: THREE.Object3D }

/** the recovery window after a monster's blow lands, when you can jump on (the sim's attackReadyAt: 15 ticks) */
export const RECOVER_MS = 1500;
const TILT = 0.3; // share of the body's pitch and roll the camera takes

const isAncestor = (a: THREE.Object3D, b: THREE.Object3D) => {
  for (let o = b.parent; o; o = o.parent) if (o === a) return true;
  return false;
};

/** The joint a segment moves with: the parent of the end that hangs from the other (a thigh rides the hip), or the
 *  joint both hang from (the shoulders ride the spine). */
function carrier(pa: THREE.Object3D, pb: THREE.Object3D): THREE.Object3D {
  if (isAncestor(pa, pb)) return pb.parent!;
  if (isAncestor(pb, pa)) return pa.parent!;
  const up = new Set<THREE.Object3D>();
  for (let o: THREE.Object3D | null = pa; o; o = o.parent) up.add(o);
  for (let o: THREE.Object3D | null = pb.parent; o; o = o.parent) if (up.has(o)) return o;
  return pa;
}

const carriers = new WeakMap<Rig, THREE.Object3D[]>();

/** The view's climb volumes on its current pose (severed zones left out), or null when it has none. */
export function bodyCaps(v: View): Cap[] | null {
  const rig = v.rig, defs = CLIMB[v.shape];
  if (!rig || !defs || !v.root.visible) return null;
  v.root.updateMatrixWorld(true);
  let fr = carriers.get(rig);
  if (!fr) carriers.set(rig, (fr = []));
  const k = SHAPE_M * v.scale, out: Cap[] = [];
  for (const [i, d] of defs.entries()) {
    if ((v.mask >> (8 + ZONE_BIT[d.zone])) & 1) continue;
    const pa = rig.points[d.a], pb = rig.points[d.b];
    if (!pa || !pb) continue;
    fr[i] ??= carrier(pa, pb);
    out.push({ i, a: pa.getWorldPosition(new THREE.Vector3()), b: pb.getWorldPosition(new THREE.Vector3()), r: d.r * k, frame: fr[i] });
  }
  return out.length ? out : null;
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

/** the axis parameter (0..1) of the point on c's axis nearest p */
function axisT(c: Cap, p: THREE.Vector3): number {
  tmp.subVectors(c.b, c.a);
  const l2 = tmp.lengthSq();
  return l2 < 1e-9 ? 0 : Math.min(1, Math.max(0, tmp2.subVectors(p, c.a).dot(tmp) / l2));
}

/** signed distance (m) from p to c's surface: negative inside */
export function capDist(c: Cap, p: THREE.Vector3): number {
  const t = axisT(c, p);
  return tmp2.copy(c.a).lerp(c.b, t).distanceTo(p) - c.r;
}

/** the nearest surface distance of the union of caps to p */
export function bodyDist(caps: Cap[], p: THREE.Vector3): number {
  let s = Infinity;
  for (const c of caps) s = Math.min(s, capDist(c, p));
  return s;
}

/** Where a rider is on a body, rebuilt from the posed rig every frame: (capsule, u along the axis, the outward
 *  direction in the carrying joint's frame). */
export class Rider implements MountBody {
  cap = -1;
  private u = 0;
  private dir = new THREE.Vector3(0, 0, 1);
  private p = new THREE.Vector3();
  private n = new THREE.Vector3(0, 1, 0);
  private q0 = new THREE.Quaternion();
  private yaw0 = 0;

  readonly perchNy: number | undefined;

  constructor(private ents: Entities, readonly id: number) {
    this.perchNy = RIDE[ents.views.get(id)?.shape ?? '']?.perch;
  }

  private caps(): Cap[] | null {
    const v = this.ents.views.get(this.id);
    if (!v || !(v.flags & F_MONSTER) || v.flags & (F_CORPSE | F_BOUND)) return null;
    return bodyCaps(v);
  }

  /** Attach at the surface nearest p (m). False when the body has no volumes. */
  attach(p: THREE.Vector3): boolean {
    const caps = this.caps();
    if (!caps) return false;
    this.n.set(0, 1, 0);
    this.project(caps, p);
    const v = this.ents.views.get(this.id)!;
    this.hips(v)?.getWorldQuaternion(this.q0);
    this.yaw0 = v.yaw;
    return true;
  }

  /** Out of the deepest capsule p is inside (a few times, for junctions), else onto the nearest surface, preferring
   *  the current capsule; stored in the carrying joint's frame. */
  private project(caps: Cap[], p: THREE.Vector3) {
    const q = p.clone();
    let pushed: Cap | null = null;
    for (let it = 0; it < 3; it++) {
      let deep: Cap | null = null, ds = -0.005;
      for (const c of caps) {
        const s = capDist(c, q);
        if (s < ds) { ds = s; deep = c; }
      }
      if (!deep) break;
      this.onto(deep, q);
      pushed = deep;
    }
    let best = pushed;
    if (!best) {
      let bs = Infinity;
      for (const c of caps) {
        const s = capDist(c, q) - (c.i === this.cap ? 0.03 : 0);
        if (s < bs) { bs = s; best = c; }
      }
    }
    const c = best!;
    this.u = this.onto(c, q);
    this.cap = c.i;
    this.p.copy(q);
    this.dir.copy(this.n).applyQuaternion(c.frame.getWorldQuaternion(new THREE.Quaternion()).invert());
  }

  /** Move q onto c's surface (sets this.n); returns the axis parameter. */
  private onto(c: Cap, q: THREE.Vector3): number {
    const t = axisT(c, q);
    const ax = c.a.clone().lerp(c.b, t);
    const d = q.clone().sub(ax);
    if (d.lengthSq() > 1e-10) this.n.copy(d.normalize());
    q.copy(ax).addScaledVector(this.n, c.r);
    return t;
  }

  place(): { p: [number, number, number]; n: [number, number, number] } | null {
    const caps = this.caps();
    if (!caps) return null;
    const c = caps.find((k) => k.i === this.cap);
    // the limb you were on went (severed): you go with it (docs/climbing-phase4-plan.md, Part B)
    if (!c) return null;
    {
      const ax = c.a.clone().lerp(c.b, this.u);
      const n = this.dir.clone().applyQuaternion(c.frame.getWorldQuaternion(new THREE.Quaternion()));
      // along the axis only round an end cap, outward
      const along = tmp.subVectors(c.b, c.a);
      const l = along.length();
      if (l > 1e-6) {
        along.divideScalar(l);
        const k = n.dot(along);
        if (!((this.u <= 0 && k < 0) || (this.u >= 1 && k > 0))) n.addScaledVector(along, -k);
      }
      if (n.lengthSq() > 1e-10) this.n.copy(n.normalize());
      this.p.copy(ax).addScaledVector(this.n, c.r);
    }
    return { p: [this.p.x, this.p.y, this.p.z], n: [this.n.x, this.n.y, this.n.z] };
  }

  move(dx: number, dy: number, dz: number) {
    const caps = this.caps();
    if (caps) this.project(caps, this.p.clone().add(new THREE.Vector3(dx, dy, dz)));
  }

  yaw(): number {
    return this.ents.views.get(this.id)?.yaw ?? 0;
  }

  private hips(v: View): THREE.Object3D | undefined {
    return v.rig?.points.hips ?? v.rig?.body;
  }

  /** TILT of the body's pitch and roll since you got on, in the view's frame (rad). */
  tilt(viewYaw: number): [number, number] {
    const v = this.ents.views.get(this.id);
    const h = v && this.hips(v);
    if (!v || !h) return [0, 0];
    const q = h.getWorldQuaternion(new THREE.Quaternion()).multiply(this.q0.clone().invert());
    // without the turn (the view carries that), seen from where you look
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(v.yaw - this.yaw0)));
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), viewYaw + Math.PI);
    q.premultiply(qy.clone().invert()).multiply(qy);
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const cl = (a: number) => Math.max(-0.3, Math.min(0.3, a * TILT));
    return [cl(e.x), cl(e.z)];
  }
}

/** Getting on (Part C): who is in reach of a point, by the rule for how you're trying. */
export class Mounts {
  /** dev: any rule gets you on (headless checks on a standing body) */
  any = false;
  constructor(private ents: Entities) {}

  /**
   * The body whose surface is nearest p (m) within maxM, by `how`:
   * 'ground' (Space beside it) and 'air' (Space held in a jump) need it downed, and 'air' also takes the recovery
   * window after its blow; 'drop' (falling into it from above) takes any monster with climb volumes.
   */
  find(p: THREE.Vector3, maxM: number, how: MountHow, now = performance.now()): Rider | null {
    let best: { v: View; s: number } | null = null;
    for (const v of this.ents.views.values()) {
      if (!(v.flags & F_MONSTER) || v.flags & (F_CORPSE | F_BOUND) || !CLIMB[v.shape] || !v.rig) continue;
      const downed = (v.flags & F_DOWNED) !== 0;
      if (!this.any && how === 'ground' && !downed) continue;
      if (!this.any && how === 'air' && !downed && now - v.struckAt > RECOVER_MS) continue;
      if (v.pos.distanceTo(p) > 20 * v.scale) continue;
      const caps = bodyCaps(v);
      if (!caps) continue;
      const s = bodyDist(caps, p);
      if (s <= maxM && (!best || s < best.s)) best = { v, s };
    }
    if (!best) return null;
    const r = new Rider(this.ents, best.v.id);
    return r.attach(p) ? r : null;
  }
}
