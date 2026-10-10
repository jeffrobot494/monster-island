import type { TileTypeDef } from './types';

export const SIZE = 128;

export const CORE_TILES: TileTypeDef[] = [
  { id: 'deep-water', height: -0.6, walkable: false, moveCost: Infinity, color: '#1f4f7a' },
  { id: 'shallow-water', height: -0.3, walkable: false, moveCost: Infinity, color: '#3f86b8' },
  { id: 'sand', height: 0.0, walkable: true, moveCost: 1.2, color: '#e3d3a0' },
  { id: 'grass', height: 0.2, walkable: true, moveCost: 1.0, color: '#9db35a' },
  { id: 'scrub', height: 0.2, walkable: true, moveCost: 1.1, color: '#b6a66a' },
  { id: 'wheat', height: 0.2, walkable: true, moveCost: 1.0, color: '#e2c25a' },
  { id: 'olive', height: 0.25, walkable: true, moveCost: 1.2, color: '#7f9a52' },
  { id: 'vineyard', height: 0.25, walkable: true, moveCost: 1.2, color: '#8d8f3e' },
  { id: 'cedar', height: 0.3, walkable: true, moveCost: 1.6, color: '#2f5a35' },
  { id: 'rock', height: 0.6, walkable: true, moveCost: 2.0, color: '#9a9286' },
  { id: 'wadi', height: 0.05, walkable: true, moveCost: 1.1, color: '#c9a877' },
  { id: 'salt', height: 0.02, walkable: true, moveCost: 1.3, color: '#ece8dc' },
  { id: 'marsh', height: 0.0, walkable: true, moveCost: 2.2, color: '#6f8a6a' },
  { id: 'ruin-floor', height: 0.2, walkable: true, moveCost: 1.0, color: '#b8ab92' },
  { id: 'road', height: 0.18, walkable: true, moveCost: 0.8, color: '#c8b48a' },
  { id: 'wall', height: 1.2, walkable: false, moveCost: Infinity, color: '#a8865a' },
  { id: 'shrine-floor', height: 0.6, walkable: true, moveCost: 1.0, color: '#d8ccb0' },
];

/** Tiles whose surface height comes from the elevation map. */
export const ELEV_TILES = new Set(['rock', 'shrine-floor']);

/** Tile grid. Types are stored by id string per tile so module tile types survive registry changes. */
export class TileGrid {
  readonly size = SIZE;
  types: string[];
  /** extra elevation for rock/shrine tiles; 0 elsewhere */
  elev: Float32Array;
  /** region index per tile (0–6; 255 = sea) */
  region: Uint8Array;
  defs = new Map<string, TileTypeDef>();
  /** tile indices changed since the last drain */
  changed = new Set<number>();
  /** bumped whenever tile types (defs) change → cost tables must rebuild */
  defsVersion = 0;

  constructor() {
    this.types = new Array(SIZE * SIZE).fill('deep-water');
    this.elev = new Float32Array(SIZE * SIZE);
    this.region = new Uint8Array(SIZE * SIZE).fill(255);
    for (const d of CORE_TILES) this.defs.set(d.id, d);
  }

  inBounds(x: number, z: number) {
    return x >= 0 && z >= 0 && x < SIZE && z < SIZE;
  }
  idx(x: number, z: number) {
    return z * SIZE + x;
  }
  get(x: number, z: number): string {
    if (!this.inBounds(x, z)) return 'deep-water';
    return this.types[z * SIZE + x];
  }
  set(x: number, z: number, type: string) {
    const i = z * SIZE + x;
    if (this.types[i] === type) return;
    this.types[i] = type;
    this.changed.add(i);
  }
  def(type: string): TileTypeDef {
    return this.defs.get(type) ?? this.defs.get('grass')!;
  }
  /** surface height of a tile */
  height(x: number, z: number): number {
    if (!this.inBounds(x, z)) return -0.6;
    const i = z * SIZE + x;
    const t = this.types[i];
    if (ELEV_TILES.has(t)) return Math.max(this.def(t).height, this.elev[i]);
    return this.def(t).height;
  }
  regionAt(x: number, z: number): number {
    x = Math.floor(x);
    z = Math.floor(z);
    if (!this.inBounds(x, z)) return 255;
    return this.region[z * SIZE + x];
  }
  defineTile(def: TileTypeDef) {
    this.defs.set(def.id, def);
    this.defsVersion++;
  }
  removeTileType(id: string) {
    if (!this.defs.has(id)) return;
    this.defs.delete(id);
    this.defsVersion++;
    for (let i = 0; i < this.types.length; i++) {
      if (this.types[i] === id) {
        this.types[i] = 'grass';
        this.changed.add(i);
      }
    }
  }
  count(type: string): number {
    let n = 0;
    for (const t of this.types) if (t === type) n++;
    return n;
  }
  histogram(): Record<string, number> {
    const h: Record<string, number> = {};
    for (const t of this.types) h[t] = (h[t] ?? 0) + 1;
    return h;
  }
  drainChanged(): number[] {
    const out = [...this.changed];
    this.changed.clear();
    return out;
  }
}
