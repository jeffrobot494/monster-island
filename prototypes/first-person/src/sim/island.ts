// Simulation and its versioned save, shared by the worker and tests.
import { Sim } from './sim';
import { deserializeCore, serializeCore, type SavedCore } from './serialize';
import type { TerrainSettings } from './terrain-import';
export interface SavedWorld {
  core: SavedCore;
}
export class Island {
  constructor(public sim: Sim) {}
  static create(
    seed: number,
    clockMs: number,
    timescale: number,
    terrain: TerrainSettings | null = null,
  ) {
    const sim = new Sim(seed);
    sim.generate(clockMs, timescale, terrain);
    return new Island(sim);
  }
  static async load(world: SavedWorld) {
    return new Island(deserializeCore(world.core));
  }
  serialize(): SavedWorld {
    return { core: serializeCore(this.sim) };
  }
  step() {
    this.sim.step();
  }
}
