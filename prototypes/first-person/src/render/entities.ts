// Entity views (spec §7.5, F15, F17, F18): rigs for core creatures, ShapeDefs for everything else, a snapshot buffer
// rendered 1.5 ticks behind the newest frame, and look-ray picking against oriented boxes.
import * as THREE from 'three';
import { ENT_STRIDE, F_CHAMPION, F_CORE_SHAPE, F_CORPSE, F_DOWNED, F_HUMAN, F_INHABITANT, F_MONSTER, F_ANIMAL, F_TELEGRAPH, F_BOUND, F_HITTABLE, F_DRAGGED, F_ITEM, O } from '../protocol';
import type { ShapeDef } from '../sim/types';
import { M } from '../sim/ground';
import { SHAPE_M, BODY } from '../sim/body';
import { buildRig, hasRig, Rig, ANIM, rigMat } from './rigs';
import { hitBox, rayBox } from '../sim/aim';

const DEG = Math.PI / 180;
const PRIMS = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 10, 7),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
};

interface Sample { t: number; x: number; y: number; z: number; yaw: number; lift: number; roll: number }

export interface View {
  id: number;
  root: THREE.Group;
  rig: Rig | null;
  shapeParts: { mesh: THREE.Mesh; part: ShapeDef['parts'][number] }[];
  key: string;
  shape: string;
  tint: number;
  flags: number;
  scale: number;
  squash: number;
  ring: number;
  anim: number;
  mask: number;
  hp: number;
  seen: boolean;
  windup: number;
  windupAt: number;
  strike: number;
  samples: Sample[];
  /** interpolated render position (m) */
  pos: THREE.Vector3;
  yaw: number;
  lift: number;
  roll: number;
  speed: number;
  lastFrame: number;
  phase: number;
}

const mats = new Map<string, THREE.MeshLambertMaterial>();
function shapeMat(color: string, emissive: number, opacity: number) {
  const key = `${color}|${emissive}|${opacity}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    if (emissive > 0) {
      m.emissive = new THREE.Color(color);
      m.emissiveIntensity = emissive;
    }
    mats.set(key, m);
  }
  return m;
}

export interface ChampPose { x: number; y: number; z: number; yaw: number }

export class Entities {
  group = new THREE.Group();
  views = new Map<number, View>();
  shapeIds: string[] = [];
  shapes = new Map<string, ShapeDef>();
  /** newest sim tick and when it arrived (performance.now ms) */
  latestTick = 0;
  private tickClock = 0; // smoothed estimate of the current sim tick
  renderTick = 0;
  private frameNo = 0;

  setDefs(shapeIds: string[], shapes: Map<string, ShapeDef>) {
    this.shapeIds = shapeIds;
    this.shapes = shapes;
    for (const v of this.views.values()) v.key = ''; // rebuild
  }

  private archOf(v: View): string | null {
    if (v.flags & F_MONSTER) return v.shape in BODY ? v.shape : null;
    if (v.flags & F_ANIMAL) return v.shape;
    return null;
  }

  private build(v: View) {
    for (const c of [...v.root.children]) v.root.remove(c);
    v.rig = null;
    v.shapeParts = [];
    const tint = '#' + v.tint.toString(16).padStart(6, '0');
    const useRig = hasRig(v.shape) && ((v.flags & F_CORE_SHAPE) !== 0 || (v.flags & F_CORPSE) !== 0);
    if (useRig) {
      v.rig = buildRig(v.shape, tint, v.id);
      v.root.add(v.rig.root);
      v.rig.root.traverse((o) => (o.userData.entityId = v.id));
      return;
    }
    const def = this.shapes.get(v.shape);
    if (!def) return;
    for (const part of def.parts) {
      const color = part.color === 'tint' ? tint : part.color;
      const mesh = new THREE.Mesh(PRIMS[part.prim], shapeMat(color, part.emissive ?? 0, part.opacity ?? 1));
      mesh.castShadow = (part.opacity ?? 1) >= 1 && v.shape !== 'blood';
      mesh.receiveShadow = true;
      v.root.add(mesh);
      v.shapeParts.push({ mesh, part });
    }
  }

  /** Apply a frame of packed entities. */
  apply(ents: Float32Array, tick: number, full: boolean) {
    this.frameNo++;
    const now = performance.now();
    if (full || tick < this.latestTick) {
      this.tickClock = tick;
    }
    this.latestTick = tick;
    for (let o = 0; o < ents.length; o += ENT_STRIDE) {
      const id = ents[o + O.id];
      const shape = this.shapeIds[ents[o + O.shape]] ?? '';
      let v = this.views.get(id);
      if (!v) {
        const root = new THREE.Group();
        root.rotation.order = 'YXZ';
        v = {
          id, root, rig: null, shapeParts: [], key: '', shape, tint: -1, flags: 0, scale: 1, squash: 1, ring: 0, anim: 0, mask: 0, hp: 1, seen: true,
          windup: -1, windupAt: 0, strike: 0, samples: [], pos: new THREE.Vector3(), yaw: 0, lift: 0, roll: 0, speed: 0, lastFrame: 0, phase: Math.random() * 10,
        };
        this.views.set(id, v);
        this.group.add(root);
      }
      const flags = ents[o + O.flags];
      const tint = ents[o + O.tint];
      v.shape = shape;
      v.flags = flags;
      const key = `${shape}|${tint}|${flags & (F_CORE_SHAPE | F_CORPSE)}`;
      v.tint = tint;
      if (key !== v.key) {
        v.key = key;
        this.build(v);
      }
      v.scale = ents[o + O.scale];
      v.squash = ents[o + O.squash];
      v.ring = ents[o + O.ring];
      v.anim = ents[o + O.anim];
      v.mask = ents[o + O.mask];
      v.hp = ents[o + O.hp];
      v.seen = ents[o + O.seen] > 0;
      const w = ents[o + O.windup];
      if (w >= 0 && v.windup < 0) v.windupAt = now;
      if (w < 0 && v.windup >= 0) v.strike = 1;
      v.windup = w;
      const s: Sample = { t: tick, x: ents[o + O.x] * M, y: ents[o + O.y], z: ents[o + O.z] * M, yaw: ents[o + O.yaw], lift: ents[o + O.lift], roll: ents[o + O.roll] };
      if (full || !v.samples.length || v.lastFrame !== this.frameNo - 1) v.samples = [s];
      else {
        v.samples.push(s);
        if (v.samples.length > 5) v.samples.shift();
      }
      v.lastFrame = this.frameNo;
    }
    for (const [id, v] of this.views) {
      if (v.lastFrame !== this.frameNo) {
        this.group.remove(v.root);
        this.views.delete(id);
      }
    }
  }

  private interp(v: View) {
    const S = v.samples;
    const rt = this.renderTick;
    let a = S[0], b = S[0];
    for (let i = 0; i < S.length; i++) {
      if (S[i].t <= rt) a = S[i];
      if (S[i].t >= rt) { b = S[i]; break; }
      b = S[i];
    }
    const span = b.t - a.t;
    const k = span > 0 ? Math.min(1, Math.max(0, (rt - a.t) / span)) : 1;
    const px = v.pos.x, pz = v.pos.z;
    v.pos.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
    let dy = b.yaw - a.yaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    v.yaw = a.yaw + dy * k;
    v.lift = a.lift + (b.lift - a.lift) * k;
    v.roll = a.roll + (b.roll - a.roll) * k;
    return Math.hypot(v.pos.x - px, v.pos.z - pz);
  }

  /** Per frame: advance the render clock, interpolate, animate. eye = camera position (m). */
  private poseLast = new THREE.Vector3();

  /** Per frame. champPose (third person): draw the champion where the client predicts him, not where the sim last was. */
  update(dt: number, t: number, eye: THREE.Vector3, night: number, champId: number | null, champPose: ChampPose | null = null) {
    // a smoothed sim clock: 10 ticks/s, pulled toward the newest tick
    this.tickClock += dt * 10;
    const err = this.latestTick - this.tickClock;
    if (Math.abs(err) > 4) this.tickClock = this.latestTick;
    else this.tickClock += err * Math.min(1, dt * 2);
    this.renderTick = this.tickClock - 1.5;
    for (const v of this.views.values()) {
      let moved = this.interp(v);
      const posed = champPose !== null && v.id === champId;
      if (posed) {
        moved = Math.hypot(champPose.x - this.poseLast.x, champPose.z - this.poseLast.z);
        this.poseLast.set(champPose.x, champPose.y, champPose.z);
        v.pos.copy(this.poseLast);
        v.yaw = champPose.yaw;
      }
      v.speed = v.speed * 0.8 + (dt > 0 ? moved / dt : 0) * 0.2;
      const hideChamp = (v.flags & F_CHAMPION) !== 0 && champId === v.id && !posed;
      const dist = v.pos.distanceTo(eye);
      v.root.visible = !hideChamp && dist < (v.rig ? 150 : 160);
      if (!v.root.visible) continue;
      v.root.position.set(v.pos.x, v.pos.y + v.lift, v.pos.z);
      v.root.rotation.y = v.yaw;
      if (v.strike > 0) v.strike = Math.max(0, v.strike - dt * 4);
      if (v.rig) {
        const r = v.rig;
        const k = SHAPE_M * v.scale;
        r.root.scale.set(k, k * v.squash, k);
        // lying down: roll onto the side, raised by the body's half-thickness
        r.pose.rotation.z = v.roll * Math.PI * 0.5;
        r.pose.position.y = v.roll * 0.12 + r.hover * (v.anim === ANIM.dead || v.anim === ANIM.downed || v.anim === ANIM.bound ? 0 : 1);
        const windup = v.windup >= 0 ? Math.min(1, v.windup + (performance.now() - v.windupAt) / 800) : 0;
        r.update(dt, t, v.anim, v.speed / k, windup, v.strike, v.mask);
        const shadows = dist < 40;
        if (r.castShadow !== shadows) {
          r.castShadow = shadows;
          r.root.traverse((o) => ((o as THREE.Mesh).castShadow = shadows));
        }
      } else {
        const k = SHAPE_M * v.scale;
        v.root.scale.set(k, k * v.squash, k);
        v.root.rotation.z = v.roll * Math.PI * 0.5;
        for (const { mesh, part } of v.shapeParts) {
          mesh.position.set(part.pos[0], part.pos[1], part.pos[2]);
          mesh.scale.set(part.size[0], part.size[1], part.size[2]);
          const r = part.rot;
          mesh.rotation.set(r ? r[0] * DEG : 0, r ? r[1] * DEG : 0, r ? r[2] * DEG : 0);
          const a = part.anim;
          if (a) {
            const ph = t * a.speed + v.phase;
            switch (a.type) {
              case 'bob': mesh.position.y += Math.sin(ph) * a.amount; break;
              case 'spin': mesh.rotation.y += ph; break;
              case 'pulse': mesh.scale.multiplyScalar(1 + Math.sin(ph) * a.amount); break;
              case 'sway': mesh.rotation.z += Math.sin(ph) * a.amount; break;
            }
          }
        }
      }
    }
    void night;
  }

  heightOf(id: number): number {
    const v = this.views.get(id);
    if (!v) return 1.8;
    if (v.flags & F_HUMAN) return 1.8 * v.scale;
    const arch = this.archOf(v);
    if (arch) return hitBox(arch, v.scale).hgt;
    return SHAPE_M * v.scale * 0.6;
  }

  positionOf(id: number): THREE.Vector3 | null {
    const v = this.views.get(id);
    return v ? v.pos : null;
  }

  /**
   * The look target (spec §3.2): the nearest entity box the ray enters within `max` m. Ground-lying things
   * (downed, bound, corpses) also count within 3 m of the eye and 25° of the view.
   */
  pick(eye: THREE.Vector3, dir: THREE.Vector3, max: number, champId: number | null): { id: number; t: number; h: number; s: number; f: number } | null {
    let best: { id: number; t: number; h: number; s: number; f: number } | null = null;
    for (const v of this.views.values()) {
      if (v.id === champId || !v.root.visible) continue;
      const interesting = v.flags & (F_INHABITANT | F_CORPSE | F_HITTABLE | F_ITEM);
      if (!interesting) continue;
      const lying = (v.flags & (F_DOWNED | F_BOUND | F_CORPSE)) !== 0;
      const box = this.boxOf(v, lying);
      const hit = rayBox(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, v.pos.x, v.pos.y + v.lift, v.pos.z, v.yaw, box, lying ? 0.35 : 0.08);
      if (hit && hit.t <= max && (!best || hit.t < best.t)) best = { id: v.id, ...hit };
    }
    if (best) return best;
    // things on the ground near your feet
    let near: { id: number; t: number; h: number; s: number; f: number } | null = null, bestAng = 25 * DEG;
    for (const v of this.views.values()) {
      if (!(v.flags & (F_DOWNED | F_BOUND | F_CORPSE | F_ITEM))) continue;
      const dx = v.pos.x - eye.x, dy = v.pos.y + 0.3 - eye.y, dz = v.pos.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      const reach = 3 + this.boxOf(v, true).len;
      if (d > reach + 1.7) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * dir.x + dy * dir.y + dz * dir.z) / Math.max(0.01, d))));
      if (ang < bestAng) { bestAng = ang; near = { id: v.id, t: d, h: 0.5, s: 0, f: 0 }; }
    }
    return near;
  }

  boxOf(v: View, lying = false) {
    if (v.flags & F_ITEM) return v.shape === 'spear-up' ? { len: 0.15, wid: 0.15, hgt: 2.4 } : { len: 1.2, wid: 0.2, hgt: 0.3 };
    const arch = this.archOf(v);
    let b = (v.flags & F_HUMAN) ? { len: 0.25, wid: 0.3, hgt: 1.8 * v.scale } : arch ? hitBox(arch, v.scale) : { len: 0.4 * SHAPE_M * v.scale, wid: 0.4 * SHAPE_M * v.scale, hgt: 0.6 * SHAPE_M * v.scale };
    if (lying) b = { len: Math.max(b.len, b.hgt / 2), wid: Math.max(b.wid, b.hgt / 2), hgt: Math.min(b.hgt, 0.8) };
    return b;
  }

  /** archetype (monster shape id) of a view, if it is a core monster */
  arch(id: number): string | null {
    const v = this.views.get(id);
    return v ? this.archOf(v) : null;
  }

  each(fn: (v: View) => void) {
    for (const v of this.views.values()) fn(v);
  }
}

void F_TELEGRAPH;
void F_DRAGGED;
void rigMat;
