export const TICKS_PER_SECOND = 10;
export const TICKS_PER_DAY = 1800;
export const DUSK_TICK = 1200;

export interface TimeInfo {
  tick: number; // absolute tick since island creation
  dayTick: number; // 0..1799, dawn = 0
  day: number; // 0-based day index
  hour: number; // 0..23
  isNight: boolean;
  ticksPerDay: number;
}

export function timeInfo(tick: number): TimeInfo {
  const dayTick = tick % TICKS_PER_DAY;
  return {
    tick,
    dayTick,
    day: Math.floor(tick / TICKS_PER_DAY),
    hour: (6 + Math.floor(dayTick / 75)) % 24,
    isNight: dayTick >= DUSK_TICK,
    ticksPerDay: TICKS_PER_DAY,
  };
}
