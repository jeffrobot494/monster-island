// Terraformer islands (sim/terrain-import.ts, sim/island-import.ts).
import { describe, it, expect } from 'vitest';
import { Island } from '../src/sim/island';
import { reachabilityProblem } from '../src/sim/reachability';
import { serializeCore, deserializeCore } from '../src/sim/serialize';
import { DEFAULT_SETTINGS, type TerrainSettings } from '../src/sim/terrain-import';
import { M, WATER_Y } from '../src/sim/ground';
import { SIZE } from '../src/sim/world';
import { now, START } from './helpers';

const CASES: [string, TerrainSettings][] = [
  ['default', DEFAULT_SETTINGS],
  ['another seed, sheer and tall', { ...DEFAULT_SETTINGS, seed: 'bog-fang-12', terraceSharp: 0.15, heightScale: 6 }],
  ['no terraces, many spires', { ...DEFAULT_SETTINGS, seed: 'moon-hex-400', terraceStep: 0, spires: 1, arches: 1 }],
];

describe('terraformer islands', () => {
  for (const [name, settings] of CASES) {
    it(`${name}: reachable, village level, survives a save`, () => {
      const t0 = now();
      const island = Island.create(7, START, 1, settings);
      const ms = now() - t0;
      const sim = island.sim;
      const L = sim.layout;
      const tiles = sim.grid.histogram();
      const land = SIZE * SIZE - (tiles['deep-water'] ?? 0) - (tiles['shallow-water'] ?? 0);
      console.info(`${name}: ${Math.round(ms)} ms, village ${L.village.x},${L.village.z}, High Place ${L.highAltar.x},${L.highAltar.z} ` +
        `(${(sim.ground.y(L.highAltar.x + 0.5, L.highAltar.z + 0.5) - sim.ground.y(L.village.x + 0.5, L.village.z + 0.5)).toFixed(1)} m up), ` +
        `cliff ${Math.round(((tiles.cliff ?? 0) / land) * 100)} % of land, road ${tiles.road}`);
      expect(reachabilityProblem(sim)).toBeNull();
      expect(sim.humans().length).toBe(21);
      expect(ms).toBeLessThan(5000);
      // the village (inside its wall) is level and above the sea
      const hs: number[] = [];
      for (let z = -7; z <= 7; z++) for (let x = -7; x <= 7; x++) if (Math.hypot(x, z) < 7) hs.push(sim.ground.y(L.village.x + x + 0.5, L.village.z + z + 0.5));
      expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(0.5);
      expect(Math.min(...hs)).toBeGreaterThan(WATER_Y);
      // every walkable tile a walker stands on is above the sea
      for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
        if (sim.grid.def(sim.grid.get(x, z)).walkable) expect(sim.ground.y(x + 0.5, z + 0.5)).toBeGreaterThan(WATER_Y);
      }
      // the ground is the terraformer's, not the flat procedural one
      let hi = -Infinity;
      for (const v of sim.ground.v) hi = Math.max(hi, v);
      expect(hi).toBeGreaterThan(2.5 * M);
      // a reloaded island has exactly the same ground
      const core = serializeCore(sim);
      const back = deserializeCore(JSON.parse(JSON.stringify(core)));
      expect(back.terrain).toEqual(sim.terrain);
      expect(Array.from(back.ground.v)).toEqual(Array.from(sim.ground.v));
      console.info(`${name}: save ${Math.round(JSON.stringify(core).length / 1024)} KB`);
    });
  }

  it('repainted tiles move the ground relative to the terraformer surface', () => {
    const sim = Island.create(3, START, 1, DEFAULT_SETTINGS).sim;
    // a 3×3 patch of plain walkable land, turned into a pond
    const plain = (x: number, z: number) => ['grass', 'scrub', 'olive', 'cedar'].includes(sim.grid.get(x, z));
    let c: { x: number; z: number } | null = null;
    for (let i = 0; i < SIZE * SIZE && !c; i++) {
      const x = i % SIZE, z = (i / SIZE) | 0;
      let ok = true;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ok &&= plain(x + dx, z + dz);
      if (ok) c = { x, z };
    }
    expect(c).not.toBeNull();
    const before = sim.ground.y(c!.x + 0.5, c!.z + 0.5);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) sim.grid.set(c!.x + dx, c!.z + dz, 'shallow-water');
    sim.ground.update(sim.grid.groundChanged);
    expect(sim.ground.y(c!.x + 0.5, c!.z + 0.5)).toBeLessThan(before - 3);
  });
});
