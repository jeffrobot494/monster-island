import type { Atmosphere } from './types';
export interface NightMods {
  darkness: number;
  clockRate: number;
  windowBonus: number;
  atmosphere: Atmosphere;
}
// Offline catch-up deliberately uses undilated game time.
export const noNightMods = (): NightMods => ({
  darkness: 0,
  clockRate: 1,
  windowBonus: 0,
  atmosphere: {},
});
