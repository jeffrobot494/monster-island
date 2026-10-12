// Climb volumes (docs/climbing-phase3-plan.md, Part A): capsules between named body points, radii in shape units
// (the entity's scale sizes them). The point names are shared by the procedural rigs (rigs.ts, biped) and the
// generated models (glb-rig.ts, MODELS.points), so one table drives both. Pure: the sim and the renderer use it.
import type { Zone } from './types';

export type BodyPoint =
  | 'hips' | 'chest' | 'neck' | 'headTop'
  | 'shL' | 'elbowL' | 'handL' | 'shR' | 'elbowR' | 'handR'
  | 'hipL' | 'kneeL' | 'footL' | 'hipR' | 'kneeR' | 'footR'
  // serpent-plan bodies (the flyers): the neck end of the body, the tail end, the wing roots and their middles
  | 'back' | 'mid' | 'tail' | 'wingL' | 'wingMidL' | 'wingR' | 'wingMidR';

export interface ClimbCap { a: BodyPoint; b: BodyPoint; r: number; zone: Zone }

export const CLIMB: Partial<Record<string, ClimbCap[]>> = {
  // legs → belt/back → shoulders → head (the design's route); arms too
  nephil: [
    { a: 'kneeL', b: 'footL', r: 0.07, zone: 'legL' },
    { a: 'hipL', b: 'kneeL', r: 0.085, zone: 'legL' },
    { a: 'kneeR', b: 'footR', r: 0.07, zone: 'legR' },
    { a: 'hipR', b: 'kneeR', r: 0.085, zone: 'legR' },
    { a: 'hips', b: 'chest', r: 0.16, zone: 'torso' },
    { a: 'shL', b: 'shR', r: 0.085, zone: 'torso' },
    { a: 'shL', b: 'elbowL', r: 0.065, zone: 'armL' },
    { a: 'elbowL', b: 'handL', r: 0.055, zone: 'armL' },
    { a: 'shR', b: 'elbowR', r: 0.065, zone: 'armR' },
    { a: 'elbowR', b: 'handR', r: 0.055, zone: 'armR' },
    { a: 'neck', b: 'headTop', r: 0.1, zone: 'head' },
  ],
  // the flyers (docs/climbing-phase4-plan.md, Part C): the back, the wing roots, the head
  ziz: [
    { a: 'back', b: 'tail', r: 0.14, zone: 'torso' },
    { a: 'wingL', b: 'wingMidL', r: 0.06, zone: 'sig' },
    { a: 'wingR', b: 'wingMidR', r: 0.06, zone: 'sig' },
    { a: 'neck', b: 'headTop', r: 0.08, zone: 'head' },
  ],
  saraph: [
    { a: 'back', b: 'mid', r: 0.1, zone: 'torso' },
    { a: 'mid', b: 'tail', r: 0.08, zone: 'legL' },
    { a: 'wingL', b: 'wingMidL', r: 0.05, zone: 'sig' },
    { a: 'wingR', b: 'wingMidR', r: 0.05, zone: 'sig' },
    { a: 'neck', b: 'headTop', r: 0.07, zone: 'head' },
  ],
};

/** How a ridden monster fights back (docs/climbing-phase4-plan.md, Part A). Ticks and stamina. */
export interface RideRules {
  /** a shake (a roll, for a flyer) lands this often, the first one `first` ticks after you get on */
  every: number;
  first: number;
  /** stamina a held shake costs */
  cost: number;
  /** grabs at a rider in reach with this arm, while it isn't severed */
  grab?: { arm: Zone; anywhere: number[]; front: number[] };
  flies?: boolean;
  /** a surface facing up more than this is somewhere to sit and rest (the default, 0.8, is standing on a top); a
   *  flyer is ridden astride, anywhere on the upper half of its back or wings */
  perch?: number;
}

export const SHAKE_TELL = 6; // ticks of shudder before a shake lands

export const RIDE: Partial<Record<string, RideRules>> = {
  // the club is in the right hand: the left one grabs, at the shoulders, head and arms, or the front of the body
  nephil: { every: 30, first: 25, cost: 15, grab: { arm: 'armL', anywhere: [5, 6, 7, 8, 9, 10], front: [1, 3, 4] } },
  ziz: { every: 50, first: 25, cost: 15, flies: true, perch: 0.3 },
  saraph: { every: 45, first: 25, cost: 15, flies: true, perch: 0.3 },
};

export function climbable(arch: string | undefined): boolean {
  return !!arch && !!CLIMB[arch];
}

/** the zone of capsule `cap`, or null when there's no such capsule */
export function capZone(arch: string, cap: number): Zone | null {
  return CLIMB[arch]?.[cap]?.zone ?? null;
}
