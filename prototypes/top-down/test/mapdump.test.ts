import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { TileGrid, SIZE } from '../src/sim/world';
import { generateIsland } from '../src/sim/island-gen';

it.skipIf(!process.env.MAPDUMP)('dump island map', () => {
  for (const seed of (process.env.MAPDUMP ?? '1').split(',').map(Number)) {
    const g = new TileGrid();
    const L = generateIsland(seed, g);
    const rows: string[] = [];
    for (let i = 0; i < SIZE * SIZE; i++) rows.push(g.types[i] + ':' + g.region[i] + ':' + g.elev[i].toFixed(2));
    writeFileSync(`${process.env.OUT}/map-${seed}.json`, JSON.stringify({ rows, colors: Object.fromEntries([...g.defs].map(([k, d]) => [k, d.color])), L }));
  }
});
