// Climb volumes (docs/climbing-phase3-plan.md, Part A): capsules between named body points, radii in shape units
// (the entity's scale sizes them). The point names are shared by the procedural rigs (rigs.ts, biped) and the
// generated models (glb-rig.ts, MODELS.points), so one table drives both. Pure: the sim and the renderer use it.
import type { Zone } from './types';

export type BodyPoint =
  | 'hips' | 'chest' | 'neck' | 'headTop'
  | 'shL' | 'elbowL' | 'handL' | 'shR' | 'elbowR' | 'handR'
  | 'hipL' | 'kneeL' | 'footL' | 'hipR' | 'kneeR' | 'footR';

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
};

export function climbable(arch: string | undefined): boolean {
  return !!arch && !!CLIMB[arch];
}

/** the zone of capsule `cap`, or null when there's no such capsule */
export function capZone(arch: string, cap: number): Zone | null {
  return CLIMB[arch]?.[cap]?.zone ?? null;
}
