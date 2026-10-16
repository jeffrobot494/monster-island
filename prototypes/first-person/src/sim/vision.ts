// Sight, fog of war, lair discovery (§12.1).
import type { Sim } from './sim';
import type { Entity } from './types';
import { SIZE } from './world';
import { LAIR_NAMES, REGION_NAMES } from './island-gen';
import { monsterActive } from './monster-ai';

const visibleSets = new WeakMap<Sim, Set<number>>();

export function championSight(sim: Sim, c: Entity) {
  const torch = sim.light < 0.5 && (sim as unknown as { champState?: { torch: boolean } }).champState?.torch ? 3 : 0;
  return (7 + (16 - 7) * sim.light) * sim.stat(c, 'sight') + torch;
}

export function visibleMonsters(sim: Sim): Set<number> {
  return visibleSets.get(sim) ?? new Set();
}

function markExplored(sim: Sim, cx: number, cz: number, r: number) {
  const r2 = r * r;
  for (let z = Math.max(0, Math.floor(cz - r)); z <= Math.min(SIZE - 1, Math.ceil(cz + r)); z++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(SIZE - 1, Math.ceil(cx + r)); x++) {
      const i = z * SIZE + x;
      if (sim.explored[i]) continue;
      if ((x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2 > r2) continue;
      sim.explored[i] = 1;
      sim.exploredChanged.push(i);
    }
  }
}

export function updateVision(sim: Sim, initial = false) {
  const L = sim.layout;
  if (initial) markExplored(sim, L.village.x + 0.5, L.village.z + 0.5, L.wallRadius + 8);
  if (sim.revealAll && initial) {
    sim.explored.fill(1);
    sim.exploredChanged.length = 0;
  }
  const c = sim.champion();
  const eyes: { x: number; z: number; r: number }[] = [];
  if (c && c.state !== 'captive') {
    const r = championSight(sim, c);
    markExplored(sim, c.x, c.z, r);
    eyes.push({ x: c.x, z: c.z, r });
    // lairs are found by stumbling within 5 tiles
    for (let reg = 1; reg <= 6; reg++) {
      const lp = L.lairs[reg];
      if (Math.hypot(lp.x + 0.5 - c.x, lp.z + 0.5 - c.z) > 5) continue;
      const s = sim.byRole(`lair:${reg}`);
      if (!s || s.tags.includes('found')) continue;
      s.tags.push('found');
      const owner = sim.monsters().find((m) => m.monster!.region === reg);
      if (owner) owner.monster!.lairFound = true;
      const text = `You found ${LAIR_NAMES[reg]} in ${REGION_NAMES[reg] === 'The High Place' ? 'the High Place' : REGION_NAMES[reg]}. ${owner ? 'Something lives here.' : 'It is empty now.'}`;
      sim.log(text, 3, 'core', 'lair');
      sim.alert({ kind: 'lair', text });
    }
  }
  const V = L.village;
  const night = sim.light < 0.5;
  const villR = 3 + 4 * sim.light;
  for (const h of sim.ents.values()) {
    if (h.kind !== 'human' || h.faction !== 'human' || h.hidden || h.id === sim.championId || h.state === 'captive') continue;
    const inside = Math.hypot(h.x - V.x, h.z - V.z) < L.wallRadius + 1;
    eyes.push({ x: h.x, z: h.z, r: inside && night ? 10 : h.human?.job === 'guard' ? Math.max(villR, 8) : villR });
  }
  const vis = new Set<number>();
  for (const m of sim.ents.values()) {
    if (m.kind !== 'monster') continue;
    let seen = sim.revealAll;
    if (!seen) for (const e of eyes) if ((m.x - e.x) ** 2 + (m.z - e.z) ** 2 <= e.r * e.r) { seen = true; break; }
    if (!seen) continue;
    vis.add(m.id);
    const M = m.monster!;
    M.lastSeenClock = sim.clockMs;
    if (!M.seen) {
      M.seen = true;
      if (!initial) sim.log(`First sighting: ${m.name}, a ${archLabel(m)}, near ${regionLabel(sim, m)}.`, 2, 'core', 'sighting');
    }
    if (monsterActive(sim, m) && m.state !== 'rest') {
      const hr = Math.floor(sim.hour);
      if (!M.seenHours.includes(hr)) M.seenHours.push(hr);
    }
  }
  visibleSets.set(sim, vis);
}

function archLabel(m: Entity) {
  return ({ nephil: 'Nephil giant', saraph: 'fiery flying serpent', seir: 'goat-demon', lilit: 'night hag', rahab: 'marsh dragon', anak: 'tomb ghoul', reem: 'wild-ox demon', tannin: 'great serpent', ziz: 'great bird' } as Record<string, string>)[m.monster!.archetype] ?? 'monster';
}

function regionLabel(sim: Sim, e: Entity) {
  const r = sim.grid.regionAt(e.x, e.z);
  return r === 0 ? 'the village' : r === 6 ? 'the High Place' : REGION_NAMES[r] ?? 'the coast';
}
