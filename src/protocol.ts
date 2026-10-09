// Messages between the main thread and the sim worker (§4).
import type { EmitterOp, Emote } from './sim/sim';
import type { Atmosphere, ChronicleEvent, EmitterDef, ShapeDef, TileTypeDef } from './sim/types';

export const ENT_STRIDE = 9; // id, shapeIdx, x, y, z, yaw, tint, scale, flags
export const FLAG_SELECTED_INHABITANT = 1;

export interface ModuleSource {
  id: string;
  source: string;
  status: 'active' | 'quarantined';
}

export type MainToSim =
  | { type: 'init'; save: string | null; seed: number; modules: ModuleSource[]; speed: number; paused: boolean; quarantine?: string[]; skip?: number }
  | { type: 'control'; speed?: number; paused?: boolean }
  | { type: 'install'; id: string; source: string }
  | { type: 'setModuleStatus'; id: string; status: 'active' | 'quarantined' }
  | { type: 'requestSave' }
  | { type: 'resync' }
  | { type: 'inspect'; id: number | null };

export interface FramePayload {
  type: 'frame';
  seq: number;
  tick: number;
  ents: Float32Array;
  tiles: [number, string][];
  emitterOps: EmitterOp[];
  emotes: Emote[];
  atmosphere?: Atmosphere;
  pops: [number, number]; // monsters, humans (incl. sleepers)
}

export interface InspectInfo {
  id: number;
  name?: string;
  kind: string;
  faction?: string;
  hunger: number;
  hp: number;
  maxHp: number;
  behavior: string;
  tags: string[];
  data: Record<string, unknown>;
}

export interface ModuleStat {
  id: string;
  status: 'active' | 'quarantined';
  faultsToday: number;
  msPerTick: number;
}

export type SimToMain =
  | FramePayload
  | { type: 'fullState'; seq: number; tick: number; tiles: string[]; elev: Float32Array; ents: Float32Array; attached: [number, string[]][]; atmosphere: Atmosphere }
  | { type: 'defs'; shapes: [string, ShapeDef][]; emitters: [string, EmitterDef][]; tiles: TileTypeDef[]; shapeIndex: string[] }
  | { type: 'events'; events: ChronicleEvent[] }
  | { type: 'save'; world: string; tick: number; reason: string }
  | { type: 'moduleFault'; id: string; hook: string; error: string; stack?: string }
  | { type: 'quarantined'; id: string; reason: string }
  | { type: 'installed'; id: string; ok: boolean; error?: string }
  | { type: 'moduleStats'; stats: ModuleStat[] }
  | { type: 'inspect'; info: InspectInfo | null }
  | { type: 'visible'; id: string; x: number; z: number; what: string }
  | { type: 'dawn'; day: number }
  | { type: 'error'; error: string };
