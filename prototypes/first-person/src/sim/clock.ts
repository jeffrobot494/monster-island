// The game clock (§2). clockMs is local wall time expressed as epoch ms (utc − tzOffset), so hour math is plain UTC math.
export const TICKS_PER_SECOND = 10;
export const MS_PER_REAL_TICK = 100;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const DAWN_HOUR = 6;
export const DUSK_HOUR = 18;
/** Game speed: a game day is 8 real minutes, 4 of daylight (06–18) and 4 of night. */
export const GAME_TIMESCALE = 180;

export interface TimeInfo {
  tick: number;
  clockMs: number;
  /** 1-based game day: 1 + local midnights since the island was created */
  day: number;
  /** 0..24 float */
  hour: number;
  isNight: boolean;
  msPerTick: number;
  /** 0 (dark) .. 1 (full daylight), including atmosphere effects */
  light: number;
}

export function hourOf(clockMs: number): number {
  return (((clockMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS;
}

/** Calendar day number of a clock value (changes at local midnight). */
export function calDay(clockMs: number): number {
  return Math.floor(clockMs / DAY_MS);
}

export function isNightHour(hour: number): boolean {
  return hour < DAWN_HOUR || hour >= DUSK_HOUR;
}

/** Base daylight by hour: 1 from 07–17, 0 from 19–05, linear between. */
export function baseLight(hour: number): number {
  if (hour >= 7 && hour <= 17) return 1;
  if (hour >= 19 || hour <= 5) return 0;
  if (hour < 7) return hour - 5 > 0 ? (hour - 5) / 2 : 0;
  return (19 - hour) / 2;
}

/** Is `hour` inside the window [a, b) (wrapping past midnight when a > b)? */
export function inWindow(hour: number, a: number, b: number): boolean {
  a = ((a % 24) + 24) % 24;
  b = ((b % 24) + 24) % 24;
  if (a === b) return true;
  return a < b ? hour >= a && hour < b : hour >= a || hour < b;
}

export function fmtClock(clockMs: number): string {
  const h = hourOf(clockMs);
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** The strictly next occurrence of an hour, including fractional hours. */
export function nextHour(clockMs: number, hour: number): number {
  const at = Math.floor(clockMs / DAY_MS) * DAY_MS + hour * HOUR_MS;
  return at > clockMs ? at : at + DAY_MS;
}
