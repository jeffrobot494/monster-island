// Terraformer islands: what the heightmap ground can't show — spires and their caps, arches, floating isles,
// overhangs — as one static mesh built from the terraformer's own surface (fantasy-terrain.js), in its palette.
// Only triangles standing clear of the terraformer's ground are kept, so the ground and its cliffs aren't drawn twice.
// The test uses the ground as sampled *before* the game flattened the village and cut roads, so the old hill under a
// flattened village is dropped too.
import * as THREE from 'three';
import FT from '../terrain/fantasy-terrain.js';
import { M, NV, RES } from '../sim/ground';
import { SIZE } from '../sim/world';
import { createField, sampleBase, solidMask, toMeters, type TerrainSettings } from '../sim/terrain-import';
import { FeatureSurface, WALL_NY } from '../input/feature-surface';

/** the y of a triangle's unit normal, in game meters (terraformer y is scaled by heightScale) */
function steepNy(P: ArrayLike<number>, o: number, s: TerrainSettings): number {
  const ax = (P[o + 3] - P[o]) * M, ay = (P[o + 4] - P[o + 1]) * s.heightScale, az = (P[o + 5] - P[o + 2]) * M;
  const bx = (P[o + 6] - P[o]) * M, by = (P[o + 7] - P[o + 1]) * s.heightScale, bz = (P[o + 8] - P[o + 2]) * M;
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  return ny / (Math.hypot(nx, ny, nz) || 1);
}

/** the max of a vertex grid within r vertices (separable, so cheap) */
function dilate(src: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - r); k <= Math.min(NV - 1, i + r); k++) m = Math.max(m, src[j * NV + k]);
    tmp[j * NV + i] = m;
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, j - r); k <= Math.min(NV - 1, j + r); k++) m = Math.max(m, tmp[k * NV + i]);
    out[j * NV + i] = m;
  }
  return out;
}

/**
 * The mesh, and `surface`: what climbing collides with (docs/climbing-phase2-plan.md, Part A). That's the kept
 * triangles plus a skirt: the dropped ones steeper than 50° on tiles where rock stands on the ground (spire
 * footprints, arch legs), so the lowest meters of a spire are solid too. The skirt isn't drawn.
 */
export function buildFeatureMesh(s: TerrainSettings): { mesh: THREE.Mesh; surface: FeatureSurface } {
  const t0 = performance.now();
  const field = createField(s);
  const grid = FT.sampleGrid(field, { cell: s.cell });
  const flat = FT.buildFlatMesh(FT.surfaceNets(grid, { jitter: s.jitter, seed: FT.hashStr(String(s.seed)) }), field, s.palette);
  // the ground's highest point near each triangle, in meters; a triangle within `margin` of it is ground or cliff
  const base = sampleBase(s, field);
  const ground = dilate(base, Math.ceil(s.cell * 1.2 * RES));
  const solid = solidMask(s, field);
  const margin = 1.5 + 0.5 * s.jitter * s.cell * s.heightScale;
  const P = flat.positions, Cl = flat.colors;
  const pos: number[] = [], col: number[] = [], skirt: number[] = [];
  const c = new THREE.Color();
  const tri = (out: number[], o: number) => {
    for (let k = 0; k < 3; k++) out.push(P[o + k * 3] * M, toMeters(s, P[o + k * 3 + 1]), P[o + k * 3 + 2] * M);
  };
  for (let t = 0; t < flat.triangleCount; t++) {
    const o = t * 9;
    const cx = (P[o] + P[o + 3] + P[o + 6]) / 3, cz = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    const gi = Math.min(NV - 1, Math.max(0, Math.round(cx * RES))), gj = Math.min(NV - 1, Math.max(0, Math.round(cz * RES)));
    const top = toMeters(s, Math.max(P[o + 1], P[o + 4], P[o + 7]));
    if (top <= ground[gj * NV + gi] + margin) {
      const ix = Math.min(SIZE - 1, Math.max(0, Math.floor(cx))), iz = Math.min(SIZE - 1, Math.max(0, Math.floor(cz)));
      if (solid[iz * SIZE + ix] && Math.abs(steepNy(P, o, s)) < WALL_NY) tri(skirt, o);
      continue;
    }
    tri(pos, o);
    for (let k = 0; k < 3; k++) {
      const v = o + k * 3;
      // fantasy-terrain's colors are sRGB; three works in linear
      c.setRGB(Cl[v], Cl[v + 1], Cl[v + 2], THREE.SRGBColorSpace);
      col.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals(); // non-indexed: face normals, recomputed after the scaling into meters
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.castShadow = mesh.receiveShadow = true;
  const surface = new FeatureSurface([...pos, ...skirt]);
  console.info(`[terrain] feature mesh: ${pos.length / 9} of ${flat.triangleCount} triangles (+${skirt.length / 9} skirt), ${Math.round(performance.now() - t0)} ms`);
  return { mesh, surface };
}
