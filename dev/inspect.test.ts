import { it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { TICKS_PER_DAY } from '../src/sim/time';
it('inspect', () => {
  const sim = new Sim(Number(process.env.SEED ?? 7));
  sim.generate();
  const ch: Record<string, string> = { 'deep-water': '~', 'shallow-water': '-', sand: '.', grass: ',', forest: 'T', rock: '^', bridge: '=' };
  const rows: string[][] = [];
  for (let z = 0; z < 64; z++) rows.push(sim.grid.types.slice(z * 64, z * 64 + 64).map((t) => ch[t] ?? '?'));
  for (const e of sim.ents.values()) {
    const c = e.kind === 'house' ? (e.faction === 'monster' ? 'H' : 'C') : e.kind === 'berry-bush' ? 'b' : e.kind === 'shrine' ? 'S' : null;
    if (c) rows[Math.floor(e.z)][Math.floor(e.x)] = c;
  }
  console.log(rows.map((r) => r.join('')).join('\n'));
  for (let d = 0; d < 6; d++) {
    for (let i = 0; i < TICKS_PER_DAY; i++) sim.step();
    const h = sim.history[sim.history.length - 1];
    const tot = Object.values(h.behaviorTicks).reduce((a, b) => a + b, 0);
    const hist = Object.entries(h.behaviorTicks).map(([k, v]) => `${k} ${Math.round((v / tot) * 100)}%`).join(' ');
    const hun = (f: 'monster' | 'human') => Math.round(sim.inhabitants(f).reduce((s, e) => s + e.hunger, 0) / Math.max(1, sim.inhabitants(f).length));
    console.log(`day ${h.day}: M ${sim.inhabitants('monster').length} (h${hun('monster')}) H ${sim.inhabitants('human').length} (h${hun('human')}) births ${h.births} deaths ${h.deaths} ate ${JSON.stringify(h.ate)} slept ${JSON.stringify(h.slept)} | ${hist}`);
  }
});
