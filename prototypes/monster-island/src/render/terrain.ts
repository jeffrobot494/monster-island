import * as THREE from 'three';
import type { TileTypeDef } from '../sim/types';

const SIZE = 64;
const CHUNK = 8;
const BOTTOM = -1.6;

function hash(i: number) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Terrain {
  group = new THREE.Group();
  types: string[] = [];
  elev: Float32Array<ArrayBufferLike> = new Float32Array(SIZE * SIZE);
  defs = new Map<string, TileTypeDef>();
  private chunks: (THREE.Mesh | null)[] = new Array((SIZE / CHUNK) ** 2).fill(null);
  material: THREE.MeshLambertMaterial;
  private uTime = { value: 0 };

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWave;\nuniform float uTime;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += aWave * (sin(uTime * 1.6 + position.x * 0.9 + position.z * 0.7) * 0.035 + sin(uTime * 2.3 - position.x * 0.5 + position.z * 1.3) * 0.02);');
    };
    // ocean beyond the map edge
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshLambertMaterial({ color: '#2b5d8a' }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(SIZE / 2, -0.62, SIZE / 2);
    this.group.add(sea);
  }

  setDefs(defs: TileTypeDef[]) {
    this.defs = new Map(defs.map((d) => [d.id, d]));
    if (this.types.length) this.rebuildAll();
  }

  load(types: string[], elev: Float32Array) {
    this.types = types;
    this.elev = elev;
    this.rebuildAll();
  }

  height(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return -0.6;
    const i = z * SIZE + x;
    const t = this.types[i];
    if (t === 'rock') return Math.max(0.6, this.elev[i]);
    return this.defs.get(t)?.height ?? 0.2;
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
  }

  update(time: number) {
    this.uTime.value = time;
  }

  private rebuildAll() {
    for (let c = 0; c < this.chunks.length; c++) this.buildChunk(c);
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
        const j = (hash(i) - 0.5) * (isWater ? 0.04 : 0.09);
        color.offsetHSL(0, 0, j);
        const w = isWater ? 1 : 0;
        // top
        quad([x, h, z + 1], [x + 1, h, z + 1], [x + 1, h, z], [x, h, z], [0, 1, 0], color, [w, w, w, w]);
        // sides: down to each lower neighbor
        const side = color.clone().multiplyScalar(isWater ? 0.85 : 0.72);
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
