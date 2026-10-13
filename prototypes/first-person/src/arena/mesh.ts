// The arena's rock as the renderer draws it and climbing collides with it: Terrain.featureBuilder for arena terrain
// (arena-main.ts). Same triangles as the sim's blocked tiles (geometry.ts).
import * as THREE from 'three';
import { FeatureSurface } from '../input/feature-surface';
import { buildFeatureMesh } from '../render/feature-mesh';
import type { TerrainSettings } from '../sim/terrain-import';
import { FLOOR_Y, planArena, prismTriangles } from './geometry';
import type { ArenaTerrain } from './arena-sim';

export function buildArenaFeatures(s: TerrainSettings): { mesh: THREE.Mesh; surface: FeatureSurface } {
  const shape = (s as ArenaTerrain).arena;
  if (!shape) return buildFeatureMesh(s);
  const L = planArena(shape);
  const { pos, colors } = prismTriangles(L.prisms);
  const col = new Float32Array(pos.length);
  const c = new THREE.Color();
  for (let t = 0; t < colors.length; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      // darker toward the foot, like weathered stone
      const shade = 0.78 + 0.22 * Math.min(1, Math.max(0, (pos[o + 1] - FLOOR_Y) / 12));
      c.setStyle(colors[t], THREE.SRGBColorSpace).multiplyScalar(shade);
      col[o] = c.r;
      col[o + 1] = c.g;
      col[o + 2] = c.b;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.castShadow = mesh.receiveShadow = true;
  return { mesh, surface: new FeatureSurface(pos) };
}
