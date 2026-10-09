// Shared data types for the pure-TS simulation (no DOM, no three.js).

export type Faction = 'monster' | 'human';

export interface TileTypeDef {
  id: string;
  color: string; // #rrggbb
  height: number;
  walkable: boolean;
  moveCost: number;
  owner?: string; // module id, undefined for core
}

export type Prim = 'box' | 'sphere' | 'cylinder' | 'cone';
export interface ShapePart {
  prim: Prim;
  size: [number, number, number];
  pos: [number, number, number];
  rot?: [number, number, number]; // degrees
  color: string; // #rrggbb | 'tint'
  emissive?: number; // 0–1
  opacity?: number; // 0.2–1
  anim?: { type: 'bob' | 'spin' | 'pulse' | 'sway'; speed: number; amount: number };
}
export interface ShapeDef {
  parts: ShapePart[];
}

export interface EmitterDef {
  color: string;
  color2?: string;
  size: number;
  rate: number; // per second
  life: number; // seconds
  speed: number;
  spread: number; // 0–1
  gravity: number;
  glow?: boolean;
}

export interface Atmosphere {
  skyTint?: string;
  fogColor?: string;
  fogDensity?: number;
  lightTint?: string;
  weather?: 'none' | 'rain' | 'snow';
}

export type Stat = 'speed' | 'maxHp' | 'strength' | 'hungerRate';
export const STATS: readonly Stat[] = ['speed', 'maxHp', 'strength', 'hungerRate'];

export interface Path {
  pts: number[]; // flattened tile indices
  i: number; // index of the next waypoint
  gx: number;
  gz: number;
}

export interface Entity {
  id: number;
  kind: string;
  faction?: Faction;
  name?: string;
  inhabitant: boolean;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  hunger: number;
  base: Record<Stat, number>;
  /** per stat → per module → modifier; effective = base * Πmul + Σadd */
  mods: Partial<Record<Stat, Record<string, { mul: number; add: number }>>>;
  homeId: number; // -1 if none
  behavior: string;
  tags: string[];
  /** tag → owning module ('' for core) */
  tagOwners: Record<string, string>;
  shape: string;
  tint: string;
  scale: number;
  hidden: boolean;
  owner: string; // module id that spawned it, '' for core
  path: Path | null;
  /** queued pathfinding request, if any */
  want: { gx: number; gz: number } | null;
  idleUntil: number;
  /** behavior-specific scratch for core behaviors */
  target: number; // food target entity id, -1 none
  targetSince: number;
  suppressed: Record<string, number>; // behavior id → until tick
  data: Record<string, Record<string, unknown>>; // module id → module data
  // kind-specific
  berries?: number; // berry bushes
  growAt?: number;
  capacity?: number; // houses
  diedAt?: number; // gravestones
  reservedBy?: number; // food reservation
  reservedUntil?: number;
}

export interface ChronicleEvent {
  tick: number;
  day: number;
  text: string;
  importance: number;
  source: string; // 'core' | module id | 'god'
  kind?: string;
}
