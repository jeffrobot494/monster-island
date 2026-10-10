import { it, expect } from 'vitest';
import { Island } from '../src/sim/island';
import { now } from './helpers';

const START = Date.UTC(2026, 9, 10, 8, 0);

it('runs days at a timescale without errors', () => {
  const TS = Number(process.env.TS ?? 60), DAYS = Number(process.env.DAYS ?? 3);
  const island = Island.create(Number(process.env.SEED ?? 1), START, TS, { now });
  const sim = island.sim;
  if (process.env.NOCHAMP) { const c = sim.champion()!; (sim as any).champState = { lastOrder: 1e12, lastThreat: 0, swingReady: 0, dashReady: 0, diedTick: 0, altarNotified: false, weapon: { type: 'slash', mul: 1 } }; c.x = sim.layout.village.x; }
  const t0 = performance.now();
  const log: string[] = [];
  const ticks = (86400000 / (100 * TS)) * DAYS;
  let lastH = -1;
  for (let i = 0; i < ticks; i++) {
    if (process.env.NOCHAMP) (sim as any).champState.lastOrder = sim.tick;
    island.step();
    for (const e of sim.drainOut().events) log.push(`[d${e.day} ${new Date(e.clockMs).toISOString().slice(11, 16)}] ${e.text}`);
    const h = Math.floor(sim.hour / 6);
    if (h !== lastH) { lastH = h; log.push(`   -- food ${Math.round(sim.food)} humans ${sim.humans().length} monsters ${sim.monsters().length} states ${JSON.stringify(sim.humans().reduce((a: any, x) => (a[x.state] = (a[x.state] ?? 0) + 1, a), {}))}`); }
    if (sim.gameOver) break;
  }
  const ms = performance.now() - t0;
  console.log(log.join('\n'));
  console.log({ msPerTick: (ms / ticks).toFixed(3), humans: sim.humans().length, monsters: sim.monsters().length, food: Math.round(sim.food), stats: sim.stats });
  expect(sim.humans().length).toBeGreaterThan(0);
});
