import type { EventDef, DeckDef } from './types';
export const EVENTS: EventDef[] = [
  {
    id: 'long-night',
    title: 'The Long Night',
    armText:
      'Dagon swallows the sun. Tomorrow the dark comes early, and it will not hurry.',
    announce: 'The sun sickens in the sky. The long night is coming.',
    endText: 'The long night ends at last.',
    start: { atHour: 14 },
    duration: { untilHour: 9 },
    stacking: 'refresh',
    effects: [
      {
        type: 'darkness',
        ramp: [
          [14, 0],
          [16, 0.95],
          [6, 0.95],
          [8.5, 0],
        ],
      },
      { type: 'clockRate', from: 16, to: 6, rate: 0.6 }, // 14 clock h at 0.6 ≈ 7.8 real min vs 4 for a normal night
      { type: 'atmosphere', fogDensity: 0.08, fogColor: '#1a1f2a' },
      { type: 'windowBonus', hours: 2, reroll: true },
    ],
  },
  {
    id: 'jackals',
    title: 'Jackal Escort',
    announce:
      'Jackals come yipping out of the dark, running at the heels of every beast.',
    endText: 'The jackals slink away at dawn.',
    start: 'now',
    duration: { until: 'dawn' },
    stacking: 'refresh',
    targets: { leaders: { kind: 'monster' } },
    effects: [
      {
        type: 'spawnEscort',
        who: 'leaders',
        unit: 'jackal',
        count: [2, 4],
        maxFood: 150,
        awayFoodPerHour: 10,
      },
    ],
  },
  {
    id: 'frenzy',
    title: 'Frenzy',
    announce: 'Dagon drinks deep. The monsters go mad with blood.',
    endText: 'The frenzy breaks with the dawn.',
    start: 'now',
    duration: { until: 'dawn' },
    stacking: 'refresh',
    targets: { monsters: { kind: 'monster' } },
    effects: [
      { type: 'statMod', who: 'monsters', stat: 'speed', mul: 1.5 },
      { type: 'statMod', who: 'monsters', stat: 'strength', mul: 1.5 },
      { type: 'fx', who: 'monsters', fx: 'frenzy' },
      { type: 'tag', who: 'monsters', tag: 'no-retreat' },
    ],
  },
  {
    id: 'turncoats',
    title: 'Turncoats',
    announce: 'Some in the village hear Dagon whisper, and answer.',
    endText: 'With the dawn the turncoats come back to themselves.',
    start: 'now',
    duration: { until: 'dawn' },
    stacking: 'skip',
    targets: {
      traitors: {
        kind: 'human',
        faction: 'human',
        pick: 'random',
        fraction: [0.1, 0.15],
        min: 1,
        includeHidden: true,
      },
    },
    effects: [
      {
        type: 'convert',
        who: 'traitors',
        to: 'monster',
        brain: 'turncoat',
        fx: 'turncoat',
      },
    ],
  },
  {
    id: 'ascension',
    title: 'Ascension',
    announce: 'Dagon lays a hand on the mightiest of his children.',
    start: 'now',
    duration: 'permanent',
    stacking: 'stack',
    targets: {
      boss: {
        kind: 'monster',
        pick: 'strongest',
        withoutTag: 'ascended',
        count: 1,
      },
    },
    effects: [
      { type: 'statMod', who: 'boss', stat: 'maxHp', mul: 10 },
      { type: 'healFull', who: 'boss' },
      { type: 'scale', who: 'boss', mul: 1.4 },
      { type: 'rename', who: 'boss', pattern: '{name} the Ascended' },
      { type: 'tag', who: 'boss', tag: 'ascended' },
      { type: 'fx', who: 'boss', fx: 'ascended' },
    ],
  },
];
export const DECK: DeckDef = {
  order: ['long-night', 'jackals', 'frenzy', 'turncoats', 'ascension'],
  mode: 'sequential',
  onExhausted: 'loop',
};

export const UNITS = {
  jackal: {
    kind: 'jackal',
    title: 'jackal',
    shape: 'jackal',
    tint: '#a8865a',
    scale: 0.8,
    radiusM: 0.35,
    hp: 20,
    speed: 1.4,
    faction: 'monster' as const,
    tags: ['hittable'],
    brain: 'pack-raider',
    params: {
      leash: 6,
      raidRadius: 10,
      fearRadius: 3.5,
      foodBite: 8,
      biteCooldownTicks: 30,
      lambChance: 0.15,
    },
  },
};
