// Monster archetypes and per-island generation (§6.1, §6.5). Pure and seeded.
import { Rng, hashSeed } from './rng';
import { makeMonsterName } from './lore';
import type { DmgType, ShapeDef } from './types';

export type Hours = 'day' | 'night' | 'dusk-dawn' | 'restless';

export interface Archetype {
  id: string;
  display: string;
  hp: number;
  scale: number;
  speed: number;
  dmg: number;
  dmgType: DmgType;
  reach: number;
  sig: string; // signature limb name
  hours: Hours;
  affinity: number[]; // region ids
  flies?: boolean;
  swims?: boolean;
  palette: string[];
  special: string;
}

// Region ids: 0 village, 1 cedar, 2 olive, 3 salt, 4 wilderness, 5 ruins, 6 high place
export const ARCHETYPES: Archetype[] = [
  { id: 'nephil', display: 'Nephil', hp: 320, scale: 2.2, speed: 0.85, dmg: 22, dmgType: 'crush', reach: 1.9, sig: 'club arm', hours: 'day', affinity: [5, 1], palette: ['#b08a6a', '#9a7458', '#c29a78'], special: 'Tears grabbed victims in two.' },
  { id: 'saraph', display: 'Fiery flying serpent', hp: 170, scale: 1.3, speed: 1.35, dmg: 11, dmgType: 'fire', reach: 1.4, sig: 'wings', hours: 'dusk-dawn', affinity: [4, 6], flies: true, palette: ['#d0682a', '#c84a1e', '#e08a2a'], special: 'Flies over water and cliffs; its bite burns.' },
  { id: 'seir', display: "Se'ir, goat-demon", hp: 210, scale: 1.5, speed: 1.2, dmg: 14, dmgType: 'pierce', reach: 1.5, sig: 'horns', hours: 'dusk-dawn', affinity: [4, 1], palette: ['#5a4a3a', '#6a5040', '#4a3c30'], special: 'Charges: hits harder after a run.' },
  { id: 'lilit', display: 'Lilit, night hag', hp: 150, scale: 1.25, speed: 1.3, dmg: 13, dmgType: 'slash', reach: 1.4, sig: 'talons', hours: 'night', affinity: [5, 6], palette: ['#4a4a5e', '#3e3a52', '#5a5068'], special: 'Sees in the dark.' },
  { id: 'rahab', display: 'Rahab, marsh dragon', hp: 260, scale: 1.8, speed: 0.95, dmg: 18, dmgType: 'bite', reach: 1.7, sig: 'jaws', hours: 'night', affinity: [3], swims: true, palette: ['#4e6a4a', '#3e5a48', '#5a7050'], special: 'Swims through shallow water.' },
  { id: 'anak', display: 'Anak, tomb ghoul', hp: 280, scale: 1.9, speed: 0.95, dmg: 17, dmgType: 'crush', reach: 1.7, sig: 'grasping hands', hours: 'night', affinity: [4, 5], palette: ['#a8a898', '#9a9c8c', '#b4b0a0'], special: 'Feeds on the dead.' },
  { id: 'reem', display: "Re'em, wild-ox demon", hp: 240, scale: 1.7, speed: 1.2, dmg: 16, dmgType: 'pierce', reach: 1.6, sig: 'horns', hours: 'day', affinity: [2, 3], palette: ['#3a2c24', '#4a3428', '#2e2420'], special: 'Impales on its horns.' },
  { id: 'tannin', display: 'Tannin, serpent', hp: 200, scale: 1.6, speed: 1.1, dmg: 15, dmgType: 'bite', reach: 1.6, sig: 'coils', hours: 'restless', affinity: [1, 2, 3, 4, 5, 6], palette: ['#2e5a4a', '#3a6a3a', '#24483e'], special: 'Constricts what it grabs.' },
];

export const ARCH = Object.fromEntries(ARCHETYPES.map((a) => [a.id, a])) as Record<string, Archetype>;

export interface GeneratedMonster {
  archetype: string;
  name: string;
  epithet: string;
  region: number;
  hp: number;
  dmg: number;
  tint: string;
  hours: Hours;
}

/** Pick 6 monsters, one per region 1–6, with rolled stats. */
export function generateMonsters(seed: number): GeneratedMonster[] {
  const rng = new Rng(hashSeed(seed, 'monsters'));
  const used = new Set<string>();
  const out: GeneratedMonster[] = [];
  for (let region = 1; region <= 6; region++) {
    const fits = ARCHETYPES.filter((a) => !used.has(a.id) && a.affinity.includes(region) && a.id !== 'tannin');
    const pool = fits.length ? fits : ARCHETYPES.filter((a) => !used.has(a.id));
    const a = rng.pick(pool)!;
    used.add(a.id);
    const n = makeMonsterName(rng);
    out.push({
      archetype: a.id, name: n.name, epithet: n.epithet, region,
      hp: Math.round(a.hp * (0.85 + rng.next() * 0.3)),
      dmg: Math.round(a.dmg * (0.9 + rng.next() * 0.2) * 10) / 10,
      tint: rng.pick(a.palette)!,
      hours: rng.chance(0.25) ? 'restless' : a.hours,
    });
  }
  return out;
}

/** Neighbor graph: random spanning tree, then extra edges until each node has 2–3 neighbors (max 3). */
export function neighborGraph(n: number, seed: number): number[][] {
  const rng = new Rng(hashSeed(seed, 'graph'));
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set());
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const link = (a: number, b: number) => {
    adj[a].add(b);
    adj[b].add(a);
  };
  for (let i = 1; i < n; i++) {
    // attach to an earlier node that still has room
    const cands = order.slice(0, i).filter((k) => adj[k].size < 3);
    link(order[i], rng.pick(cands.length ? cands : order.slice(0, i))!);
  }
  for (let guard = 0; guard < 200; guard++) {
    const low = order.filter((k) => adj[k].size < 2);
    if (!low.length) break;
    const a = low[0];
    const cands = order.filter((k) => k !== a && !adj[a].has(k) && adj[k].size < 3);
    if (!cands.length) break;
    link(a, rng.pick(cands)!);
  }
  return adj.map((s) => [...s].sort((x, y) => x - y));
}

// ---------- shapes (≈1 unit tall at scale 1, facing +z) ----------

const T = 'tint';
export const MONSTER_SHAPES: Record<string, ShapeDef> = {
  nephil: {
    parts: [
      { prim: 'box', size: [0.16, 0.42, 0.18], pos: [0.12, 0.21, 0], color: '#5a4030' },
      { prim: 'box', size: [0.16, 0.42, 0.18], pos: [-0.12, 0.21, 0], color: '#5a4030' },
      { prim: 'box', size: [0.46, 0.4, 0.28], pos: [0, 0.6, 0], color: T },
      { prim: 'box', size: [0.48, 0.1, 0.3], pos: [0, 0.44, 0], color: '#6a4a2a' },
      { prim: 'sphere', size: [0.24, 0.26, 0.24], pos: [0, 0.92, 0.02], color: T },
      { prim: 'box', size: [0.2, 0.12, 0.08], pos: [0, 0.84, 0.12], color: '#3a2a1a' },
      { prim: 'box', size: [0.12, 0.42, 0.12], pos: [0.3, 0.55, 0.04], rot: [-20, 0, 0], color: T },
      { prim: 'box', size: [0.12, 0.42, 0.12], pos: [-0.3, 0.55, 0.04], rot: [-20, 0, 0], color: T },
      { prim: 'cylinder', size: [0.1, 0.55, 0.1], pos: [0.34, 0.36, 0.28], rot: [70, 0, 0], color: '#4a3220' },
      { prim: 'sphere', size: [0.2, 0.2, 0.2], pos: [0.34, 0.28, 0.52], color: '#3a2a1a' },
    ],
  },
  saraph: {
    parts: [
      { prim: 'sphere', size: [0.26, 0.24, 0.3], pos: [0, 0.62, 0.22], color: T, anim: { type: 'bob', speed: 4, amount: 0.06 } },
      { prim: 'sphere', size: [0.3, 0.26, 0.34], pos: [0, 0.58, -0.02], color: T, anim: { type: 'bob', speed: 4, amount: 0.06 } },
      { prim: 'sphere', size: [0.24, 0.2, 0.28], pos: [0, 0.54, -0.26], color: T, anim: { type: 'bob', speed: 4, amount: 0.05 } },
      { prim: 'cone', size: [0.14, 0.34, 0.14], pos: [0, 0.5, -0.48], rot: [-90, 0, 0], color: T },
      { prim: 'cone', size: [0.2, 0.22, 0.2], pos: [0, 0.66, 0.44], rot: [90, 0, 0], color: '#f0b040', emissive: 0.6 },
      { prim: 'box', size: [0.62, 0.03, 0.26], pos: [0.36, 0.7, 0], rot: [0, 0, 18], color: '#f08a30', emissive: 0.5, opacity: 0.85, anim: { type: 'sway', speed: 8, amount: 0.35 } },
      { prim: 'box', size: [0.62, 0.03, 0.26], pos: [-0.36, 0.7, 0], rot: [0, 0, -18], color: '#f08a30', emissive: 0.5, opacity: 0.85, anim: { type: 'sway', speed: 8, amount: -0.35 } },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [0.07, 0.7, 0.34], color: '#fff2a0', emissive: 1 },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [-0.07, 0.7, 0.34], color: '#fff2a0', emissive: 1 },
    ],
  },
  seir: {
    parts: [
      { prim: 'box', size: [0.12, 0.38, 0.14], pos: [0.1, 0.19, 0], rot: [12, 0, 0], color: '#2a2018' },
      { prim: 'box', size: [0.12, 0.38, 0.14], pos: [-0.1, 0.19, 0], rot: [12, 0, 0], color: '#2a2018' },
      { prim: 'box', size: [0.36, 0.36, 0.24], pos: [0, 0.54, 0], color: T },
      { prim: 'box', size: [0.1, 0.34, 0.1], pos: [0.24, 0.5, 0.04], color: T },
      { prim: 'box', size: [0.1, 0.34, 0.1], pos: [-0.24, 0.5, 0.04], color: T },
      { prim: 'box', size: [0.18, 0.22, 0.28], pos: [0, 0.82, 0.08], color: T },
      { prim: 'cone', size: [0.08, 0.36, 0.08], pos: [0.1, 1.0, -0.04], rot: [-40, 0, 20], color: '#d8ccb0' },
      { prim: 'cone', size: [0.08, 0.36, 0.08], pos: [-0.1, 1.0, -0.04], rot: [-40, 0, -20], color: '#d8ccb0' },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [0.06, 0.86, 0.22], color: '#ffd040', emissive: 0.9 },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [-0.06, 0.86, 0.22], color: '#ffd040', emissive: 0.9 },
      { prim: 'cone', size: [0.08, 0.14, 0.08], pos: [0, 0.68, 0.22], rot: [180, 0, 0], color: '#2a2018' },
    ],
  },
  lilit: {
    parts: [
      { prim: 'cone', size: [0.5, 0.72, 0.5], pos: [0, 0.36, 0], color: T },
      { prim: 'sphere', size: [0.3, 0.28, 0.28], pos: [0, 0.82, 0.02], color: '#8a8070' },
      { prim: 'sphere', size: [0.09, 0.09, 0.06], pos: [0.07, 0.84, 0.13], color: '#ffe060', emissive: 1 },
      { prim: 'sphere', size: [0.09, 0.09, 0.06], pos: [-0.07, 0.84, 0.13], color: '#ffe060', emissive: 1 },
      { prim: 'cone', size: [0.06, 0.1, 0.06], pos: [0, 0.78, 0.16], rot: [100, 0, 0], color: '#3a3020' },
      { prim: 'box', size: [0.5, 0.04, 0.22], pos: [0.32, 0.6, -0.04], rot: [0, 0, -30], color: T, anim: { type: 'sway', speed: 3, amount: 0.2 } },
      { prim: 'box', size: [0.5, 0.04, 0.22], pos: [-0.32, 0.6, -0.04], rot: [0, 0, 30], color: T, anim: { type: 'sway', speed: 3, amount: -0.2 } },
      { prim: 'cone', size: [0.05, 0.16, 0.05], pos: [0.5, 0.46, 0.06], rot: [160, 0, 0], color: '#e8e0c8' },
      { prim: 'cone', size: [0.05, 0.16, 0.05], pos: [-0.5, 0.46, 0.06], rot: [160, 0, 0], color: '#e8e0c8' },
    ],
  },
  rahab: {
    parts: [
      { prim: 'box', size: [0.4, 0.26, 0.7], pos: [0, 0.26, 0], color: T },
      { prim: 'box', size: [0.3, 0.16, 0.36], pos: [0, 0.3, 0.5], color: T },
      { prim: 'box', size: [0.28, 0.08, 0.34], pos: [0, 0.18, 0.52], color: '#8a3a2a' },
      { prim: 'cone', size: [0.22, 0.6, 0.18], pos: [0, 0.22, -0.62], rot: [-90, 0, 0], color: T, anim: { type: 'sway', speed: 2, amount: 0.15 } },
      { prim: 'box', size: [0.1, 0.14, 0.1], pos: [0.22, 0.07, 0.2], color: T },
      { prim: 'box', size: [0.1, 0.14, 0.1], pos: [-0.22, 0.07, 0.2], color: T },
      { prim: 'box', size: [0.1, 0.14, 0.1], pos: [0.22, 0.07, -0.2], color: T },
      { prim: 'box', size: [0.1, 0.14, 0.1], pos: [-0.22, 0.07, -0.2], color: T },
      { prim: 'cone', size: [0.08, 0.12, 0.08], pos: [0, 0.42, 0.1], color: '#2a3a28' },
      { prim: 'cone', size: [0.08, 0.12, 0.08], pos: [0, 0.42, -0.14], color: '#2a3a28' },
      { prim: 'sphere', size: [0.06, 0.06, 0.06], pos: [0.1, 0.4, 0.42], color: '#e0ff60', emissive: 0.9 },
      { prim: 'sphere', size: [0.06, 0.06, 0.06], pos: [-0.1, 0.4, 0.42], color: '#e0ff60', emissive: 0.9 },
    ],
  },
  anak: {
    parts: [
      { prim: 'box', size: [0.14, 0.32, 0.14], pos: [0.12, 0.16, 0], color: T },
      { prim: 'box', size: [0.14, 0.32, 0.14], pos: [-0.12, 0.16, 0], color: T },
      { prim: 'box', size: [0.4, 0.42, 0.26], pos: [0, 0.52, 0.06], rot: [30, 0, 0], color: T },
      { prim: 'sphere', size: [0.2, 0.22, 0.2], pos: [0, 0.74, 0.26], color: T },
      { prim: 'box', size: [0.1, 0.56, 0.1], pos: [0.27, 0.4, 0.22], rot: [-10, 0, 0], color: T },
      { prim: 'box', size: [0.1, 0.56, 0.1], pos: [-0.27, 0.4, 0.22], rot: [-10, 0, 0], color: T },
      { prim: 'box', size: [0.16, 0.06, 0.16], pos: [0.27, 0.11, 0.26], color: '#7a7a6a' },
      { prim: 'box', size: [0.16, 0.06, 0.16], pos: [-0.27, 0.11, 0.26], color: '#7a7a6a' },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [0.05, 0.76, 0.36], color: '#c0ffc0', emissive: 0.8 },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [-0.05, 0.76, 0.36], color: '#c0ffc0', emissive: 0.8 },
      { prim: 'box', size: [0.4, 0.14, 0.2], pos: [0, 0.32, 0.04], color: '#4a3a2a' },
    ],
  },
  reem: {
    parts: [
      { prim: 'box', size: [0.42, 0.34, 0.72], pos: [0, 0.48, 0], color: T },
      { prim: 'box', size: [0.24, 0.24, 0.3], pos: [0, 0.52, 0.48], color: T },
      { prim: 'box', size: [0.12, 0.32, 0.12], pos: [0.14, 0.16, 0.24], color: T },
      { prim: 'box', size: [0.12, 0.32, 0.12], pos: [-0.14, 0.16, 0.24], color: T },
      { prim: 'box', size: [0.12, 0.32, 0.12], pos: [0.14, 0.16, -0.24], color: T },
      { prim: 'box', size: [0.12, 0.32, 0.12], pos: [-0.14, 0.16, -0.24], color: T },
      { prim: 'cone', size: [0.07, 0.5, 0.07], pos: [0.18, 0.66, 0.66], rot: [70, 0, -15], color: '#efe4c8' },
      { prim: 'cone', size: [0.07, 0.5, 0.07], pos: [-0.18, 0.66, 0.66], rot: [70, 0, 15], color: '#efe4c8' },
      { prim: 'box', size: [0.3, 0.2, 0.3], pos: [0, 0.7, 0.16], color: T },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [0.1, 0.58, 0.64], color: '#ff4020', emissive: 0.9 },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [-0.1, 0.58, 0.64], color: '#ff4020', emissive: 0.9 },
    ],
  },
  tannin: {
    parts: [
      { prim: 'cylinder', size: [0.7, 0.14, 0.7], pos: [0, 0.07, 0], color: T },
      { prim: 'cylinder', size: [0.54, 0.14, 0.54], pos: [0.04, 0.2, 0], color: T },
      { prim: 'cylinder', size: [0.38, 0.14, 0.38], pos: [0.02, 0.33, 0], color: T },
      { prim: 'box', size: [0.12, 0.4, 0.12], pos: [0, 0.56, 0.08], rot: [20, 0, 0], color: T, anim: { type: 'sway', speed: 1.5, amount: 0.15 } },
      { prim: 'box', size: [0.2, 0.12, 0.28], pos: [0, 0.78, 0.2], color: T },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [0.07, 0.82, 0.32], color: '#ffe040', emissive: 0.9 },
      { prim: 'sphere', size: [0.05, 0.05, 0.05], pos: [-0.07, 0.82, 0.32], color: '#ffe040', emissive: 0.9 },
      { prim: 'cone', size: [0.04, 0.12, 0.02], pos: [0, 0.74, 0.38], rot: [90, 0, 0], color: '#c03030' },
    ],
  },
};
