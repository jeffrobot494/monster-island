import type { EmitterDef, ShapeDef, ShapePart } from './types';

const bushBase: ShapePart = { prim: 'sphere', size: [0.75, 0.6, 0.75], pos: [0, 0.32, 0], color: '#3f7a35' };
const berry = (x: number, z: number): ShapePart => ({ prim: 'sphere', size: [0.16, 0.16, 0.16], pos: [x, 0.55, z], color: '#d23b4a' });
const berries = [berry(0.22, 0.12), berry(-0.18, 0.2), berry(0.02, -0.25)];

const hut = (lit: boolean): ShapeDef => ({
  parts: [
    { prim: 'cylinder', size: [1.1, 0.7, 1.1], pos: [0, 0.35, 0], color: '#7a5a3c' },
    { prim: 'cone', size: [1.5, 0.8, 1.5], pos: [0, 1.1, 0], color: '#a8893f' },
    { prim: 'box', size: [0.3, 0.42, 0.06], pos: [0, 0.25, 0.55], color: lit ? '#ffd27a' : '#3a2a1c', emissive: lit ? 1 : 0 },
  ],
});
const cottage = (lit: boolean): ShapeDef => ({
  parts: [
    { prim: 'box', size: [1.0, 0.7, 0.9], pos: [0, 0.35, 0], color: '#e9dcc0' },
    { prim: 'box', size: [0.78, 0.78, 1.0], pos: [0, 0.78, 0], rot: [0, 0, 45], color: '#b04a3a' },
    { prim: 'box', size: [0.24, 0.36, 0.05], pos: [0, 0.2, 0.46], color: '#6a4a2c' },
    { prim: 'box', size: [0.2, 0.2, 0.05], pos: [0.3, 0.45, 0.46], color: lit ? '#ffd27a' : '#44506a', emissive: lit ? 1 : 0 },
    { prim: 'box', size: [0.2, 0.2, 0.05], pos: [-0.3, 0.45, 0.46], color: lit ? '#ffd27a' : '#44506a', emissive: lit ? 1 : 0 },
  ],
});

export const CORE_SHAPES: Record<string, ShapeDef> = {
  monster: {
    parts: [
      { prim: 'box', size: [0.55, 0.55, 0.45], pos: [0, 0.32, 0], color: 'tint', anim: { type: 'bob', speed: 3, amount: 0.04 } },
      { prim: 'cone', size: [0.1, 0.22, 0.1], pos: [0.17, 0.7, 0], color: '#f1e6c8' },
      { prim: 'cone', size: [0.1, 0.22, 0.1], pos: [-0.17, 0.7, 0], color: '#f1e6c8' },
      { prim: 'box', size: [0.1, 0.1, 0.04], pos: [0.12, 0.42, 0.23], color: '#ffffff' },
      { prim: 'box', size: [0.1, 0.1, 0.04], pos: [-0.12, 0.42, 0.23], color: '#ffffff' },
      { prim: 'box', size: [0.12, 0.18, 0.12], pos: [0.15, 0.06, 0], color: 'tint' },
      { prim: 'box', size: [0.12, 0.18, 0.12], pos: [-0.15, 0.06, 0], color: 'tint' },
    ],
  },
  human: {
    parts: [
      { prim: 'cylinder', size: [0.3, 0.45, 0.3], pos: [0, 0.25, 0], color: 'tint' },
      { prim: 'sphere', size: [0.28, 0.28, 0.28], pos: [0, 0.62, 0], color: '#f0c8a0' },
      { prim: 'box', size: [0.3, 0.06, 0.3], pos: [0, 0.75, 0], color: '#5a3a22' },
    ],
  },
  hut: hut(false),
  'hut-lit': hut(true),
  cottage: cottage(false),
  'cottage-lit': cottage(true),
  'berry-bush-0': { parts: [bushBase] },
  'berry-bush-1': { parts: [bushBase, berries[0]] },
  'berry-bush-2': { parts: [bushBase, berries[0], berries[1]] },
  'berry-bush-3': { parts: [bushBase, ...berries] },
  mushroom: {
    parts: [
      { prim: 'cylinder', size: [0.08, 0.16, 0.08], pos: [0, 0.08, 0], color: '#efe6d0' },
      { prim: 'sphere', size: [0.26, 0.14, 0.26], pos: [0, 0.18, 0], color: '#c2453a' },
    ],
  },
  gravestone: {
    parts: [
      { prim: 'box', size: [0.34, 0.45, 0.1], pos: [0, 0.22, 0], color: '#9a9a9e' },
      { prim: 'box', size: [0.4, 0.06, 0.3], pos: [0, 0.03, 0.1], color: '#6b8a4e' },
    ],
  },
  shrine: {
    parts: [
      { prim: 'box', size: [1.6, 0.25, 1.6], pos: [0, 0.12, 0], color: '#b9b2a2' },
      { prim: 'box', size: [0.22, 1.3, 0.22], pos: [0.55, 0.9, 0.55], color: '#d8d0bc' },
      { prim: 'box', size: [0.22, 1.3, 0.22], pos: [-0.55, 0.9, 0.55], color: '#d8d0bc' },
      { prim: 'box', size: [0.22, 1.3, 0.22], pos: [0.55, 0.9, -0.55], color: '#d8d0bc' },
      { prim: 'box', size: [0.22, 1.3, 0.22], pos: [-0.55, 0.9, -0.55], color: '#d8d0bc' },
      { prim: 'box', size: [1.5, 0.15, 1.5], pos: [0, 1.6, 0], color: '#d8d0bc' },
      { prim: 'sphere', size: [0.4, 0.4, 0.4], pos: [0, 0.75, 0], color: '#ffe6a0', emissive: 0.9, anim: { type: 'pulse', speed: 1.5, amount: 0.15 } },
    ],
  },
};

export const CORE_EMITTERS: Record<string, EmitterDef> = {
  zzz: { color: '#ffffff', color2: '#b8c8ff', size: 0.18, rate: 1.2, life: 2.5, speed: 0.4, spread: 0.2, gravity: -0.05 },
  puff: { color: '#e8e2d6', size: 0.25, rate: 20, life: 0.8, speed: 1.2, spread: 1, gravity: 0.2 },
  'shrine-1': { color: '#ffe6a0', size: 0.15, rate: 4, life: 1.5, speed: 1.0, spread: 0.15, gravity: -0.3, glow: true },
  'shrine-2': { color: '#ffe6a0', color2: '#ffb0e0', size: 0.2, rate: 12, life: 2.2, speed: 1.6, spread: 0.2, gravity: -0.4, glow: true },
  'shrine-3': { color: '#fff3c0', color2: '#a0e0ff', size: 0.25, rate: 30, life: 3, speed: 2.4, spread: 0.25, gravity: -0.5, glow: true },
};
