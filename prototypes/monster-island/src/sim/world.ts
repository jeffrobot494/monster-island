import type { TileTypeDef } from './types';

export const SIZE = 64;

export const CORE_TILES: TileTypeDef[] = [
  { id: 'deep-water', height: -0.6, walkable: false, moveCost: Infinity, color: '#2b5d8a' },
  { id: 'shallow-water', height: -0.3, walkable: false, moveCost: Infinity, color: '#3f86b8' },
  { id: 'sand', height: 0.0, walkable: true, moveCost: 1.2, color: '#e6d39a' },
  { id: 'grass', height: 0.2, walkable: true, moveCost: 1.0, color: '#7cba5a' },
  { id: 'forest', height: 0.25, walkable: true, moveCost: 1.5, color: '#4d8a3e' },
  { id: 'rock', height: 0.6, walkable: true, moveCost: 2.0, color: '#8c8a84' },
  { id: 'bridge', height: 0.1, walkable: true, moveCost: 1.0, color: '#9b6b3f' },
];

/** Tile grid. Types are stored by id string per tile so module tile types survive registry changes. */
export class TileGrid {
  readonly size = SIZE;
  types: string[];
  /** extra elevation for rock tiles (0.6–1.5); 0 elsewhere */
  elev: Float32Array;
  defs = new Map<string, TileTypeDef>();
  /** tile indices changed since the last drain */
  changed = new Set<number>();
  /** bumped whenever tile types (defs) change → cost tables must rebuild */
  defsVersion = 0;

  constructor() {
    this.types = new Array(SIZE * SIZE).fill('deep-water');
    this.elev = new Float32Array(SIZE * SIZE);
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
    if (t === 'rock') return Math.max(0.6, this.elev[i]);
    return this.def(t).height;
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
