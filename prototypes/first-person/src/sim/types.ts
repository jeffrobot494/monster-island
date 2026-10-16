// Shared data types for the pure-TS simulation (no DOM, no three.js).

export type Faction = 'human' | 'monster';
export type DmgType = 'slash' | 'pierce' | 'crush' | 'bite' | 'fire';
export const DMG_TYPES: readonly DmgType[] = ['slash', 'pierce', 'crush', 'bite', 'fire'];
export type Zone = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'sig';
export type Job = 'champion' | 'shepherd' | 'vinedresser' | 'woodcutter' | 'fisherman' | 'farmer' | 'guard';
export const JOBS: readonly Job[] = ['shepherd', 'vinedresser', 'woodcutter', 'fisherman', 'farmer', 'guard'];
export type DeathType = 'dismembered' | 'torn' | 'bitten' | 'burned' | 'crushed' | 'impaled' | 'eaten' | 'slain';

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
  weather?: 'none' | 'rain' | 'fog' | 'ash';
  /** 0..1: darkens the day (eclipse) */
  darkness?: number;
  /** 0..1: lights the night (a second moon) */
  light?: number;
}

export type Stat = 'speed' | 'maxHp' | 'strength' | 'sight';
export const STATS: readonly Stat[] = ['speed', 'maxHp', 'strength', 'sight'];

export interface Path {
  pts: number[]; // flattened tile indices (raw A*, used for invalidation, F27)
  /** smoothed waypoints (tile coords); when present the walker follows these */
  wp?: { x: number; z: number }[];
  i: number; // index of the next waypoint
  gx: number;
  gz: number;
}

export interface ZoneState {
  hp: number;
  max: number;
  state: 'ok' | 'crippled' | 'severed';
}

/** where a ridden flyer is taking its rider: tiles, and the height in meters (absolute); land: down at its lair */
export interface RideGoal { x: number; z: number; alt: number; land?: boolean }

export interface MonsterInfo {
  archetype: string;
  epithet: string;
  region: number;
  lairX: number;
  lairZ: number;
  hours: 'day' | 'night' | 'dusk-dawn' | 'restless';
  restless: [number, number][];
  neighbors: number[];
  baseHp: number;
  dmg: number;
  dmgType: DmgType;
  reach: number;
  flies: boolean;
  swims: boolean;
  enragedUntil: number; // clockMs, 0 = calm
  huntAt: number[]; // clockMs of today's remaining hunts
  huntUntil: number; // clockMs: give up searching for villagers
  ground: { x: number; z: number } | null;
  prey: number;
  grabAt: number;
  /** where the prey is pinned during a grab (F4) */
  grabPos?: { x: number; z: number } | null;
  /** the stalk's final rush has started (one growl) */
  pounced?: boolean;
  /** tick of the last attack release (strike animation) */
  strikeAt?: number;
  feedAt: number;
  satedUntil?: number; // clockMs: rests after a kill or sacrifice
  visit: { atHour: number; to: number; done: boolean } | null;
  lairFound: boolean;
  seen: boolean;
  seenHours: number[];
  lastSeenClock: number;
  roarAt: number; // tick of last roar
  respondTo: { x: number; z: number; at: number } | null;
  downedAt: number; // tick
  windup: number; // tick the current wind-up started, -1 none
  attackReadyAt: number; // tick
  runFrom: { x: number; z: number } | null; // charge start (se'ir)
  /** flyers: meters above the ground (0 = landed) */
  alt?: number;
  /** flyers: the bearing of the current soaring circle around the lair */
  circle?: number;
  /** tick a door-battering began (raids) */
  batterAt?: number;
  /** the house this raider is breaking into */
  batterId?: number;
  /** besieging a climber it can't reach (clockMs it gives up), and the tick the siege condition began */
  besiegeUntil?: number;
  besiegeSince?: number;
  /** clockMs: gave up on the champion; leaves them be until then */
  ignoreChampUntil?: number;
  /** ridden (docs/climbing-phase4-plan.md, Part A): the tick the rider got on, the tick the current shake began
   *  shuddering (-1 none), the tick the next one lands, the shakes so far, and where a flyer is taking its rider (tiles; alt in meters) */
  ride?: { since: number; next: number; shakeAt: number; shakes: number; goal?: RideGoal };
  /** tick a blow to the head from its back stops staggering it */
  staggerUntil?: number;
  /** the windup is a grab at its rider, not a blow, reaching for the rider on capsule grabCap */
  grabbing?: boolean;
  grabCap?: number;
  /** its wing went while it was ridden aloft: coming down to a crash landing */
  crashing?: boolean;
}

export interface HumanInfo {
  job: Job;
  shift: 'day' | 'night';
  homeId: number;
  bio: string;
  male: boolean;
  site: number; // tile index of the current work site, -1 none
  workedMs: number; // game ms worked on the current site this hour
  downedAt: number;
  attackReadyAt: number;
  nextJob?: Job;
  screamAt: number;
  capturedAt: number;
  missingReported: boolean;
  /** spears carried (champion and guards); real items, see spears.ts */
  spears?: number;
  /** the spear a guard is walking to pick up */
  fetchSpear?: number;
  /** champion only, terraformer islands: feet above the ground (m) while climbing or falling, and how */
  alt?: number;
  climb?: 'wall' | 'perch' | 'mount';
  /** the monster being ridden, and the climb volume (CLIMB index) the champion is on */
  mount?: { id: number; cap: number };
}

/** A spear lying in the world, standing in the rack, or in flight. Heights and velocities in meters. */
export interface SpearInfo {
  st: 'rack' | 'ground' | 'flying';
  /** absolute height (m) while flying */
  y: number;
  vx: number;
  vy: number;
  vz: number;
  thrower: number;
  /** what the thrower aimed at, and where */
  aimId: number;
  aimZone: Zone | null;
  /** ticks in the air */
  t: number;
}

export interface CorpseInfo {
  species: string; // 'human' | archetype | 'goat' | 'ox' | 'lamb'
  name?: string;
  maxHp: number;
  diedClock: number;
  diedCalDay: number;
  deathType: DeathType;
  faction?: Faction;
  bones: boolean;
  bonesNights: number;
  eatenBy?: number;
  eatenAt?: number;
}

export interface Entity {
  unit?: {type: 'jackal'; leader: number; iid: number; mode: string; until: number; stolen: number};
  eventTagOwners?: Record<string,string[]>;
  fx?: {id:string;key:string}[];
  scaleMods?: Record<string,number>;
  id: number;
  kind: string; // 'human' | 'monster' | 'animal' | 'corpse' | 'part' | 'blood' | 'structure' | module kinds
  faction?: Faction;
  name?: string;
  inhabitant: boolean;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  base: Record<Stat, number>;
  /** per stat → per module → modifier; effective = base * Πmul + Σadd */
  mods: Partial<Record<Stat, Record<string, { mul: number; add: number }>>>;
  zones?: Partial<Record<Zone, ZoneState>>;
  level: number;
  xp: number;
  state: string;
  stateUntil: number;
  target: number;
  tags: string[];
  /** tag → owning module ('' for core) */
  tagOwners: Record<string, string>;
  shape: string;
  tint: string;
  scale: number;
  lift: number;
  roll: number;
  squash: number;
  hidden: boolean;
  owner: string; // module id that spawned it, '' for core
  path: Path | null;
  want: { gx: number; gz: number } | null;
  idleUntil: number;
  data: Record<string, Record<string, unknown>>; // module id → module data
  monster?: MonsterInfo;
  human?: HumanInfo;
  corpse?: CorpseInfo;
  animal?: { species: 'goat' | 'ox'; region: number };
  spear?: SpearInfo;
  carrying?: number;
  carriedBy?: number;
  burnUntil?: number;
  burnSource?: number;
  /** blood/part: remove at this calendar day */
  expireCalDay?: number;
  /** structure role / lair region */
  role?: string;
  region?: number;
  /** last module that hurt this inhabitant */
  harmedBy?: string;
  /** remaining ticks of a scripted death animation */
  anim?: { type: string; t: number; dx?: number; dz?: number };
}

export interface ChronicleEvent {
  tick: number;
  clockMs: number;
  day: number;
  text: string;
  importance: number;
  source: string; // 'core' | module id | 'god'
  kind?: string;
}
