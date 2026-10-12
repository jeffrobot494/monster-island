// Terrain from the Monster Island Terraformer (terraformer.html). The terraformer saves only its settings; this samples
// the game's ground from them. One terraformer unit = one tile horizontally; vertically a unit is `heightScale` m and
// the terraformer's water level is the game's sea level.
import FT, { type Field, type TerrainOptions } from '../terrain/fantasy-terrain.js';
import { NV, RES, WATER_Y } from './ground';
import { SIZE } from './world';

export const TERRAIN_FORMAT = 1;

/** What the terraformer saves (src/terrain/saved-terrain.json). */
export interface TerrainSettings extends Omit<TerrainOptions, 'size' | 'island'> {
  format: number;
  /** meters per terraformer unit, vertically */
  heightScale: number;
  /** the rest only shape the feature mesh (render/feature-mesh.ts) */
  palette: string;
  cell: number;
  jitter: number;
}

export const DEFAULT_SETTINGS: TerrainSettings = {
  format: TERRAIN_FORMAT,
  ...(({ size: _s, island: _i, ...o }) => o)(FT.DEFAULTS),
  heightScale: 4,
  palette: 'monster',
  cell: 2,
  jitter: 0.2,
};

/** Throws on settings the game can't use, so a bad file fails loudly instead of making a strange island. */
export function checkSettings(s: unknown): TerrainSettings {
  const o = s as TerrainSettings;
  if (!o || typeof o !== 'object') throw new Error('terrain settings: not an object');
  if (o.format !== TERRAIN_FORMAT) throw new Error(`terrain settings: format ${o.format}, expected ${TERRAIN_FORMAT}`);
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof TerrainSettings)[]) {
    if (typeof o[k] !== typeof DEFAULT_SETTINGS[k]) throw new Error(`terrain settings: ${k} is missing or not a ${typeof DEFAULT_SETTINGS[k]}`);
  }
  if (!(o.heightScale >= 0.5 && o.heightScale <= 12)) throw new Error('terrain settings: heightScale out of range');
  return o;
}

export function createField(s: TerrainSettings): Field {
  const { format: _f, heightScale: _h, palette: _p, cell: _c, jitter: _j, ...opts } = s;
  return FT.createField({ ...opts, size: [SIZE, 64, SIZE], island: true });
}

/** terraformer y (units) → game height (m) */
export const toMeters = (s: TerrainSettings, y: number) => (y - s.waterLevel) * s.heightScale + WATER_Y;
/** game height (m) → terraformer y (units) */
export const toUnits = (s: TerrainSettings, m: number) => (m - WATER_Y) / s.heightScale + s.waterLevel;

/**
 * The top ground surface (units) of a column: the first solid going down from just above the landform's height.
 * Canyons and cave mouths cut below column.h, so it is not the surface; what stands above it (spires, arches,
 * floating isles) is not ground.
 */
export function surfaceAt(f: Field, x: number, z: number): number {
  const c = f.column(x, z);
  const top = c.h + 0.5;
  let prevY = top, prevD = f.densityCol(x, top, z, c);
  if (prevD > 0) return c.h; // inside a spire or arch foot: its ground is the landform
  for (let y = top - 0.25; y > c.h - 40; y -= 0.25) {
    const d = f.densityCol(x, y, z, c);
    if (d > 0) return y + (prevY - y) * (d / (d - prevD)); // linear refine of the zero crossing
    prevY = y;
    prevD = d;
  }
  return c.h - 40;
}

/** Ground heights (m) at every Ground vertex (a vertex every 1/RES tiles). */
export function sampleBase(s: TerrainSettings, f: Field = createField(s)): Float32Array {
  const base = new Float32Array(NV * NV);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) base[j * NV + i] = toMeters(s, surfaceAt(f, i / RES, j / RES));
  return base;
}

/** Is there rock between `lo` and `hi` meters above the ground at (x, z) (tiles)? Spire footprints, arch legs. */
export function solidAbove(s: TerrainSettings, f: Field, x: number, z: number, groundM: number, lo = 1, hi = 2.5): boolean {
  const c = f.column(x, z);
  for (let m = lo; m <= hi + 1e-6; m += (hi - lo) / 2) if (f.densityCol(x, toUnits(s, groundM + m), z, c) > 0) return true;
  return false;
}

/** Per tile, 1 where rock stands 1–2.5 m above the ground (spires, arch legs), tested at five points. */
export function solidMask(s: TerrainSettings, f: Field): Uint8Array {
  const solid = new Uint8Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
    for (const [ox, oz] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
      const px = x + ox, pz = z + oz;
      // against the exact surface there: the vertex grid cuts under sharp terrace edges
      if (solidAbove(s, f, px, pz, toMeters(s, surfaceAt(f, px, pz)))) {
        solid[z * SIZE + x] = 1;
        break;
      }
    }
  }
  return solid;
}
