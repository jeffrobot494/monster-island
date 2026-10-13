// The arena world (src/arena/README.md): the game's Sim on a bowl instead of an island. No village, no lairs to find,
// no midnight god, no game over; the director (director.ts) fills it with monsters and guards.
import { Sim } from '../sim/sim';
import { hourOf } from '../sim/clock';
import { SIZE } from '../sim/world';
import { NV } from '../sim/ground';
import { DEFAULT_SETTINGS, type TerrainSettings } from '../sim/terrain-import';
import type { IslandLayout, P } from '../sim/island-gen';
import { C, arenaBase, inArena, planArena, solidTiles, type ArenaLayout, type ArenaShape } from './geometry';

/** What the arena sends the client as its "terrain": the game's settings shape (unused) plus the arena's own. */
export type ArenaTerrain = TerrainSettings & { arena: ArenaShape };

/** Steepest walkable rise between neighboring Ground vertices (m), as on terraformer islands. */
const MAX_RISE = 4;

export class ArenaSim extends Sim {
  arena!: ArenaLayout;
  /** a fixed hour of day, or null to let the clock run */
  fixedHour: number | null = 13;

  override get hour(): number {
    return this.fixedHour ?? hourOf(this.clockMs);
  }

  /** Nobody wins in the arena. */
  override checkGameOver() {}

  /** Build the arena: ground, blocked tiles, landmarks. Monsters, guards and the champion come from the director. */
  build(shape: ArenaShape, clockMs: number, timescale: number) {
    this.clockMs = this.createdClock = clockMs;
    this.timescale = timescale;
    this.msPerTick = 100 * timescale;
    this.judgmentEnabled = false;
    this.revealAll = true;
    this.explored.fill(1);
    const A = (this.arena = planArena(shape));
    const g = this.grid;
    const base = arenaBase(A);
    const solid = solidTiles(A);
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x;
      g.region[i] = 0;
      let rise = 0;
      for (let dj = 0; dj <= 2; dj++) for (let di = 0; di <= 2; di++) {
        const o = (z * 2 + dj) * NV + x * 2 + di;
        if (di < 2) rise = Math.max(rise, Math.abs(base[o] - base[o + 1]));
        if (dj < 2) rise = Math.max(rise, Math.abs(base[o] - base[o + NV]));
      }
      if (!inArena(shape, x, z) || solid[i] || rise > MAX_RISE) g.types[i] = 'cliff';
      else if (Math.hypot(x + 0.5 - A.spawn.x, z + 0.5 - A.spawn.z) < 2.6) g.types[i] = 'shrine-floor';
      else g.types[i] = 'grass';
    }
    g.base = base;
    g.orig = new Float32Array(SIZE * SIZE);
    for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) g.orig[z * SIZE + x] = g.height(x, z);
    this.ground.rebuild();
    g.groundChanged.clear();
    g.changed.clear();
    this.terrain = { ...DEFAULT_SETTINGS, islands: 0, arena: { ...shape } } as ArenaTerrain;
    this.layout = arenaLayout(A);
    this.placeLandmarks();
    this.light = this.computeLight();
    this.out.events.length = 0;
  }

  private placeLandmarks() {
    const L = this.layout;
    const S = (role: string, p: P, shape: string) => {
      const e = this.spawn({ kind: 'structure', x: p.x + 0.5, z: p.z + 0.5, shape });
      e.role = role;
      return e;
    };
    // the game's code expects these to exist
    S('village-altar', L.villageAltar, 'village-altar');
    S('high-altar', L.highAltar, 'high-altar');
    S('fold', L.fold, 'fold');
    S('granary', L.granary, 'granary');
    // the monster gates are the game's lairs, already found
    for (let r = 1; r <= 6; r++) {
      const l = S(`lair:${r}`, L.lairs[r], `lair-${r}`);
      l.region = r;
      l.yaw = Math.atan2(C - L.lairs[r].x, C - L.lairs[r].z);
      l.tags.push('found');
    }
  }
}

const tile = (p: { x: number; z: number }): P => ({ x: Math.floor(p.x), z: Math.floor(p.z) });

/** The game's island layout, filled in for the arena: the "village" is the whole floor (so the guards defend all of
 *  it and raiding monsters roam all of it); the fold and granary sit out of sight on the rim. */
function arenaLayout(A: ArenaLayout): IslandLayout {
  const c = { x: C, z: C };
  const rim = (k: number): P => ({ x: 4 + k * 2, z: 4 });
  return {
    center: c,
    seeds: Array.from({ length: 7 }, () => ({ ...c })),
    village: { ...c },
    wallRadius: A.shape.radius - 1,
    gates: [{ ...c }, { ...c }],
    houses: [],
    doors: [],
    // the altar just behind the spawn and the High Place's standing stones in the middle: the game faces a new
    // champion from one to the other, and its spectator camera starts by the altar
    villageAltar: tile({ x: A.spawn.x, z: A.spawn.z + 2 }),
    fold: rim(0),
    granary: rim(1),
    highAltar: tile(c),
    lairs: [{ ...c }, ...A.gates.map(tile)],
    guardPosts: A.guardPosts.map(tile),
    goats: [],
    oxen: [],
  };
}
