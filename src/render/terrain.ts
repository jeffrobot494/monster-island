import * as THREE from 'three';
import type { TileTypeDef } from '../sim/types';

const SIZE = 128;
const CHUNK = 16;
const BOTTOM = -1.6;
const ELEV = new Set(['rock', 'shrine-floor']);

function hash(i: number, salt = 0) {
  let h = Math.imul(i ^ (0x9e3779b9 + salt * 0x632be5ab), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Fog of war as a texture (R34): geometry never rebuilds when tiles are explored. */
export class Fog {
  data = new Uint8Array(SIZE * SIZE);
  tex: THREE.DataTexture;
  uniform: { value: THREE.DataTexture };
  reveal = { value: 0 };
  constructor() {
    this.tex = new THREE.DataTexture(this.data, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.uniform = { value: this.tex };
  }
  load(explored: Uint8Array) {
    for (let i = 0; i < explored.length; i++) this.data[i] = explored[i] ? 255 : 0;
    this.tex.needsUpdate = true;
  }
  mark(idx: number[]) {
    if (!idx.length) return;
    for (const i of idx) this.data[i] = 255;
    this.tex.needsUpdate = true;
  }
  isExplored(x: number, z: number) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return false;
    return this.data[z * SIZE + x] > 0 || this.reveal.value > 0;
  }
  /** Patch a Lambert material so fragments outside explored tiles go dark. */
  patch(mat: THREE.Material, instanced = false) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFog = this.uniform;
      shader.uniforms.uReveal = this.reveal;
      const prior = (mat.userData.extraVertex as ((s: any) => void) | undefined);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFogXZ;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n{ vec4 wp = modelMatrix * ${instanced ? 'instanceMatrix * ' : ''}vec4(transformed, 1.0); vFogXZ = wp.xz; }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFog;\nuniform float uReveal;\nvarying vec2 vFogXZ;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nfloat fogE = max(uReveal, texture2D(uFog, vFogXZ / 128.0).r);\ngl_FragColor.rgb = mix(vec3(0.035, 0.04, 0.06), gl_FragColor.rgb, smoothstep(0.15, 0.85, fogE));');
      prior?.(shader);
    };
    mat.needsUpdate = true;
  }
}

interface DecorKind {
  tile: string;
  density: number;
  geo: THREE.BufferGeometry;
  colors: string[];
  scale: [number, number];
  y: number;
}

export class Terrain {
  group = new THREE.Group();
  types: string[] = [];
  elev: Float32Array<ArrayBufferLike> = new Float32Array(SIZE * SIZE);
  defs = new Map<string, TileTypeDef>();
  fog = new Fog();
  private chunks: (THREE.Mesh | null)[] = new Array((SIZE / CHUNK) ** 2).fill(null);
  material: THREE.MeshLambertMaterial;
  private uTime = { value: 0 };
  private decorMat: THREE.MeshLambertMaterial;
  private decor: THREE.InstancedMesh[] = [];
  private decorDirty = true;
  private kinds: DecorKind[];

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.userData.extraVertex = (shader: any) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWave;\nuniform float uTime;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += aWave * (sin(uTime * 1.6 + position.x * 0.9 + position.z * 0.7) * 0.035 + sin(uTime * 2.3 - position.x * 0.5 + position.z * 1.3) * 0.02);');
    };
    this.fog.patch(this.material);
    this.decorMat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.fog.patch(this.decorMat, true);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ color: '#1c4a74' }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(SIZE / 2, -0.62, SIZE / 2);
    this.group.add(sea);
    const cone = new THREE.ConeGeometry(0.34, 1.2, 6).translate(0, 0.75, 0);
    const cone2 = new THREE.ConeGeometry(0.26, 0.8, 6).translate(0, 1.3, 0);
    const trunk = new THREE.CylinderGeometry(0.06, 0.08, 0.3, 5).translate(0, 0.15, 0);
    this.kinds = [
      { tile: 'cedar', density: 0.6, geo: mergeGeos([cone, cone2, trunk]), colors: ['#24482a', '#2a5530', '#1f3f26'], scale: [0.8, 1.3], y: 0 },
      { tile: 'olive', density: 0.32, geo: mergeGeos([new THREE.IcosahedronGeometry(0.22, 0).scale(1, 0.75, 1).translate(0, 0.42, 0), new THREE.IcosahedronGeometry(0.16, 0).translate(0.12, 0.5, 0.06), new THREE.CylinderGeometry(0.035, 0.05, 0.3, 5).translate(0, 0.15, 0)]), colors: ['#5f7a3a', '#6a8240', '#56703a'], scale: [0.8, 1.15], y: 0 },
      { tile: 'vineyard', density: 0.9, geo: new THREE.BoxGeometry(0.8, 0.22, 0.14).translate(0, 0.11, 0), colors: ['#5a6a2a', '#6a702e'], scale: [0.9, 1.1], y: 0 },
      { tile: 'wheat', density: 0.5, geo: new THREE.ConeGeometry(0.12, 0.3, 4).translate(0, 0.15, 0), colors: ['#e8c860', '#d8b048'], scale: [0.8, 1.3], y: 0 },
      { tile: 'salt', density: 0.035, geo: new THREE.CylinderGeometry(0.12, 0.16, 0.9, 6).translate(0, 0.45, 0), colors: ['#f4f0e4', '#e8e2d2'], scale: [0.7, 1.5], y: 0 },
      { tile: 'ruin-floor', density: 0.14, geo: new THREE.BoxGeometry(0.45, 0.35, 0.3).translate(0, 0.17, 0), colors: ['#c8bca0', '#b0a488', '#d0c4a8'], scale: [0.7, 1.6], y: 0 },
      { tile: 'marsh', density: 0.3, geo: new THREE.ConeGeometry(0.05, 0.5, 3).translate(0, 0.25, 0), colors: ['#5a7a4a', '#6a8a50'], scale: [0.7, 1.3], y: 0 },
      { tile: 'rock', density: 0.12, geo: new THREE.DodecahedronGeometry(0.25, 0).translate(0, 0.1, 0), colors: ['#8a8278', '#7a7268'], scale: [0.6, 1.4], y: 0 },
      { tile: 'scrub', density: 0.1, geo: new THREE.IcosahedronGeometry(0.12, 0).translate(0, 0.08, 0), colors: ['#7a8040', '#6a7038', '#8a7a50'], scale: [0.6, 1.2], y: 0 },
    ];
  }

  setDefs(defs: TileTypeDef[]) {
    this.defs = new Map(defs.map((d) => [d.id, d]));
    if (this.types.length) this.rebuildAll();
  }

  load(types: string[], elev: Float32Array, explored: Uint8Array) {
    this.types = types;
    this.elev = elev;
    this.fog.load(explored);
    this.rebuildAll();
  }

  height(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return -0.6;
    const i = z * SIZE + x;
    const t = this.types[i];
    const base = this.defs.get(t)?.height ?? 0.2;
    if (ELEV.has(t)) return Math.max(base, this.elev[i]);
    return base;
  }

  applyChanges(changes: [number, string][]) {
    const dirty = new Set<number>();
    for (const [i, t] of changes) {
      this.types[i] = t;
      const x = i % SIZE, z = Math.floor(i / SIZE);
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;
        dirty.add(Math.floor(nz / CHUNK) * (SIZE / CHUNK) + Math.floor(nx / CHUNK));
      }
    }
    for (const c of dirty) this.buildChunk(c);
    if (changes.length) this.decorDirty = true;
  }

  update(time: number) {
    this.uTime.value = time;
    if (this.decorDirty && this.types.length) this.buildDecor();
  }

  private rebuildAll() {
    for (let c = 0; c < this.chunks.length; c++) this.buildChunk(c);
    this.decorDirty = true;
  }

  private buildDecor() {
    this.decorDirty = false;
    for (const m of this.decor) {
      this.group.remove(m);
      m.dispose();
    }
    this.decor = [];
    const mat4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    for (const k of this.kinds) {
      const spots: number[] = [];
      for (let i = 0; i < this.types.length; i++) if (this.types[i] === k.tile && hash(i, 7) < k.density) spots.push(i);
      if (!spots.length) continue;
      const mesh = new THREE.InstancedMesh(k.geo, this.decorMat, spots.length);
      spots.forEach((i, n) => {
        const x = i % SIZE, z = Math.floor(i / SIZE);
        const s = k.scale[0] + (k.scale[1] - k.scale[0]) * hash(i, 3);
        q.setFromAxisAngle(up, hash(i, 5) * Math.PI * 2);
        const vine = k.tile === 'vineyard';
        if (vine) q.setFromAxisAngle(up, Math.PI / 4);
        mat4.compose(new THREE.Vector3(x + 0.5 + (vine ? 0 : (hash(i, 1) - 0.5) * 0.5), this.height(x, z) + k.y, z + 0.5 + (vine ? 0 : (hash(i, 2) - 0.5) * 0.5)), q, new THREE.Vector3(s, s, s));
        mesh.setMatrixAt(n, mat4);
        color.set(k.colors[Math.floor(hash(i, 9) * k.colors.length)]);
        mesh.setColorAt(n, color);
      });
      mesh.castShadow = k.tile === 'cedar' || k.tile === 'olive';
      mesh.receiveShadow = true;
      this.decor.push(mesh);
      this.group.add(mesh);
    }
  }

  private buildChunk(c: number) {
    const cx = (c % (SIZE / CHUNK)) * CHUNK, cz = Math.floor(c / (SIZE / CHUNK)) * CHUNK;
    const pos: number[] = [], nor: number[] = [], col: number[] = [], wave: number[] = [];
    const color = new THREE.Color();
    const quad = (a: number[], b: number[], cc: number[], d: number[], n: number[], k: THREE.Color, w: number[]) => {
      for (const [p, wi] of [[a, 0], [b, 1], [cc, 2], [a, 0], [cc, 2], [d, 3]] as [number[], number][]) {
        pos.push(p[0], p[1], p[2]);
        nor.push(n[0], n[1], n[2]);
        col.push(k.r, k.g, k.b);
        wave.push(w[wi]);
      }
    };
    for (let z = cz; z < cz + CHUNK; z++) {
      for (let x = cx; x < cx + CHUNK; x++) {
        const i = z * SIZE + x;
        const t = this.types[i];
        const def = this.defs.get(t);
        const h = this.height(x, z);
        const isWater = t.includes('water') || (def ? !def.walkable && h < 0 : false);
        color.set(def?.color ?? '#ff00ff');
        const j = (hash(i) - 0.5) * (isWater ? 0.03 : 0.035);
        color.offsetHSL(0, 0, j);
        const w = isWater ? 1 : 0;
        quad([x, h, z + 1], [x + 1, h, z + 1], [x + 1, h, z], [x, h, z], [0, 1, 0], color, [w, w, w, w]);
        const side = color.clone().multiplyScalar(isWater ? 0.85 : 0.7);
        const sides: [number, number, number[][], number[]][] = [
          [x, z + 1, [[x, 0, z + 1], [x + 1, 0, z + 1]], [0, 0, 1]],
          [x, z - 1, [[x + 1, 0, z], [x, 0, z]], [0, 0, -1]],
          [x + 1, z, [[x + 1, 0, z + 1], [x + 1, 0, z]], [1, 0, 0]],
          [x - 1, z, [[x, 0, z], [x, 0, z + 1]], [-1, 0, 0]],
        ];
        for (const [nx, nz, [p0, p1], n] of sides) {
          const nh = nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE ? BOTTOM : this.height(nx, nz);
          if (nh >= h - 1e-4) continue;
          const lo = Math.max(BOTTOM, nh);
          quad([p0[0], lo, p0[2]], [p1[0], lo, p1[2]], [p1[0], h, p1[2]], [p0[0], h, p0[2]], n, side, [0, 0, w, w]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aWave', new THREE.Float32BufferAttribute(wave, 1));
    geo.computeBoundingSphere();
    const old = this.chunks[c];
    if (old) {
      old.geometry.dispose();
      old.geometry = geo;
    } else {
      const m = new THREE.Mesh(geo, this.material);
      m.receiveShadow = true;
      this.chunks[c] = m;
      this.group.add(m);
    }
  }
}

function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => g.toNonIndexed());
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
