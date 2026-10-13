// Arena settings (src/arena/README.md), shared by the panel and the sim worker. `ArenaShape` (geometry.ts) rebuilds
// the arena when it changes; `ArenaRules` apply live.
import { ARCHETYPES } from '../sim/monsters-gen';
import { DEFAULT_SHAPE, type ArenaShape } from './geometry';

export interface ArenaRules {
  /** which archetypes may spawn (ids from monsters-gen.ts) */
  monsters: string[];
  /** spawn on a timer; off, only the panel's Spawn buttons do */
  autoSpawn: boolean;
  /** most monsters alive at once */
  maxAlive: number;
  /** seconds between waves */
  spawnEvery: number;
  /** monsters per wave */
  waveSize: number;
  /** stop after this many have spawned this round (0: never) */
  roundLimit: number;
  monsterLevel: number;
  /** guards kept in the arena (followers) */
  guards: number;
  guardLevel: number;
  /** spears each guard starts with */
  guardSpears: number;
  /** seconds before a fallen guard is replaced (0: not replaced) */
  guardRespawn: number;
  /** guards follow the champion (tag 'follower', src/arena/sandbox/sim/village.ts) instead of holding posts */
  guardsFollow: boolean;
  championLevel: number;
  championSpears: number;
  /** seconds before a fallen champion is back */
  championRespawn: number;
  /** the champion can't drop below 1 HP */
  invincible: boolean;
  /** fixed hour of day (0–24), or null to let the clock run (a day is 8 real minutes) */
  hour: number | null;
  /** seconds a body lies before it's cleared (0: never) */
  bodiesLinger: number;
}

export const DEFAULT_RULES: ArenaRules = {
  monsters: ARCHETYPES.map((a) => a.id),
  autoSpawn: true,
  maxAlive: 2,
  spawnEvery: 20,
  waveSize: 1,
  roundLimit: 0,
  monsterLevel: 1,
  guards: 3,
  guardLevel: 2,
  guardSpears: 1,
  guardRespawn: 30,
  guardsFollow: true,
  championLevel: 3,
  championSpears: 1,
  championRespawn: 5,
  invincible: false,
  hour: 13,
  bodiesLinger: 45,
};

export interface ArenaConfig {
  shape: ArenaShape;
  rules: ArenaRules;
}

export const DEFAULT_CONFIG: ArenaConfig = { shape: { ...DEFAULT_SHAPE }, rules: { ...DEFAULT_RULES } };

/** Main thread → arena worker (alongside the game's own messages). */
export type ArenaCommand =
  | { type: 'arena'; cmd: 'rules'; rules: ArenaRules }
  | { type: 'arena'; cmd: 'reset' }
  | { type: 'arena'; cmd: 'spawn'; archetype: string | null; n: number }
  | { type: 'arena'; cmd: 'clear' }
  | { type: 'arena'; cmd: 'heal' };

/** Arena worker → main thread. */
export interface ArenaStatus {
  type: 'arenaStatus';
  alive: { archetype: string; hp: number; max: number; level: number; state: string }[];
  guards: number;
  spawned: number;
  kills: number;
  deaths: number;
  guardDeaths: number;
  /** seconds to the next wave (null: none coming) */
  nextWave: number | null;
  /** seconds to the champion's return (null: alive) */
  respawn: number | null;
  roundSeconds: number;
}

/** Keep stored settings usable across versions: unknown keys dropped, missing ones defaulted, numbers clamped. */
export function sanitize(c: Partial<ArenaConfig> | null | undefined): ArenaConfig {
  const s = { ...DEFAULT_SHAPE, ...(c?.shape ?? {}) };
  const r = { ...DEFAULT_RULES, ...(c?.rules ?? {}) };
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const ids = new Set(ARCHETYPES.map((a) => a.id));
  return {
    shape: {
      radius: Math.round(num(s.radius, 12, 50, DEFAULT_SHAPE.radius)),
      wallH: num(s.wallH, 20, 150, DEFAULT_SHAPE.wallH),
      density: (['none', 'some', 'lots'] as const).includes(s.density) ? s.density : DEFAULT_SHAPE.density,
      seed: Math.round(num(s.seed, 1, 1e9, 1)),
    },
    rules: {
      monsters: Array.isArray(r.monsters) ? r.monsters.filter((m) => ids.has(m)) : DEFAULT_RULES.monsters,
      autoSpawn: !!r.autoSpawn,
      maxAlive: Math.round(num(r.maxAlive, 0, 30, DEFAULT_RULES.maxAlive)),
      spawnEvery: num(r.spawnEvery, 1, 600, DEFAULT_RULES.spawnEvery),
      waveSize: Math.round(num(r.waveSize, 1, 10, DEFAULT_RULES.waveSize)),
      roundLimit: Math.round(num(r.roundLimit, 0, 999, 0)),
      monsterLevel: Math.round(num(r.monsterLevel, 1, 20, 1)),
      guards: Math.round(num(r.guards, 0, 16, DEFAULT_RULES.guards)),
      guardLevel: Math.round(num(r.guardLevel, 1, 20, DEFAULT_RULES.guardLevel)),
      guardSpears: Math.round(num(r.guardSpears, 0, 1, DEFAULT_RULES.guardSpears)),
      guardRespawn: num(r.guardRespawn, 0, 600, DEFAULT_RULES.guardRespawn),
      guardsFollow: !!r.guardsFollow,
      championLevel: Math.round(num(r.championLevel, 1, 20, DEFAULT_RULES.championLevel)),
      championSpears: Math.round(num(r.championSpears, 0, 3, DEFAULT_RULES.championSpears)),
      championRespawn: num(r.championRespawn, 1, 120, DEFAULT_RULES.championRespawn),
      invincible: !!r.invincible,
      hour: r.hour === null ? null : num(r.hour, 0, 24, 13),
      bodiesLinger: num(r.bodiesLinger, 0, 3600, DEFAULT_RULES.bodiesLinger),
    },
  };
}
