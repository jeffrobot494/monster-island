// Worker side of the arena (src/arena/README.md). Loaded before the game's sim worker (arena.worker.ts), it swaps
// the island for the arena: Island.create builds an ArenaSim and its director, and a message listener of its own
// takes the arena's commands. The game's worker runs as it is around it.
import { Island } from '../sim/island';
import { hostPost } from '../workers/harden';
import { ArenaSim } from './arena-sim';
import { ArenaDirector } from './director';
import { DEFAULT_CONFIG, sanitize, type ArenaCommand, type ArenaConfig } from './rules';

let config: ArenaConfig = DEFAULT_CONFIG;
let island: Island | null = null;
let director: ArenaDirector | null = null;

function createArena(seed: number, clockMs: number, timescale: number): Island {
  const sim = new ArenaSim(seed);
  sim.build(config.shape, clockMs, timescale);
  island = new Island(sim);
  director = new ArenaDirector(sim, config.rules);
  director.reset();
  sim.listeners.push({
    onTick: () => {
      // the game's worker sets these from its init message after creating the world: the arena's rules win
      sim.revealAll = true;
      sim.invincible = director!.rules.invincible;
      if (sim.tick % 5 === 0) hostPost(director!.status());
    },
  });
  return island;
}

Island.create = (seed, clockMs, timescale) => createArena(seed, clockMs, timescale);
// a watchdog restart hands the worker the last save: the arena starts over instead
Island.load = async (world) => createArena(world.core.seed, world.core.clockMs, world.core.timescale);

self.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as { type: string; arena?: unknown } | ArenaCommand;
  if (msg.type === 'init') config = sanitize((msg as { arena?: ArenaConfig }).arena);
  // time away isn't caught up in the arena (the game's resolver would play out hunts and raids): zeroing the
  // last-tick time makes the game's catch-up see no gap
  else if (msg.type === 'catchUp' && island) island.sim.lastRealMs = 0;
  else if (msg.type === 'arena' && director) {
    const c = msg as ArenaCommand;
    switch (c.cmd) {
      case 'rules':
        config = { ...config, rules: sanitize({ rules: c.rules }).rules };
        director.apply(config.rules);
        break;
      case 'reset':
        director.reset();
        break;
      case 'spawn':
        for (let k = 0; k < c.n; k++) director.spawnMonster(c.archetype);
        break;
      case 'clear':
        for (const m of island!.sim.monsters()) island!.sim.remove(m);
        break;
      case 'heal': {
        const ch = island!.sim.champion();
        if (ch) {
          ch.hp = island!.sim.maxHp(ch);
          for (const z of Object.values(ch.zones ?? {})) if (z && z.state !== 'severed') { z.hp = z.max; z.state = 'ok'; }
        }
        break;
      }
    }
    hostPost(director.status());
  }
});
