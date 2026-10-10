import * as THREE from 'three';
import type { ShapeDef, ShapePart } from '../sim/types';

const DEG = Math.PI / 180;

const PRIMS: Record<ShapePart['prim'], THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 10, 7),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
};

interface PartInst {
  mesh: THREE.Mesh;
  part: ShapePart;
}

export interface EntityVis {
  id: number;
  group: THREE.Group;
  parts: PartInst[];
  shapeIdx: number;
  tint: number;
  // interpolation
  px: number; py: number; pz: number; pyaw: number;
  x: number; y: number; z: number; yaw: number;
  scale: number;
  inhabitant: boolean;
  phase: number;
  seen: number;
}

export class ShapeRenderer {
  group = new THREE.Group();
  shapes: ShapeDef[] = [];
  shapeIds: string[] = [];
  ents = new Map<number, EntityVis>();
  private mats = new Map<string, THREE.MeshLambertMaterial>();
  private emissiveMats: { mat: THREE.MeshLambertMaterial; strength: number }[] = [];
  private frameNo = 0;

  setDefs(shapeIds: string[], shapes: Map<string, ShapeDef>) {
    this.shapeIds = shapeIds;
    this.shapes = shapeIds.map((id) => shapes.get(id)!);
    // rebuild every entity: indices may have shifted
    for (const v of this.ents.values()) v.shapeIdx = -2;
  }

  private material(color: string, emissive: number, opacity: number): THREE.MeshLambertMaterial {
    const key = `${color}|${emissive}|${opacity}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, flatShading: true, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
      if (emissive > 0) {
        m.emissive = new THREE.Color(color);
        m.emissiveIntensity = emissive;
        this.emissiveMats.push({ mat: m, strength: emissive });
      }
      this.mats.set(key, m);
    }
    return m;
  }

  private build(v: EntityVis) {
    for (const p of v.parts) v.group.remove(p.mesh);
    v.parts = [];
    const def = this.shapes[v.shapeIdx];
    if (!def) return;
    const tint = '#' + v.tint.toString(16).padStart(6, '0');
    for (const part of def.parts) {
      const color = part.color === 'tint' ? tint : part.color;
      const mesh = new THREE.Mesh(PRIMS[part.prim], this.material(color, part.emissive ?? 0, part.opacity ?? 1));
      mesh.castShadow = true;
      mesh.userData.entityId = v.id;
      v.group.add(mesh);
      v.parts.push({ mesh, part });
    }
  }

  /** Apply a frame: [id, shapeIdx, x, y, z, yaw, tint, scale, flags] per entity. */
  applyFrame(ents: Float32Array, stride: number, snap: boolean) {
    this.frameNo++;
    for (let o = 0; o < ents.length; o += stride) {
      const id = ents[o], shapeIdx = ents[o + 1];
      let v = this.ents.get(id);
      if (!v) {
        const group = new THREE.Group();
        v = { id, group, parts: [], shapeIdx: -2, tint: -1, px: ents[o + 2], py: ents[o + 3], pz: ents[o + 4], pyaw: ents[o + 5], x: 0, y: 0, z: 0, yaw: 0, scale: 1, inhabitant: false, phase: (id * 0.618) % 1, seen: 0 };
        this.ents.set(id, v);
        this.group.add(group);
        snap = true;
      }
      if (snap) {
        v.px = ents[o + 2];
        v.py = ents[o + 3];
        v.pz = ents[o + 4];
        v.pyaw = ents[o + 5];
      } else {
        v.px = v.x;
        v.py = v.y;
        v.pz = v.z;
        v.pyaw = v.yaw;
      }
      v.x = ents[o + 2];
      v.y = ents[o + 3];
      v.z = ents[o + 4];
      v.yaw = ents[o + 5];
      v.scale = ents[o + 7];
      v.inhabitant = ents[o + 8] === 1;
      const tint = ents[o + 6];
      if (shapeIdx !== v.shapeIdx || tint !== v.tint) {
        v.shapeIdx = shapeIdx;
        v.tint = tint;
        this.build(v);
      }
      v.seen = this.frameNo;
    }
    for (const [id, v] of this.ents) {
      if (v.seen !== this.frameNo) {
        this.group.remove(v.group);
        this.ents.delete(id);
      }
    }
  }

  /** alpha in [0,1] between the previous and current frame; t in seconds; night in [0,1]. */
  update(alpha: number, t: number, night: number) {
    for (const v of this.ents.values()) {
      const x = v.px + (v.x - v.px) * alpha;
      const y = v.py + (v.y - v.py) * alpha;
      const z = v.pz + (v.z - v.pz) * alpha;
      let dyaw = v.yaw - v.pyaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      v.group.position.set(x, y, z);
      v.group.rotation.y = v.pyaw + dyaw * Math.min(1, alpha * 1.5);
      v.group.scale.setScalar(v.scale);
      const moving = Math.abs(v.x - v.px) + Math.abs(v.z - v.pz) > 0.001;
      for (const { mesh, part } of v.parts) {
        mesh.position.set(part.pos[0], part.pos[1], part.pos[2]);
        mesh.scale.set(part.size[0], part.size[1], part.size[2]);
        const r = part.rot;
        mesh.rotation.set(r ? r[0] * DEG : 0, r ? r[1] * DEG : 0, r ? r[2] * DEG : 0);
        const a = part.anim;
        if (a) {
          const ph = t * a.speed + v.phase * Math.PI * 2;
          switch (a.type) {
            case 'bob': mesh.position.y += Math.sin(ph) * a.amount * (v.inhabitant && !moving ? 0.4 : 1); break;
            case 'spin': mesh.rotation.y += ph; break;
            case 'pulse': mesh.scale.multiplyScalar(1 + Math.sin(ph) * a.amount); break;
            case 'sway': mesh.rotation.z += Math.sin(ph) * a.amount; break;
          }
        }
        if (v.inhabitant && moving) mesh.position.y += Math.abs(Math.sin(t * 9 + v.phase * 6)) * 0.05;
      }
    }
    const glow = 0.35 + 0.65 * night;
    for (const { mat, strength } of this.emissiveMats) mat.emissiveIntensity = strength * glow;
  }

  pick(raycaster: THREE.Raycaster): number | null {
    const hits = raycaster.intersectObject(this.group, true);
    for (const h of hits) if (h.object.userData.entityId !== undefined) return h.object.userData.entityId;
    return null;
  }

  positionOf(id: number): THREE.Vector3 | null {
    const v = this.ents.get(id);
    return v ? v.group.position : null;
  }

  heightOf(id: number): number {
    const v = this.ents.get(id);
    if (!v) return 1;
    const def = this.shapes[v.shapeIdx];
    let top = 0.8;
    if (def) for (const p of def.parts) top = Math.max(top, p.pos[1] + p.size[1] / 2);
    return top * v.scale;
  }
}
