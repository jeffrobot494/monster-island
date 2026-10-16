import type { Faction, Job } from '../types';
export interface Selector {
  kind?: string;
  faction?: Faction;
  jobs?: Job[];
  excludeJobs?: Job[];
  withTag?: string;
  withoutTag?: string;
  includeChampion?: boolean;
  includeIncapacitated?: boolean;
  includeHidden?: boolean;
  pick?: 'all' | 'random' | 'strongest';
  count?: number | [number, number];
  fraction?: number | [number, number];
  min?: number;
}
export type Start = 'now' | { atHour: number };
export type Duration =
  { until: 'dawn' } | { untilHour: number } | { hours: number } | 'permanent';
export interface EffectSpec {
  type: string;
  who?: string;
  [param: string]: unknown;
}
export interface EventDef {
  id: string;
  title: string;
  armText?: string;
  announce: string;
  endText?: string;
  start: Start;
  duration: Duration;
  stacking: 'refresh' | 'stack' | 'skip';
  targets?: Record<string, Selector>;
  effects: EffectSpec[];
}
export interface DeckDef {
  order: string[];
  mode: 'sequential' | 'shuffle';
  onExhausted: 'loop' | 'repeatLast' | 'stop';
}
export interface EventInstance {
  iid: number;
  def: string;
  phase: 'armed' | 'active';
  startAt: number;
  endAt: number | null;
  targets: Record<string, number[]>;
  state: Record<string, unknown>[];
}
export interface EventState {
  deckPos: number;
  deckOrder: string[];
  nextIid: number;
  active: EventInstance[];
  history: { iid: number; def: string; day: number; endedDay?: number }[];
}
export const emptyEvents = (): EventState => ({
  deckPos: 0,
  deckOrder: [],
  nextIid: 1,
  active: [],
  history: [],
});
