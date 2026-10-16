import type { Entity } from './types';
/** Bodies and teams are separate: corpses inherit a faction but are not fighters. */
export const hostile = (a: Entity, b: Entity) =>
  a.inhabitant &&
  b.inhabitant &&
  !!a.faction &&
  !!b.faction &&
  a.faction !== b.faction;
