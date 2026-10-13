// Messages between the main thread and the sim worker.
import type { EmitterOp, Emote, Alert } from './sim/sim';
import type { ChampInput, CombatEvent, CtrlReason } from './sim/champion';
import type { IslandLayout } from './sim/island-gen';
import type { SoundEvent } from './sim/sim';
import type { AwaySummary } from './sim/offline';
import type { TerrainSettings } from './sim/terrain-import';

/** A terraformer island's ground (sim/terrain-import.ts); null for a procedural one. */
export type TerrainState = { settings: TerrainSettings; base: Float32Array; orig: Float32Array } | null;
import type { Atmosphere, ChronicleEvent, CreationRecord, CreationRequest, EmitterDef, Job, ShapeDef, TileTypeDef } from './sim/types';

// id, shapeIdx, x, y(m), z, yaw, tint, scale, flags, lift(m), roll, squash, ring(m), anim, zoneMask, hpFrac, seen, windup
export const ENT_STRIDE = 18;
export const O = { id: 0, shape: 1, x: 2, y: 3, z: 4, yaw: 5, tint: 6, scale: 7, flags: 8, lift: 9, roll: 10, squash: 11, ring: 12, anim: 13, mask: 14, hp: 15, seen: 16, windup: 17 } as const;
export const F_INHABITANT = 1;
export const F_TELEGRAPH = 2;
export const F_DOWNED = 4;
export const F_CHAMPION = 8;
export const F_TARGET = 16;
export const F_BOUND = 32;
export const F_MONSTER = 64;
export const F_DRAGGED = 128;
export const F_HITTABLE = 256;
export const F_CORE_SHAPE = 512; // an inhabitant still wearing its core shape (draw the rig, F15)
export const F_ANIMAL = 1024;
export const F_CORPSE = 2048;
export const F_HUMAN = 4096;
export const F_ITEM = 8192; // a spear (rack or ground): can be picked up
export const F_SHAKE = 16384; // a ridden monster shuddering before a shake lands (docs/climbing-phase4-plan.md)

export interface ModuleSource {
  id: string;
  source: string;
  status: 'active' | 'quarantined';
}

export type Action =
  | { kind: 'offerLamb' }
  | { kind: 'offerDragged' }
  | { kind: 'offerVillager'; id: number }
  | { kind: 'pray'; text: string }
  | { kind: 'setJob'; id: number; job: Job };

export type MainToSim =
  | { type: 'init'; save: string | null; seed: number; modules: ModuleSource[]; clockMs: number; realMs: number; timescale: number; quarantine?: string[]; reveal?: boolean; invincible?: boolean; skip?: number; terrain?: TerrainSettings | null }
  | { type: 'control'; paused: boolean }
  | { type: 'catchUp'; clockMs: number; realMs: number }
  | { type: 'input'; input: ChampInput }
  | { type: 'action'; action: Action }
  | { type: 'install'; id: string; source: string; record: CreationRecord; night: number }
  | { type: 'creationFailed'; night: number }
  | { type: 'setModuleStatus'; id: string; status: 'active' | 'quarantined' }
  | { type: 'requestSave' }
  | { type: 'resync' }
  | { type: 'inspect'; id: number | null }
  | { type: 'devJudge'; human: number; monster: number }
  | { type: 'devSkipHours'; hours: number }
  | { type: 'devRaid' }
  | { type: 'devShowMonsters'; on: boolean }
  | { type: 'devScenario'; name: string }
  | { type: 'devCrown' }
  | { type: 'devKillChampion' };

export interface VillagerInfo {
  id: number;
  name: string;
  job: Job;
  nextJob?: Job;
  shift: 'day' | 'night';
  level: number;
  hp: number;
  maxHp: number;
  state: string;
  bio: string;
  elder: boolean;
  inVillage: boolean;
}

export interface MonsterCard {
  id: number;
  name: string;
  archetype: string;
  display: string;
  region: string;
  lairFound: boolean;
  seen: boolean;
  level: number | null;
  hp: number | null;
  maxHp: number | null;
  seenHours: number[];
  enraged: boolean;
  special: string;
  dead: boolean;
}

export interface Hud {
  tick: number;
  clockMs: number;
  day: number;
  hour: number;
  light: number;
  timescale: number;
  champion: null | {
    id: number;
    name: string;
    hp: number;
    maxHp: number;
    level: number;
    xp: number;
    xpNext: number;
    state: string;
    x: number;
    z: number;
    dragging: null | { name: string; value: number; kind: string };
    nearAltar: boolean;
    downedTarget: null | { id: number; name: string };
    weaponMul: number;
    speedMul: number;
    blocking: boolean;
    torch: boolean;
    sight: number;
    spears: number;
    spearCap: number;
    /** in hand: the sword, or a spear */
    wield: 'sword' | 'spear';
  };
  championPendingDawn: boolean;
  favor: { human: number; monster: number };
  food: number;
  foodCap: number;
  fold: number;
  pop: number;
  monstersAlive: number;
  alarm: boolean;
  /** the monsters are raiding the village tonight */
  raid: boolean;
  prayer: string;
  pendingCreations: CreationRequest[];
  creations: CreationRecord[];
  domainHistory: Record<'human' | 'monster', { night: number; domain: string }[]>;
  missingSystems: string[];
  gameOver: { winner: 'human' | 'monster'; day: number } | null;
  stats: { monsterKills: number; villagerDeaths: number; humanSacrifices: number; monsterSacrifices: number };
  /** monsters near the champion (for the danger check before showing a creation card) */
  dangerNear: boolean;
  /** real ms until the next Judgment */
  judgmentInMs: number;
  lairsHome: number[];
  /** dev: every living monster, wherever it is (sent only while the dev reveal is on) */
  devMonsters?: { id: number; name: string; x: number; z: number; state: string; target: string | null }[];
}

export interface FramePayload {
  type: 'frame';
  seq: number;
  tick: number;
  ents: Float32Array;
  tiles: [number, string][];
  explored: number[];
  emitterOps: EmitterOp[];
  emotes: Emote[];
  atmosphere?: Atmosphere;
  ctrl: 'player' | 'sim';
  ctrlReason: CtrlReason;
  epoch: number;
  /** alt: a climber's feet above the ground (m), terraformer islands */
  champ: { x: number; z: number; yaw: number; alt?: number } | null;
  correction?: { x: number; z: number; epoch: number; alt?: number };
  screams: { id: number; x: number; z: number }[];
  sounds: SoundEvent[];
  combat: CombatEvent[];
  toasts: string[];
  hurt: number;
  actionError?: string | null;
}

export interface NameInfo {
  name: string;
  title: string;
}

export interface InspectInfo {
  id: number;
  name?: string;
  kind: string;
  title: string;
  lines: string[];
  hp?: number;
  maxHp?: number;
}

export interface ModuleStat {
  id: string;
  status: 'active' | 'quarantined';
  faultsToday: number;
  msPerTick: number;
}

export type SimToMain =
  | FramePayload
  | { type: 'fullState'; seq: number; tick: number; tiles: string[]; elev: Float32Array; explored: Uint8Array; ents: Float32Array; attached: [number, string[]][]; atmosphere: Atmosphere; layout: IslandLayout; epoch: number; walkCost: Uint8Array; terrain: TerrainState }
  | { type: 'walkCost'; cost: Uint8Array }
  | { type: 'names'; names: [number, NameInfo][] }
  | { type: 'defs'; shapes: [string, ShapeDef][]; emitters: [string, EmitterDef][]; tiles: TileTypeDef[]; shapeIndex: string[] }
  | { type: 'events'; events: ChronicleEvent[] }
  | { type: 'alerts'; alerts: Alert[] }
  | { type: 'hud'; hud: Hud }
  | { type: 'villagers'; villagers: VillagerInfo[]; monsters: MonsterCard[] }
  | { type: 'save'; world: string; tick: number; reason: string }
  | { type: 'moduleFault'; id: string; hook: string; error: string; stack?: string }
  | { type: 'quarantined'; id: string; reason: string }
  | { type: 'installed'; id: string; ok: boolean; error?: string }
  | { type: 'moduleStats'; stats: ModuleStat[] }
  | { type: 'inspect'; info: InspectInfo | null }
  | { type: 'visible'; id: string; x: number; z: number; what: string }
  | { type: 'away'; summary: AwaySummary }
  | { type: 'actionResult'; error: string | null }
  | { type: 'error'; error: string };
