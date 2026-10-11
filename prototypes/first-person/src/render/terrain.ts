// First-person terrain (spec §7.2–7.3): one heightmap mesh (a vertex every 4 m) from the shared ground function,
// a water plane, and instanced decoration per tile type. Units: meters; tile (x, z) → (x·8, z·8).
import * as THREE from 'three';
import type { TileTypeDef } from '../sim/types';
import { Ground, M, WATER_Y, NV } from '../sim/ground';
import { SIZE, TileGrid, CORE_TILES } from '../sim/world';
import type { TerrainState } from '../protocol';
import { buildFeatureMesh } from './feature-mesh';

const RES = 2; // vertices per tile
const N = NV;

function hash(i: number, salt = 0) {
  let h = Math.imul(i ^ (0x9e3779b9 + salt * 0x632be5ab), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function patch(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number) => hash(((a & 1023) << 10) | (b & 1023), 11);
  return (h(ix, iz) * (1 - fx) + h(ix + 1, iz) * fx) * (1 - fz) + (h(ix, iz + 1) * (1 - fx) + h(ix + 1, iz + 1) * fx) * fz;
}

const FLAT = new Set(['wall', 'house', 'gate']);

interface DecorPart {
  geo: THREE.BufferGeometry;
  color: string;
  /** center height and size relative to the instance's size (m) */
  y: number;
  sx: number;
  sy: number;
  shadow?: boolean;
  /** thin blades lit like the ground */
  flat?: boolean;
}

interface DecorKind {
  tiles: string[];
  /** expected instances per tile */
  perTile: number;
  /** size range (m) */
  size: [number, number];
  parts: DecorPart[];
  tint?: number; // ± brightness jitter
  /** client-only collision radius (m) for an instance of this size, F32 */
  collide?: (size: number) => number;
}

const cone = new THREE.ConeGeometry(0.5, 1, 7);
const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const ico = new THREE.IcosahedronGeometry(0.5, 0);
const box = new THREE.BoxGeometry(1, 1, 1);

/** A tuft of thin leaning blades, unit height, with upward normals so it shades like the ground it grows from. */
function tuftGeometry(n: number) {
  const pos: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + k * 0.7, r = 0.12 + (k % 3) * 0.08, lean = 0.25 + (k % 2) * 0.2;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, w = 0.045;
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    const h = 0.75 + ((k * 37) % 5) * 0.06;
    const tip = [cx + Math.cos(a) * lean, h - 0.5, cz + Math.sin(a) * lean];
    // both windings, so each side is front-facing and keeps its upward normal
    pos.push(cx - px, -0.5, cz - pz, cx + px, -0.5, cz + pz, ...tip, cx + px, -0.5, cz + pz, cx - px, -0.5, cz - pz, ...tip);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return g;
}
const tuft = tuftGeometry(7);
const reeds = tuftGeometry(5);

// Colors follow media/concept-art/world-mood: blue-green olives with dark gnarled trunks, black-green cypress
// spires, sun-bleached golden grass and pale limestone.
const DECOR: DecorKind[] = [
  { tiles: ['cedar'], perTile: 2.4, size: [12, 18], collide: (z) => z * 0.025, parts: [
    { geo: cyl, color: '#3a2820', y: 0.1, sx: 0.035, sy: 0.2, shadow: true },
    { geo: cone, color: '#1e3a2c', y: 0.42, sx: 0.2, sy: 0.6, shadow: true },
    { geo: cone, color: '#24443a', y: 0.7, sx: 0.14, sy: 0.5, shadow: true },
  ] },
  { tiles: ['olive'], perTile: 3.5, size: [4, 5.5], collide: (z) => z * 0.05, parts: [
    { geo: cyl, color: '#3e2a22', y: 0.18, sx: 0.08, sy: 0.36, shadow: true },
    { geo: ico, color: '#4e7064', y: 0.6, sx: 0.85, sy: 0.55, shadow: true },
    { geo: ico, color: '#5a7e6e', y: 0.76, sx: 0.58, sy: 0.4, shadow: true },
  ] },
  { tiles: ['vineyard'], perTile: 8, size: [1.0, 1.3], parts: [
    { geo: cyl, color: '#4a3226', y: 0.5, sx: 0.05, sy: 1 },
    { geo: ico, color: '#5e7448', y: 0.7, sx: 0.8, sy: 0.5 },
  ] },
  { tiles: ['wheat'], perTile: 18, size: [0.9, 1.3], tint: 0.14, parts: [{ geo: tuft, color: '#e2aa4c', y: 0.5, sx: 0.7, sy: 1, flat: true }] },
  { tiles: ['grass', 'scrub'], perTile: 16, size: [0.5, 1.1], tint: 0.22, parts: [{ geo: tuft, color: '#d4a656', y: 0.5, sx: 1, sy: 1, flat: true }] },
  { tiles: ['scrub', 'wadi', 'grass'], perTile: 0.9, size: [0.6, 1.5], tint: 0.12, parts: [{ geo: ico, color: '#56705a', y: 0.4, sx: 1.2, sy: 0.75 }] },
  { tiles: ['rock', 'scrub'], perTile: 0.7, size: [1, 3.5], tint: 0.1, collide: (z) => (z > 1.6 ? z * 0.55 : 0), parts: [{ geo: ico, color: '#d6cdbd', y: 0.3, sx: 1.3, sy: 0.9, shadow: true }] },
  { tiles: ['salt'], perTile: 0.16, size: [2, 5], collide: (z) => z * 0.17, parts: [{ geo: cyl, color: '#f4f0e6', y: 0.5, sx: 0.35, sy: 1, shadow: true }] },
  { tiles: ['marsh'], perTile: 6, size: [1.2, 2.1], tint: 0.12, parts: [{ geo: reeds, color: '#bc8c4a', y: 0.5, sx: 0.5, sy: 1, flat: true }] },
  { tiles: ['ruin-floor'], perTile: 1.2, size: [0.8, 2], tint: 0.06, parts: [{ geo: box, color: '#d2c6aa', y: 0.35, sx: 1.4, sy: 0.7, shadow: true }] },
  { tiles: ['ruin-floor'], perTile: 0.2, size: [5, 9], collide: (z) => z * 0.09, parts: [{ geo: cyl, color: '#dcd0b4', y: 0.5, sx: 0.18, sy: 1, shadow: true }] },
  { tiles: ['shrine-floor'], perTile: 0.15, size: [2.5, 3.5], parts: [{ geo: box, color: '#a8a090', y: 0.5, sx: 0.4, sy: 1, shadow: true }] },
];

/** Ground colors for the first-person view (the sim's tile colors stay as the map's). */
const GROUND: Record<string, string> = {
  sand: '#e8d6a8',
  grass: '#c29c50',
  scrub: '#b09254',
  wheat: '#d2a04a',
  olive: '#9c8a4e',
  vineyard: '#94804a',
  cedar: '#7a6e48',
  rock: '#cfc4b0',
  wadi: '#c6a06e',
  salt: '#ece6d6',
  marsh: '#8a845a',
  'ruin-floor': '#cbbea2',
  road: '#d6c8a6',
  'shrine-floor': '#ddd2b8',
  cliff: '#b4a690',
};

export class Terrain {
  group = new THREE.Group();
  grid = new TileGrid();
  ground: Ground;
  defs = new Map<string, TileTypeDef>();
  private geo: THREE.BufferGeometry;
  private mesh: THREE.Mesh;
  private colors: Float32Array;
  private pos: Float32Array;
  water: THREE.Mesh;
  private decor = new THREE.Group();
  private decorDirty = false;
  private decorTimer = 0;
  private uTime = { value: 0 };
  ready = false;
  /** tile index → collision circles (tiles), for the controller */
  colliders = new Map<number, { x: number; z: number; r: number }[]>();
  onColliders: () => void = () => {};

  constructor() {
    for (const d of CORE_TILES) this.defs.set(d.id, d);
    this.ground = new Ground(this.grid);
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * N * 3);
    this.colors = new Float32Array(N * N * 3);
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let k = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      if ((i + j) & 1) { idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d; }
      else { idx[k++] = a; idx[k++] = c; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = b; }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    const wmat = new THREE.MeshLambertMaterial({ color: '#3ad2c2', transparent: true, opacity: 0.74 });
    wmat.onBeforeCompile = (s) => {
      s.uniforms.uTime = this.uTime;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vW;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vW;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nfloat sh = sin(vW.x * 0.21 + uTime * 0.9) * sin(vW.y * 0.17 - uTime * 0.7) + sin((vW.x + vW.y) * 0.05 + uTime * 0.4);\ngl_FragColor.rgb *= 0.94 + 0.06 * sh;');
    };
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), wmat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set((SIZE * M) / 2, WATER_Y, (SIZE * M) / 2);
    this.water.renderOrder = 1;
    this.group.add(this.water);
    this.group.add(this.decor);
  }

  setDefs(defs: TileTypeDef[]) {
    for (const d of defs) {
      this.defs.set(d.id, d);
      this.grid.defs.set(d.id, d);
    }
    this.grid.defsVersion++;
    if (this.ready) {
      this.ground.rebuild();
      this.rebuildAll();
    }
  }

  /** terraformer islands: spires, arches, floating isles (render/feature-mesh.ts) */
  private features: THREE.Mesh | null = null;
  private featuresKey = '';

  load(types: string[], elev: Float32Array, terrain: TerrainState = null) {
    this.grid.types = [...types];
    this.grid.elev = new Float32Array(elev);
    this.grid.base = terrain ? new Float32Array(terrain.base) : null;
    this.grid.orig = terrain ? new Float32Array(terrain.orig) : null;
    const key = terrain ? JSON.stringify(terrain.settings) : '';
    if (key !== this.featuresKey) {
      this.featuresKey = key;
      if (this.features) {
        this.group.remove(this.features);
        this.features.geometry.dispose();
        (this.features.material as THREE.Material).dispose();
        this.features = null;
      }
      if (terrain) this.group.add((this.features = buildFeatureMesh(terrain.settings)));
    }
    this.ground.rebuild();
    this.rebuildAll();
    this.ready = true;
  }

  private rebuildAll() {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) this.vertex(i, j);
    this.finish();
    this.buildDecor();
  }

  private finish() {
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }

  private c = new THREE.Color();
  private c2 = new THREE.Color();

  private tileColor(tx: number, tz: number, out: THREE.Color) {
    const t = this.grid.get(tx, tz);
    if (FLAT.has(t)) return out.set('#c8ae84');
    if (t === 'deep-water') return out.set('#1c8a8e');
    if (t === 'shallow-water') return out.set('#e0dcb0');
    return out.set(GROUND[t] ?? this.defs.get(t)?.color ?? '#b89448');
  }

  private vertex(i: number, j: number) {
    const x = i / RES, z = j / RES;
    const o = (j * N + i) * 3;
    this.pos[o] = x * M;
    this.pos[o + 1] = this.ground.v[j * N + i];
    this.pos[o + 2] = z * M;
    const gx = x - 0.5, gz = z - 0.5;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    let r = 0, g = 0, b = 0;
    const add = (tx: number, tz: number, w: number) => {
      this.tileColor(tx, tz, this.c2);
      r += this.c2.r * w;
      g += this.c2.g * w;
      b += this.c2.b * w;
    };
    add(ix, iz, (1 - fx) * (1 - fz));
    add(ix + 1, iz, fx * (1 - fz));
    add(ix, iz + 1, (1 - fx) * fz);
    add(ix + 1, iz + 1, fx * fz);
    const p = patch(x / 3.5, z / 3.5) * 0.65 + patch(x / 1.2 + 40, z / 1.2) * 0.35;
    const n = 0.97 + hash(j * N + i, 7) * 0.06;
    const gy = this.ground;
    const slope = Math.abs(gy.y(x + 0.25, z) - gy.y(x - 0.25, z)) / 6 + Math.abs(gy.y(x, z + 0.25) - gy.y(x, z - 0.25)) / 6;
    this.c.setRGB(r, g, b);
    // sun-bleached and shadowed patches, as in the paintings' fields
    if (p > 0.55) this.c.lerp(this.c2.set('#e4cf98'), (p - 0.55) * 1.3);
    else if (p < 0.4) this.c.lerp(this.c2.set('#8a6a36'), (0.4 - p) * 1.1);
    this.c.lerp(this.c2.set('#c4b8a4'), Math.min(1, Math.max(0, slope - 0.4)));
    this.colors[o] = this.c.r * n;
    this.colors[o + 1] = this.c.g * n;
    this.colors[o + 2] = this.c.b * n;
  }

  /** Changed tiles from the sim. */
  updateTiles(changes: [number, string][]) {
    if (!changes.length) return;
    for (const [i, t] of changes) this.grid.types[i] = t;
    const [i0, i1, j0, j1] = this.ground.update(changes.map(([i]) => i));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.vertex(i, j);
    this.finish();
    this.decorDirty = true;
  }

  private buildDecor() {
    for (const c of [...this.decor.children]) {
      this.decor.remove(c);
      (c as THREE.InstancedMesh).dispose?.();
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    this.colliders.clear();
    for (const [ki, kind] of DECOR.entries()) {
      const tiles = new Set(kind.tiles);
      const inst: { x: number; z: number; y: number; size: number; rot: number; tint: number }[] = [];
      for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
        const i = z * SIZE + x;
        if (!tiles.has(this.grid.types[i])) continue;
        const count = Math.floor(kind.perTile) + (hash(i, 100 + ki) < kind.perTile % 1 ? 1 : 0);
        for (let k = 0; k < count; k++) {
          const h1 = hash(i * 31 + k, 200 + ki), h2 = hash(i * 31 + k, 300 + ki), h3 = hash(i * 31 + k, 400 + ki);
          const px = x + 0.5 + (h1 - 0.5) * 0.9, pz = z + 0.5 + (h2 - 0.5) * 0.9;
          inst.push({ x: px, z: pz, y: this.ground.y(px, pz), size: kind.size[0] + (kind.size[1] - kind.size[0]) * h3, rot: h1 * 6.283, tint: (kind.tint ?? 0.05) * (h2 * 2 - 1) });
        }
      }
      if (!inst.length) continue;
      if (kind.collide) {
        for (const it of inst) {
          const r = kind.collide(it.size) / M;
          if (r <= 0) continue;
          // register in every tile the circle touches
          for (let tz = Math.floor(it.z - r - 0.05); tz <= Math.floor(it.z + r + 0.05); tz++) for (let tx = Math.floor(it.x - r - 0.05); tx <= Math.floor(it.x + r + 0.05); tx++) {
            const k = tz * SIZE + tx;
            let l = this.colliders.get(k);
            if (!l) this.colliders.set(k, (l = []));
            l.push({ x: it.x, z: it.z, r });
          }
        }
      }
      for (const part of kind.parts) {
        const im = new THREE.InstancedMesh(part.geo, new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: !part.flat }), inst.length);
        im.castShadow = !!part.shadow;
        im.receiveShadow = true;
        for (const [n, it] of inst.entries()) {
          q.setFromAxisAngle(up, it.rot);
          s.set(part.sx * it.size, part.sy * it.size, part.sx * it.size);
          p.set(it.x * M, it.y + part.y * it.size - 0.1, it.z * M);
          m4.compose(p, q, s);
          im.setMatrixAt(n, m4);
          im.setColorAt(n, col.set(part.color).multiplyScalar(1 + it.tint));
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        this.decor.add(im);
      }
    }
    this.onColliders();
  }

  update(dt: number, t: number) {
    this.uTime.value = t;
    if (this.decorDirty) {
      this.decorTimer += dt;
      if (this.decorTimer > 1) {
        this.decorDirty = false;
        this.decorTimer = 0;
        this.buildDecor();
      }
    }
  }

  y(x: number, z: number) {
    return this.ground.y(x, z);
  }

  tileAt(x: number, z: number): string {
    return this.grid.get(Math.floor(x), Math.floor(z));
  }
}
