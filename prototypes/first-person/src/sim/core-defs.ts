// Core shapes and emitters. Humans are ~0.8 tall; structures sit on one tile.
import type { EmitterDef, ShapeDef, ShapePart } from './types';
import { MONSTER_SHAPES } from './monsters-gen';

export const JOB_TINT: Record<string, string> = {
  shepherd: '#e6dcc4', vinedresser: '#7a3a5a', woodcutter: '#6a4a2a', fisherman: '#3a6a8a', farmer: '#c8a050', guard: '#8a2a2a', champion: '#b02a20',
};

const skin = '#c8946a';
const body = (extra: ShapePart[] = []): ShapeDef => ({
  parts: [
    { prim: 'cylinder', size: [0.26, 0.42, 0.26], pos: [0, 0.27, 0], color: 'tint' },
    { prim: 'box', size: [0.08, 0.12, 0.1], pos: [0.07, 0.04, 0], color: '#6a4a30' },
    { prim: 'box', size: [0.08, 0.12, 0.1], pos: [-0.07, 0.04, 0], color: '#6a4a30' },
    { prim: 'sphere', size: [0.22, 0.24, 0.22], pos: [0, 0.6, 0], color: skin },
    { prim: 'box', size: [0.07, 0.26, 0.07], pos: [0.17, 0.32, 0], color: 'tint' },
    { prim: 'box', size: [0.07, 0.26, 0.07], pos: [-0.17, 0.32, 0], color: 'tint' },
    ...extra,
  ],
});

const house = (lit: boolean): ShapeDef => ({
  parts: [
    { prim: 'box', size: [1.1, 0.75, 1.0], pos: [0, 0.37, 0], color: '#c9a77c' },
    { prim: 'box', size: [1.2, 0.08, 1.1], pos: [0, 0.78, 0], color: '#8a6a4a' },
    { prim: 'box', size: [0.26, 0.42, 0.04], pos: [0, 0.21, 0.51], color: '#4a3220' },
    { prim: 'box', size: [0.16, 0.14, 0.04], pos: [0.32, 0.5, 0.51], color: lit ? '#ffcf70' : '#3a2a1c', emissive: lit ? 1 : 0 },
    { prim: 'box', size: [0.3, 0.2, 0.3], pos: [-0.3, 0.92, -0.25], color: '#b8956a' },
  ],
});

export const CORE_SHAPES: Record<string, ShapeDef> = {
  ...MONSTER_SHAPES,
  // a 2.4 m bronze-tipped spear lying along +z (on the ground or in flight)
  spear: { parts: [
    { prim: 'cylinder', size: [0.022, 1.0, 0.022], pos: [0, 0.02, -0.04], rot: [90, 0, 0], color: '#7a5634' },
    { prim: 'cone', size: [0.045, 0.13, 0.045], pos: [0, 0.02, 0.52], rot: [90, 0, 0], color: '#d0a050', emissive: 0.08 },
  ] },
  // the same spear standing in the rack
  'spear-up': { parts: [
    { prim: 'cylinder', size: [0.022, 1.0, 0.022], pos: [0, 0.5, 0], rot: [0, 0, 4], color: '#7a5634' },
    { prim: 'cone', size: [0.045, 0.13, 0.045], pos: [-0.04, 1.06, 0], rot: [0, 0, 4], color: '#d0a050', emissive: 0.08 },
  ] },
  'spear-rack': { parts: [
    { prim: 'box', size: [0.06, 0.5, 0.06], pos: [0.55, 0.25, 0], color: '#5a3a20' },
    { prim: 'box', size: [0.06, 0.5, 0.06], pos: [-0.55, 0.25, 0], color: '#5a3a20' },
    { prim: 'box', size: [1.2, 0.05, 0.06], pos: [0, 0.46, 0], color: '#6a4a2a' },
    { prim: 'box', size: [1.2, 0.04, 0.16], pos: [0, 0.03, 0], color: '#5a3a20' },
  ] },
  human: body(),
  shepherd: body([{ prim: 'cylinder', size: [0.03, 0.8, 0.03], pos: [0.22, 0.4, 0.06], color: '#7a5a3a' }]),
  'guard-bare': body([{ prim: 'cone', size: [0.25, 0.14, 0.25], pos: [0, 0.76, 0], color: '#a07040' }]),
  guard: body([
    { prim: 'cylinder', size: [0.03, 1.0, 0.03], pos: [0.22, 0.5, 0.08], color: '#6a4a2a' },
    { prim: 'cone', size: [0.06, 0.14, 0.06], pos: [0.22, 1.05, 0.08], color: '#c08a4a' },
    { prim: 'cone', size: [0.25, 0.14, 0.25], pos: [0, 0.76, 0], color: '#a07040' },
  ]),
  champion: {
    parts: [
      { prim: 'cylinder', size: [0.3, 0.44, 0.3], pos: [0, 0.28, 0], color: '#d8c8a0' },
      { prim: 'box', size: [0.34, 0.5, 0.06], pos: [0, 0.34, -0.15], color: 'tint' },
      { prim: 'box', size: [0.09, 0.12, 0.1], pos: [0.08, 0.04, 0], color: '#5a3a20' },
      { prim: 'box', size: [0.09, 0.12, 0.1], pos: [-0.08, 0.04, 0], color: '#5a3a20' },
      { prim: 'sphere', size: [0.23, 0.25, 0.23], pos: [0, 0.62, 0], color: skin },
      { prim: 'cone', size: [0.27, 0.2, 0.27], pos: [0, 0.77, 0], color: '#c89040' },
      { prim: 'box', size: [0.03, 0.12, 0.2], pos: [0, 0.86, -0.02], color: '#b02a20' },
      { prim: 'box', size: [0.05, 0.42, 0.05], pos: [0.22, 0.38, 0.14], rot: [40, 0, 0], color: '#e0b060' },
      { prim: 'cylinder', size: [0.28, 0.04, 0.28], pos: [-0.2, 0.34, 0.06], rot: [0, 0, 80], color: '#a07030' },
    ],
  },
  goat: {
    parts: [
      { prim: 'box', size: [0.2, 0.18, 0.36], pos: [0, 0.26, 0], color: 'tint' },
      { prim: 'box', size: [0.12, 0.14, 0.14], pos: [0, 0.36, 0.22], color: 'tint' },
      { prim: 'cone', size: [0.04, 0.12, 0.04], pos: [0.04, 0.48, 0.2], rot: [-30, 0, 0], color: '#d8ccb0' },
      { prim: 'cone', size: [0.04, 0.12, 0.04], pos: [-0.04, 0.48, 0.2], rot: [-30, 0, 0], color: '#d8ccb0' },
      { prim: 'box', size: [0.05, 0.18, 0.05], pos: [0.07, 0.09, 0.12], color: '#3a2a20' },
      { prim: 'box', size: [0.05, 0.18, 0.05], pos: [-0.07, 0.09, 0.12], color: '#3a2a20' },
      { prim: 'box', size: [0.05, 0.18, 0.05], pos: [0.07, 0.09, -0.12], color: '#3a2a20' },
      { prim: 'box', size: [0.05, 0.18, 0.05], pos: [-0.07, 0.09, -0.12], color: '#3a2a20' },
    ],
  },
  ox: {
    parts: [
      { prim: 'box', size: [0.34, 0.3, 0.6], pos: [0, 0.4, 0], color: 'tint' },
      { prim: 'box', size: [0.2, 0.2, 0.22], pos: [0, 0.46, 0.38], color: 'tint' },
      { prim: 'cone', size: [0.05, 0.2, 0.05], pos: [0.13, 0.58, 0.38], rot: [0, 0, -60], color: '#e8dcc0' },
      { prim: 'cone', size: [0.05, 0.2, 0.05], pos: [-0.13, 0.58, 0.38], rot: [0, 0, 60], color: '#e8dcc0' },
      { prim: 'box', size: [0.08, 0.26, 0.08], pos: [0.11, 0.13, 0.2], color: 'tint' },
      { prim: 'box', size: [0.08, 0.26, 0.08], pos: [-0.11, 0.13, 0.2], color: 'tint' },
      { prim: 'box', size: [0.08, 0.26, 0.08], pos: [0.11, 0.13, -0.2], color: 'tint' },
      { prim: 'box', size: [0.08, 0.26, 0.08], pos: [-0.11, 0.13, -0.2], color: 'tint' },
    ],
  },
  house: house(false),
  'house-lit': house(true),
  'village-altar': {
    parts: [
      { prim: 'box', size: [1.2, 0.2, 1.2], pos: [0, 0.1, 0], color: '#bfb39a' },
      { prim: 'box', size: [0.7, 0.5, 0.7], pos: [0, 0.45, 0], color: '#d8ccb0' },
      { prim: 'cone', size: [0.1, 0.18, 0.1], pos: [0.3, 0.78, 0.3], color: '#d8ccb0' },
      { prim: 'cone', size: [0.1, 0.18, 0.1], pos: [-0.3, 0.78, 0.3], color: '#d8ccb0' },
      { prim: 'cone', size: [0.1, 0.18, 0.1], pos: [0.3, 0.78, -0.3], color: '#d8ccb0' },
      { prim: 'cone', size: [0.1, 0.18, 0.1], pos: [-0.3, 0.78, -0.3], color: '#d8ccb0' },
      { prim: 'cone', size: [0.3, 0.36, 0.3], pos: [0, 0.86, 0], color: '#ff9a30', emissive: 1, opacity: 0.85, anim: { type: 'pulse', speed: 7, amount: 0.15 } },
    ],
  },
  'high-altar': {
    parts: [
      { prim: 'box', size: [1.6, 0.2, 1.6], pos: [0, 0.1, 0], color: '#5a5048' },
      { prim: 'box', size: [1.0, 0.45, 0.6], pos: [0, 0.42, 0], color: '#3a3430' },
      { prim: 'box', size: [0.94, 0.04, 0.54], pos: [0, 0.66, 0], color: '#5a1a14' },
      { prim: 'cone', size: [0.12, 0.5, 0.12], pos: [0.42, 0.9, 0.22], rot: [0, 0, -20], color: '#2a2420' },
      { prim: 'cone', size: [0.12, 0.5, 0.12], pos: [-0.42, 0.9, 0.22], rot: [0, 0, 20], color: '#2a2420' },
      { prim: 'cylinder', size: [0.2, 1.6, 0.2], pos: [0.7, 0.8, -0.6], color: '#4a4440' },
      { prim: 'cylinder', size: [0.2, 1.6, 0.2], pos: [-0.7, 0.8, -0.6], color: '#4a4440' },
    ],
  },
  fold: {
    parts: [
      { prim: 'box', size: [1.4, 0.3, 0.12], pos: [0, 0.15, 0.65], color: '#a89070' },
      { prim: 'box', size: [1.4, 0.3, 0.12], pos: [0, 0.15, -0.65], color: '#a89070' },
      { prim: 'box', size: [0.12, 0.3, 1.4], pos: [0.65, 0.15, 0], color: '#a89070' },
      { prim: 'box', size: [0.12, 0.3, 1.4], pos: [-0.65, 0.15, 0], color: '#a89070' },
    ],
  },
  lamb: {
    parts: [
      { prim: 'sphere', size: [0.26, 0.2, 0.32], pos: [0, 0.18, 0], color: '#f2ecdc' },
      { prim: 'sphere', size: [0.12, 0.12, 0.14], pos: [0, 0.24, 0.18], color: '#3a3028' },
    ],
  },
  granary: {
    parts: [
      { prim: 'cylinder', size: [0.9, 0.6, 0.9], pos: [0, 0.3, 0], color: '#c9a77c' },
      { prim: 'sphere', size: [0.9, 0.7, 0.9], pos: [0, 0.6, 0], color: '#b8956a' },
    ],
  },
  'lair-1': { // cave beneath the giant cedar
    parts: [
      { prim: 'cylinder', size: [0.5, 2.4, 0.5], pos: [0, 1.2, -0.3], color: '#5a3a24' },
      { prim: 'cone', size: [2.4, 1.6, 2.4], pos: [0, 2.4, -0.3], color: '#24482a' },
      { prim: 'cone', size: [1.8, 1.4, 1.8], pos: [0, 3.2, -0.3], color: '#2a5530' },
      { prim: 'sphere', size: [0.9, 0.5, 0.5], pos: [0, 0.15, 0.25], color: '#0c0a08' },
    ],
  },
  'lair-2': { // wine-press cave
    parts: [
      { prim: 'box', size: [1.6, 0.9, 1.0], pos: [0, 0.45, -0.3], color: '#a09080' },
      { prim: 'cylinder', size: [0.8, 0.3, 0.8], pos: [0.5, 0.15, 0.5], color: '#8a7a6a' },
      { prim: 'box', size: [0.6, 0.55, 0.06], pos: [-0.2, 0.28, 0.21], color: '#0c0a08' },
    ],
  },
  'lair-3': { // sunken cistern
    parts: [
      { prim: 'cylinder', size: [1.6, 0.25, 1.6], pos: [0, 0.12, 0], color: '#bdb5a0' },
      { prim: 'cylinder', size: [1.2, 0.05, 1.2], pos: [0, 0.26, 0], color: '#0e1a1a' },
      { prim: 'box', size: [0.2, 0.9, 0.2], pos: [0.7, 0.45, 0.7], color: '#e8e2d0' },
    ],
  },
  'lair-4': { // cliff tomb
    parts: [
      { prim: 'box', size: [2.0, 1.6, 0.8], pos: [0, 0.8, -0.4], color: '#8a8070' },
      { prim: 'box', size: [0.6, 0.8, 0.06], pos: [0, 0.4, 0.02], color: '#0c0a08' },
      { prim: 'box', size: [0.8, 0.1, 0.1], pos: [0, 0.86, 0.02], color: '#6a6050' },
    ],
  },
  'lair-5': { // ruined giant's hall
    parts: [
      { prim: 'cylinder', size: [0.4, 2.2, 0.4], pos: [0.8, 1.1, 0], color: '#c8bca0' },
      { prim: 'cylinder', size: [0.4, 1.3, 0.4], pos: [-0.8, 0.65, 0], color: '#c8bca0' },
      { prim: 'box', size: [2.0, 0.3, 0.5], pos: [0.2, 0.15, 0.7], rot: [0, 20, 0], color: '#b0a488' },
      { prim: 'box', size: [0.8, 0.6, 0.06], pos: [0, 0.3, -0.3], color: '#0c0a08' },
    ],
  },
  'lair-6': { // catacomb stair
    parts: [
      { prim: 'box', size: [1.0, 0.1, 1.0], pos: [0, 0.05, 0], color: '#0c0a08' },
      { prim: 'box', size: [1.2, 0.3, 0.12], pos: [0, 0.15, -0.55], color: '#6a6058' },
      { prim: 'box', size: [0.12, 0.3, 1.0], pos: [0.55, 0.15, 0], color: '#6a6058' },
      { prim: 'box', size: [0.12, 0.3, 1.0], pos: [-0.55, 0.15, 0], color: '#6a6058' },
    ],
  },
  'corpse-upper': {
    parts: [
      { prim: 'cylinder', size: [0.26, 0.2, 0.26], pos: [0, 0.1, 0], color: 'tint' },
      { prim: 'sphere', size: [0.22, 0.22, 0.22], pos: [0, 0.3, 0], color: skin },
      { prim: 'cylinder', size: [0.24, 0.03, 0.24], pos: [0, 0.01, 0], color: '#7a0a0a' },
    ],
  },
  'corpse-lower': {
    parts: [
      { prim: 'cylinder', size: [0.26, 0.2, 0.26], pos: [0, 0.1, 0], color: 'tint' },
      { prim: 'box', size: [0.08, 0.14, 0.1], pos: [0.07, 0.0, 0], color: '#6a4a30' },
      { prim: 'cylinder', size: [0.24, 0.03, 0.24], pos: [0, 0.21, 0], color: '#7a0a0a' },
    ],
  },
  bones: {
    parts: [
      { prim: 'sphere', size: [0.16, 0.14, 0.16], pos: [0, 0.07, 0.2], color: '#e8e0cc' },
      { prim: 'box', size: [0.06, 0.04, 0.4], pos: [0.05, 0.03, -0.05], rot: [0, 20, 0], color: '#ddd4be' },
      { prim: 'box', size: [0.06, 0.04, 0.34], pos: [-0.08, 0.03, -0.1], rot: [0, -25, 0], color: '#ddd4be' },
      { prim: 'box', size: [0.2, 0.04, 0.05], pos: [0, 0.03, 0.05], color: '#ddd4be' },
    ],
  },
  'part-limb': { parts: [{ prim: 'box', size: [0.07, 0.07, 0.26], pos: [0, 0.04, 0], color: 'tint' }, { prim: 'sphere', size: [0.08, 0.08, 0.08], pos: [0, 0.04, 0.14], color: '#8a0a0a' }] },
  'part-head': { parts: [{ prim: 'sphere', size: [0.2, 0.2, 0.2], pos: [0, 0.1, 0], color: 'tint' }, { prim: 'cylinder', size: [0.1, 0.03, 0.1], pos: [0, 0.0, 0], color: '#8a0a0a' }] },
  'part-horn': { parts: [{ prim: 'cone', size: [0.08, 0.3, 0.08], pos: [0, 0.04, 0], rot: [90, 0, 0], color: '#d8ccb0' }] },
  'part-wing': { parts: [{ prim: 'box', size: [0.5, 0.03, 0.24], pos: [0, 0.03, 0], color: 'tint' }] },
  blood: { parts: [{ prim: 'cylinder', size: [0.7, 0.02, 0.6], pos: [0, 0.01, 0], color: '#6a0808', opacity: 0.85 }] },
  'bound-ropes': { parts: [{ prim: 'box', size: [0.6, 0.04, 0.04], pos: [0, 0.3, 0], color: '#b89a60' }] },
};

export const CORE_EMITTERS: Record<string, EmitterDef> = {
  blood: { color: '#b01010', color2: '#600606', size: 0.12, rate: 40, life: 0.7, speed: 2.2, spread: 0.8, gravity: 6 },
  'blood-big': { color: '#c01212', color2: '#500404', size: 0.16, rate: 90, life: 0.9, speed: 3.2, spread: 0.9, gravity: 6 },
  fire: { color: '#ffb030', color2: '#ff4010', size: 0.22, rate: 26, life: 0.8, speed: 1.0, spread: 0.25, gravity: -1.2, glow: true },
  smoke: { color: '#5a5450', color2: '#2a2624', size: 0.3, rate: 6, life: 2.4, speed: 0.6, spread: 0.2, gravity: -0.3 },
  pillar: { color: '#fff0b0', color2: '#ffd070', size: 0.25, rate: 60, life: 1.6, speed: 3.5, spread: 0.05, gravity: -1, glow: true },
  'dark-pillar': { color: '#a01020', color2: '#200408', size: 0.3, rate: 50, life: 1.8, speed: 3, spread: 0.06, gravity: -1, glow: true },
  whiff: { color: '#e8e2d6', size: 0.18, rate: 25, life: 0.5, speed: 1.4, spread: 1, gravity: 0.5 },
  dust: { color: '#c8b48a', size: 0.22, rate: 30, life: 0.8, speed: 1.4, spread: 1, gravity: 0.6 },
  levelup: { color: '#ffe680', color2: '#ffffff', size: 0.16, rate: 50, life: 1.2, speed: 2, spread: 0.3, gravity: -1.5, glow: true },
  roar: { color: '#ff6040', size: 0.2, rate: 40, life: 0.5, speed: 3, spread: 1, gravity: 0, glow: true },
  torch: { color: '#ffb040', color2: '#ff6010', size: 0.14, rate: 10, life: 0.5, speed: 0.6, spread: 0.15, gravity: -1, glow: true },
  altar: { color: '#ffb040', color2: '#ff6010', size: 0.16, rate: 8, life: 0.8, speed: 0.8, spread: 0.2, gravity: -1, glow: true },
};
