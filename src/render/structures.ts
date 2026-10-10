// Static structures (spec §7.4), built once from the tiles and the island layout: houses, walls, gates, altars, the
// fold, the granary, the High Place and the six lair landmarks. Meters.
import * as THREE from 'three';
import { M } from '../sim/ground';
import type { Terrain } from './terrain';
import type { IslandLayout } from '../sim/island-gen';
import { SIZE } from '../sim/world';

interface P { x: number; z: number }

const mats = new Map<string, THREE.MeshLambertMaterial>();
function mat(c: string, e = 0): THREE.MeshLambertMaterial {
  const k = c + e;
  let m = mats.get(k);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    if (e) {
      m.emissive = new THREE.Color(c);
      m.emissiveIntensity = e;
    }
    mats.set(k, m);
  }
  return m;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const CONE = new THREE.ConeGeometry(0.5, 1, 8);
const SPH = new THREE.SphereGeometry(0.5, 10, 7);

function put(g: THREE.Object3D, geo: THREE.BufferGeometry, color: string, size: [number, number, number], pos: [number, number, number], rotY = 0, e = 0) {
  const m = new THREE.Mesh(geo, mat(color, e));
  m.scale.set(...size);
  m.position.set(...pos);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

export interface Fire {
  pos: THREE.Vector3;
  light?: THREE.PointLight;
  flame: THREE.Mesh;
  role: string;
}

export class Structures {
  group = new THREE.Group();
  fires: Fire[] = [];
  lairGlow = new Map<number, THREE.Mesh>();
  braziers: THREE.Mesh[] = [];
  foldLambs: THREE.Group[] = [];
  altarPos = new THREE.Vector3();
  highAltarPos = new THREE.Vector3();

  build(t: Terrain, L: IslandLayout) {
    this.group.clear();
    this.fires = [];
    this.lairGlow.clear();
    this.braziers = [];
    this.foldLambs = [];
    const y = (x: number, z: number) => t.y(x, z);
    const V = L.village;

    // walls: instanced blocks + crenellations
    const walls: P[] = [], gates: P[] = [], houses: P[] = [];
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
      const ty = t.grid.types[z * SIZE + x];
      if (ty === 'wall') walls.push({ x, z });
      else if (ty === 'gate') gates.push({ x, z });
      else if (ty === 'house') houses.push({ x, z });
    }
    if (walls.length) {
      const im = new THREE.InstancedMesh(BOX, mat('#b09068'), walls.length);
      const cren = new THREE.InstancedMesh(BOX, mat('#a08060'), walls.length * 4);
      const m4 = new THREE.Matrix4();
      let c = 0;
      for (const [i, w] of walls.entries()) {
        const gy = y(w.x + 0.5, w.z + 0.5);
        m4.compose(new THREE.Vector3((w.x + 0.5) * M, gy + 1.5, (w.z + 0.5) * M), new THREE.Quaternion(), new THREE.Vector3(M, 7, M));
        im.setMatrixAt(i, m4);
        // merlons along the outer edge (away from the village)
        const ax = w.x + 0.5 - V.x - 0.5, az = w.z + 0.5 - V.z - 0.5, al = Math.hypot(ax, az) || 1;
        for (let k = 0; k < 4; k++) {
          const along = (k - 1.5) * 2;
          const px = (w.x + 0.5 + (ax / al) * 0.42) * M - (az / al) * along;
          const pz = (w.z + 0.5 + (az / al) * 0.42) * M + (ax / al) * along;
          m4.compose(new THREE.Vector3(px, gy + 5.4, pz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(ax, az)), new THREE.Vector3(1.1, 0.9, 0.7));
          cren.setMatrixAt(c++, m4);
        }
      }
      im.castShadow = im.receiveShadow = true;
      cren.castShadow = true;
      im.computeBoundingSphere();
      cren.computeBoundingSphere();
      this.group.add(im, cren);
    }
    // gates: a pillar on each side and a lintel
    for (const g of gates) {
      const gy = y(g.x + 0.5, g.z + 0.5);
      const ax = g.x + 0.5 - V.x - 0.5, az = g.z + 0.5 - V.z - 0.5;
      const yaw = Math.atan2(ax, az);
      const grp = new THREE.Group();
      grp.position.set((g.x + 0.5) * M, gy, (g.z + 0.5) * M);
      grp.rotation.y = yaw;
      put(grp, BOX, '#9a8a70', [1.6, 6, 1.6], [3.4, 3, 0]);
      put(grp, BOX, '#9a8a70', [1.6, 6, 1.6], [-3.4, 3, 0]);
      put(grp, BOX, '#6a4a2a', [8.4, 0.8, 1.2], [0, 6.2, 0]);
      this.group.add(grp);
    }
    // houses: mudbrick, flat roof, parapet, a dark doorway facing the street
    for (const h of houses) {
      const gy = y(h.x + 0.5, h.z + 0.5);
      const grp = new THREE.Group();
      grp.position.set((h.x + 0.5) * M, gy, (h.z + 0.5) * M);
      grp.rotation.y = Math.atan2(V.x - h.x, V.z - h.z);
      const hh = 3.2 + (((h.x * 7 + h.z * 13) % 5) / 5) * 0.8;
      put(grp, BOX, '#c9a77c', [6.4, hh, 6.4], [0, hh / 2, 0]);
      put(grp, BOX, '#8a6a4a', [6.8, 0.3, 6.8], [0, hh + 0.15, 0]);
      put(grp, BOX, '#b8956a', [6.8, 0.5, 0.3], [0, hh + 0.5, 3.25]);
      put(grp, BOX, '#b8956a', [6.8, 0.5, 0.3], [0, hh + 0.5, -3.25]);
      put(grp, BOX, '#2a1c12', [1.1, 2.0, 0.1], [0.8, 1.0, 3.21]);
      put(grp, BOX, '#3a2a1c', [0.6, 0.5, 0.1], [-1.6, 2.0, 3.21]);
      if ((h.x + h.z) % 3 === 0) put(grp, BOX, '#c0a070', [2, 1.2, 2], [-1.6, hh + 0.75, -1.6]);
      this.group.add(grp);
    }
    // the village altar: dressed stone, four horns, a fire
    {
      const A = L.villageAltar;
      const ax = A.x + 0.5, az = A.z + 0.5, gy = y(ax, az);
      const grp = new THREE.Group();
      grp.position.set(ax * M, gy, az * M);
      put(grp, BOX, '#d0c4a8', [3.2, 0.4, 3.2], [0, 0.2, 0]);
      put(grp, BOX, '#c8b898', [2.2, 1.1, 2.2], [0, 0.95, 0]);
      for (const [hx, hz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) put(grp, CONE, '#c8b898', [0.3, 0.45, 0.3], [hx * 0.95, 1.7, hz * 0.95]);
      const flame = put(grp, CONE, '#ffa030', [0.9, 1.3, 0.9], [0, 2.1, 0], 0, 1.5);
      flame.castShadow = false;
      this.group.add(grp);
      this.altarPos.set(ax * M, gy + 2.2, az * M);
      this.fires.push({ pos: this.altarPos.clone(), flame, role: 'village-altar' });
    }
    // the fold: a low stone pen with lambs
    {
      const F = L.fold;
      const fx = F.x + 0.5, fz = F.z + 0.5, gy = y(fx, fz);
      const grp = new THREE.Group();
      grp.position.set(fx * M, gy, fz * M);
      for (const [sx, sz, w, d] of [[0, 3.4, 7, 0.6], [0, -3.4, 7, 0.6], [3.4, 0, 0.6, 7], [-3.4, 1.6, 0.6, 3.8]] as const) put(grp, BOX, '#9a9080', [w, 1.0, d], [sx, 0.5, sz]);
      for (let k = 0; k < 6; k++) {
        const lamb = new THREE.Group();
        lamb.position.set(-2 + (k % 3) * 2, 0, -1.2 + Math.floor(k / 3) * 2.2);
        lamb.rotation.y = k * 1.3;
        put(lamb, SPH, '#f0ece0', [0.9, 0.6, 1.2], [0, 0.6, 0]);
        put(lamb, SPH, '#3a3028', [0.35, 0.35, 0.4], [0, 0.8, 0.6]);
        for (const [lx, lz] of [[0.25, 0.35], [-0.25, 0.35], [0.25, -0.35], [-0.25, -0.35]]) put(lamb, BOX, '#3a3028', [0.1, 0.4, 0.1], [lx, 0.2, lz]);
        grp.add(lamb);
        this.foldLambs.push(lamb);
      }
      this.group.add(grp);
    }
    // the granary
    {
      const G = L.granary;
      const gx = G.x + 0.5, gz = G.z + 0.5, gy = y(gx, gz);
      put(this.group, CYL, '#c8a878', [5, 4.5, 5], [gx * M, gy + 2.25, gz * M]);
      put(this.group, SPH, '#b89868', [5, 2.6, 5], [gx * M, gy + 4.5, gz * M]);
    }
    // guard braziers
    for (const gp of L.guardPosts) {
      const px = gp.x + 0.5, pz = gp.z + 0.5, gy = y(px, pz);
      put(this.group, CYL, '#4a3a2a', [0.15, 2.4, 0.15], [px * M + 1.5, gy + 1.2, pz * M]);
      put(this.group, CYL, '#6a5a4a', [0.7, 0.3, 0.7], [px * M + 1.5, gy + 2.45, pz * M]);
      const f = put(this.group, CONE, '#ffa030', [0.5, 0.8, 0.5], [px * M + 1.5, gy + 2.9, pz * M], 0, 1.4);
      f.castShadow = false;
      this.braziers.push(f);
    }
    // the High Place: stone table with horns, standing stones, fire
    {
      const A = L.highAltar;
      const ax = A.x + 0.5, az = A.z + 0.5, gy = y(ax, az);
      const grp = new THREE.Group();
      grp.position.set(ax * M, gy, az * M);
      put(grp, BOX, '#6a645c', [3.6, 1.2, 2.2], [0, 0.6, 0]);
      for (const hx of [-1.5, 1.5]) for (const hz of [-0.9, 0.9]) put(grp, CONE, '#d8ccb0', [0.25, 0.8, 0.25], [hx, 1.6, hz]);
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2;
        put(grp, BOX, '#7a746a', [1.2, 3.5 + (k % 3), 0.8], [Math.cos(a) * 9, 1.8, Math.sin(a) * 9], -a);
      }
      const flame = put(grp, CONE, '#c03020', [0.8, 1.2, 0.8], [0, 1.8, 0], 0, 1.4);
      flame.castShadow = false;
      this.group.add(grp);
      this.highAltarPos.set(ax * M, gy + 1.8, az * M);
      this.fires.push({ pos: this.highAltarPos.clone(), flame, role: 'high-altar' });
    }
    // lairs
    for (let r = 1; r <= 6; r++) {
      const p = L.lairs[r];
      if (!p) continue;
      const lx = p.x + 0.5, lz = p.z + 0.5, gy = y(lx, lz);
      const grp = new THREE.Group();
      grp.position.set(lx * M, gy, lz * M);
      grp.rotation.y = Math.atan2(L.center.x - p.x, L.center.z - p.z);
      const mouth = (w: number, h: number, z = 0) => put(grp, BOX, '#0a0806', [w, h, 0.3], [0, h / 2, z]);
      switch (r) {
        case 1: { // giant cedar with a cave between its roots
          put(grp, CYL, '#3e2c1e', [3.2, 22, 3.2], [0, 11, -3]);
          put(grp, CONE, '#1c4426', [18, 12, 18], [0, 22, -3]);
          put(grp, CONE, '#22502c', [13, 10, 13], [0, 28, -3]);
          put(grp, CONE, '#28583a', [8, 8, 8], [0, 33, -3]);
          for (let k = 0; k < 5; k++) put(grp, CYL, '#3e2c1e', [0.8, 5, 0.8], [Math.cos(k * 1.3) * 2.5, 1, -3 + Math.sin(k * 1.3) * 2.5]).rotation.z = 0.9;
          put(grp, SPH, '#5a5048', [6, 4, 4], [0, 1, -1.2]);
          mouth(2.2, 2, 0.8);
          break;
        }
        case 2: { // wine-press cave in a terrace wall
          put(grp, BOX, '#9a8a70', [9, 4, 3], [0, 2, -1.5]);
          put(grp, CYL, '#a89878', [3, 0.8, 3], [3, 0.4, 2]);
          put(grp, CYL, '#6a4a2a', [0.4, 2.5, 0.4], [3, 1.6, 2]);
          mouth(2.2, 2.4, 0.05);
          break;
        }
        case 3: { // sunken cistern
          put(grp, CYL, '#9a9284', [7, 1, 7], [0, 0.3, 0]);
          put(grp, CYL, '#101818', [5.6, 1.1, 5.6], [0, 0.32, 0]);
          for (let k = 0; k < 3; k++) put(grp, BOX, '#8a8274', [1.4, 0.3, 0.8], [3.6 + k * 0.6, 0.2 - k * 0.15, 0]);
          break;
        }
        case 4: { // cliff tomb: a rock face with a square door
          put(grp, BOX, '#9a8e7e', [12, 9, 4], [0, 4.5, -2.2]);
          put(grp, BOX, '#8a7e6e', [7, 5, 3], [3, 11, -2.5]);
          put(grp, BOX, '#c0b49c', [3.2, 3.6, 0.3], [0, 1.8, -0.1]);
          mouth(2.2, 2.8, 0.1);
          break;
        }
        case 5: { // ruined giant's hall
          for (const cx of [-5, 0, 5]) put(grp, CYL, '#c0b498', [1.8, 12, 1.8], [cx, 6, -2]);
          put(grp, BOX, '#b0a488', [13, 1.6, 2.4], [-1.5, 12.6, -2]).rotation.z = 0.08;
          put(grp, BOX, '#b0a488', [4, 3, 3], [4, 1.5, 3]).rotation.y = 0.5;
          mouth(3, 3.2, -2);
          break;
        }
        case 6: { // catacomb stair beside the shrine
          put(grp, BOX, '#7a746a', [3.6, 0.6, 4.4], [0, 0.3, 0]);
          put(grp, BOX, '#0a0806', [2.4, 0.62, 3], [0, 0.32, 0.2]);
          put(grp, BOX, '#6a645c', [0.5, 2.4, 0.5], [1.6, 1.2, -2]);
          put(grp, BOX, '#6a645c', [0.5, 2.4, 0.5], [-1.6, 1.2, -2]);
          break;
        }
      }
      const glow = put(grp, SPH, '#ff5020', [0.4, 0.25, 0.1], [0.4, 1.2, 0.8], 0, 2);
      glow.castShadow = false;
      glow.visible = false;
      this.lairGlow.set(r, glow);
      this.group.add(grp);
    }
  }

  /** Per-frame: flames flicker, braziers lit at night, lamb count, lair eyes. */
  update(t: number, night: number, fold: number, lairsHome: Set<number>) {
    for (const f of this.fires) f.flame.scale.y = 1.3 * (1 + Math.sin(t * 11 + f.pos.x) * 0.1 + Math.sin(t * 17) * 0.06);
    for (const b of this.braziers) {
      b.visible = night > 0.35;
      b.scale.y = 0.8 * (1 + Math.sin(t * 13 + b.position.x) * 0.12);
    }
    for (const [i, l] of this.foldLambs.entries()) l.visible = i < fold;
    for (const [r, g] of this.lairGlow) g.visible = lairsHome.has(r) && night > 0.3;
  }
}
