import type { Sim } from './sim';
import { SIZE } from './world';
export function reachabilityProblem(sim: Sim): string | null {
  const L = sim.layout;
  const seen = new Uint8Array(SIZE * SIZE);
  const start = L.gates[0].z * SIZE + L.gates[0].x;
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const i = q.pop()!;
    const x = i % SIZE, z = (i / SIZE) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!sim.grid.inBounds(nx, nz)) continue;
      const j = nz * SIZE + nx;
      if (seen[j] || !sim.walkableFor('human', nx, nz)) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  const ok = (p: { x: number; z: number }) => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (seen[(p.z + dz) * SIZE + p.x + dx]) return true;
    return false;
  };
  if (!ok(L.villageAltar)) return 'the village altar can no longer be reached from the gate';
  if (!ok(L.highAltar)) return 'the High Place altar can no longer be reached from the village';
  for (const m of sim.monsters()) if (!ok(L.lairs[m.monster!.region])) return `the lair in region ${m.monster!.region} can no longer be reached on foot`;
  return null;
}
