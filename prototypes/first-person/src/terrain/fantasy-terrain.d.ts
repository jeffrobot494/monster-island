// Types for fantasy-terrain.js (the slice the game and the terraformer use).

export interface TerrainOptions {
  seed: string;
  size: [number, number, number];
  baseHeight: number;
  hillHeight: number;
  terraceStep: number;
  terraceSharp: number;
  warp: number;
  canyons: number;
  caves: number;
  caverns: number;
  spires: number;
  islands: number;
  arches: number;
  island: boolean;
  waterLevel: number;
}

export interface Column { h: number; cn: number; floorY: number; fall: number }

export interface Field {
  options: TerrainOptions;
  size: [number, number, number];
  noise(x: number, y: number, z: number): number;
  column(x: number, z: number): Column;
  densityCol(x: number, y: number, z: number, c: Column): number;
  density(x: number, y: number, z: number): number;
  groundHeight(x: number, z: number): number;
}

export interface Palette {
  name: string;
  sky: number; fog: number; water: number; waterGlow: number;
  top: number; top2: number; sand: number; rockA: number; rockB: number;
  under: number; cave: number; caveFloor: number; crystals: number[];
}

export interface FlatMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  centroids: Float32Array;
  faceNormals: Float32Array;
  kinds: Uint8Array;
  triangleCount: number;
  palette: Palette;
}

export interface Crystal { position: [number, number, number]; direction: [number, number, number]; scale: number; spin: number; color: number }

export interface GenerateOptions extends Partial<TerrainOptions> {
  cell?: number;
  jitter?: number;
  palette?: string | Palette;
  crystalRate?: number;
}

export interface Generated {
  field: Field;
  flat: FlatMesh;
  crystals: Crystal[];
  spawns: [number, number, number][];
}

export interface Grid { data: Float32Array; nx: number; ny: number; nz: number; cell: number; origin: [number, number, number] }
export interface IndexedMesh { positions: Float32Array; indices: Uint32Array }

declare const FantasyTerrain: {
  DEFAULTS: TerrainOptions;
  sampleGrid(field: Field, opts?: { cell?: number; origin?: [number, number, number]; size?: [number, number, number]; closeEdges?: boolean }): Grid;
  surfaceNets(grid: Grid, opts?: { jitter?: number; seed?: number }): IndexedMesh;
  buildFlatMesh(mesh: IndexedMesh, field: Field, palette?: string | Palette): FlatMesh;
  PALETTES: Record<string, Palette>;
  KIND: { TOP: 0; ROCK: 1; UNDER: 2; CAVE: 3; SAND: 4 };
  createField(opts?: Partial<TerrainOptions>): Field;
  generate(opts?: GenerateOptions): Generated;
  hashStr(s: string): number;
};
export default FantasyTerrain;
