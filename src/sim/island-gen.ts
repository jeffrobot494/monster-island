import { Rng, hashSeed } from './rng';
import { SIZE, TileGrid } from './world';

export interface IslandLayout {
  shrine: { x: number; z: number };
  monsterVillage: { x: number; z: number };
  humanVillage: { x: number; z: number };
  huts: { x: number; z: number }[];
  cottages: { x: number; z: number }[];
  bushes: { x: number; z: number }[];
  bridge: { x: number; z: number }[];
  /** river centerline x per z, for z in [riverStartZ, SIZE) */
  riverX: number[];
  riverStartZ: number;
}

const C = 31;

function valueNoise(seed: number) {
  const cell = (ix: number, iz: number) => {
    const h = hashSeed(seed, ix, iz);
    return h / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, z: number) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = smooth(x - ix), fz = smooth(z - iz);
    const a = cell(ix, iz), b = cell(ix + 1, iz), c = cell(ix, iz + 1), d = cell(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
}

/** Which side of the river a tile is on. */
export function sideOf(layout: IslandLayout, x: number, z: number): 'east' | 'west' {
  const rx = z >= layout.riverStartZ ? layout.riverX[z] + 0.5 : C + 0.5;
  return x > rx ? 'east' : 'west';
}

export function generateIsland(seed: number, grid: TileGrid): IslandLayout {
  const rng = new Rng(hashSeed(seed, 'island'));
  const n1 = valueNoise(hashSeed(seed, 'n1'));
  const n2 = valueNoise(hashSeed(seed, 'n2'));
  const nf = valueNoise(hashSeed(seed, 'forest'));

  // 1. Base terrain: radial falloff + 2-octave value noise.
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - C) / 29, dz = (z - C) / 29;
      const d = Math.sqrt(dx * dx + dz * dz);
      const noise = n1(x / 9, z / 9) * 0.65 + n2(x / 4, z / 4) * 0.35;
      const h = 1 - d * d * 1.15 + (noise - 0.5) * 0.45;
      let t = 'grass';
      if (h < 0.08) t = 'deep-water';
      else if (h < 0.18) t = 'shallow-water';
      else if (h < 0.26) t = 'sand';
      else if (nf(x / 7, z / 7) > 0.6 && h > 0.32) t = 'forest';
      grid.types[grid.idx(x, z)] = t;
    }
  }
  // the map edge is always ocean
  for (let i = 0; i < SIZE; i++) {
    for (const [x, z] of [[i, 0], [i, SIZE - 1], [0, i], [SIZE - 1, i], [i, 1], [i, SIZE - 2], [1, i], [SIZE - 2, i]]) {
      grid.types[grid.idx(x, z)] = 'deep-water';
    }
  }

  const disk = (cx: number, cz: number, r: number, fn: (x: number, z: number, d: number) => void) => {
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (!grid.inBounds(x, z)) continue;
        const d = Math.hypot(x - cx, z - cz);
        if (d <= r) fn(x, z, d);
      }
    }
  };

  // 2. Villages: force clear grass.
  const monsterVillage = { x: C + 14, z: C + 1 + rng.int(-2, 2) };
  const humanVillage = { x: C - 14, z: C + 1 + rng.int(-2, 2) };
  disk(monsterVillage.x, monsterVillage.z, 6.5, (x, z) => (grid.types[grid.idx(x, z)] = 'grass'));
  disk(humanVillage.x, humanVillage.z, 7, (x, z) => (grid.types[grid.idx(x, z)] = 'grass'));
  disk(monsterVillage.x, monsterVillage.z, 8.5, (x, z) => {
    const i = grid.idx(x, z);
    if (grid.types[i].includes('water')) grid.types[i] = 'sand';
  });
  disk(humanVillage.x, humanVillage.z, 9, (x, z) => {
    const i = grid.idx(x, z);
    if (grid.types[i].includes('water')) grid.types[i] = 'sand';
  });
  // land bridges from the hill to each village so the island is one piece
  for (let x = humanVillage.x; x <= monsterVillage.x; x++) {
    const v = x < C ? humanVillage : monsterVillage;
    const z = Math.round(C + (v.z - C) * (Math.abs(x - C) / Math.abs(v.x - C)));
    for (const dz of [-1, 0, 1]) {
      const i = grid.idx(x, z + dz);
      if (grid.types[i].includes('water')) grid.types[i] = 'grass';
    }
  }

  // 3. Pond in the western forest.
  const pond = { x: C - 13 + rng.int(-1, 1), z: C - 11 + rng.int(-1, 1) };
  disk(pond.x + 1.5, pond.z + 1.5, 5.5, (x, z) => (grid.types[grid.idx(x, z)] = 'forest'));
  for (let z = pond.z; z < pond.z + 4; z++) for (let x = pond.x; x < pond.x + 4; x++) grid.types[grid.idx(x, z)] = 'shallow-water';
  // an eastern grove too, so mushrooms appear on both sides
  disk(C + 12 + rng.int(-1, 1), C - 11 + rng.int(-1, 1), 4.5, (x, z) => {
    const i = grid.idx(x, z);
    if (!grid.types[i].includes('water')) grid.types[i] = 'forest';
  });

  // 4. Central hill: rock plateau, height 0.6–1.5.
  disk(C, C, 5.5, (x, z, d) => {
    const i = grid.idx(x, z);
    grid.types[i] = 'rock';
    grid.elev[i] = d < 2.5 ? 1.5 : 0.6 + (1 - (d - 2.5) / 3) * 0.9;
  });

  // 5. River from the hill to the south coast, 2 tiles wide.
  const riverStartZ = C + 6;
  const riverX: number[] = new Array(SIZE).fill(C);
  const phase = rng.next() * Math.PI * 2;
  let reachedSea = false;
  for (let z = riverStartZ; z < SIZE; z++) {
    const x = C + Math.round(Math.sin(z * 0.22 + phase) * 2);
    riverX[z] = x;
    if (reachedSea) continue;
    const below = grid.types[grid.idx(x, z)];
    if (below === 'deep-water') {
      reachedSea = true;
      continue;
    }
    grid.types[grid.idx(x, z)] = 'shallow-water';
    grid.types[grid.idx(x + 1, z)] = 'shallow-water';
    // keep river edges continuous when the centerline shifts
    if (z > riverStartZ && riverX[z - 1] !== x) {
      const lo = Math.min(riverX[z - 1], x), hi = Math.max(riverX[z - 1], x) + 1;
      for (let xx = lo; xx <= hi; xx++) grid.types[grid.idx(xx, z)] = 'shallow-water';
    }
  }
  // river source touches the hill
  grid.types[grid.idx(riverX[riverStartZ], riverStartZ - 1)] = 'shallow-water';
  grid.types[grid.idx(riverX[riverStartZ] + 1, riverStartZ - 1)] = 'shallow-water';

  // 6. Single bridge midway down the river.
  let bridgeZ = riverStartZ + 6;
  const bridge: { x: number; z: number }[] = [];
  for (let x = riverX[bridgeZ] - 1; x <= riverX[bridgeZ] + 2; x++) {
    const i = grid.idx(x, bridgeZ);
    if (grid.types[i] === 'shallow-water') {
      grid.types[i] = 'bridge';
      bridge.push({ x, z: bridgeZ });
    }
  }
  // approaches
  for (const dx of [-2, 3]) {
    const i = grid.idx(riverX[bridgeZ] + dx, bridgeZ);
    if (grid.types[i].includes('water')) grid.types[i] = 'sand';
  }

  // 7. Houses.
  const huts: { x: number; z: number }[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    huts.push({ x: Math.round(monsterVillage.x + Math.cos(a) * 3.5), z: Math.round(monsterVillage.z + Math.sin(a) * 3.5) });
  }
  const cottages: { x: number; z: number }[] = [];
  const grid7 = [[-3, -3], [0, -3], [3, -3], [-3, 0], [3, 0], [-3, 3], [0, 3]];
  for (const [dx, dz] of grid7) cottages.push({ x: humanVillage.x + dx, z: humanVillage.z + dz });

  // 8. Remove land unreachable from the shrine (keeps every house reachable).
  const reach = new Uint8Array(SIZE * SIZE);
  const q = [grid.idx(C, C)];
  reach[q[0]] = 1;
  while (q.length) {
    const i = q.pop()!;
    const x = i % SIZE, z = (i / SIZE) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!grid.inBounds(nx, nz)) continue;
      const j = grid.idx(nx, nz);
      if (reach[j] || !grid.def(grid.types[j]).walkable) continue;
      reach[j] = 1;
      q.push(j);
    }
  }
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!reach[i] && grid.def(grid.types[i]).walkable) grid.types[i] = 'shallow-water';
  }

  // 9. Berry bushes: ≥6 within 8 tiles of each village on its side, the rest random.
  const layout: IslandLayout = {
    shrine: { x: C, z: C }, monsterVillage, humanVillage, huts, cottages, bushes: [], bridge, riverX, riverStartZ,
  };
  const occupied = new Set<number>([...huts, ...cottages, layout.shrine].map((p) => grid.idx(p.x, p.z)));
  const okBush = (x: number, z: number) => {
    const t = grid.get(x, z);
    return (t === 'grass' || t === 'forest') && !occupied.has(grid.idx(x, z));
  };
  const place = (x: number, z: number) => {
    layout.bushes.push({ x, z });
    occupied.add(grid.idx(x, z));
  };
  for (const [v, side] of [[monsterVillage, 'east'], [humanVillage, 'west']] as const) {
    let placed = 0, tries = 0;
    while (placed < 6 && tries++ < 2000) {
      const x = v.x + rng.int(-8, 8), z = v.z + rng.int(-8, 8);
      if (Math.hypot(x - v.x, z - v.z) > 8 || Math.hypot(x - v.x, z - v.z) < 2) continue;
      if (!okBush(x, z) || sideOf(layout, x, z) !== side) continue;
      place(x, z);
      placed++;
    }
  }
  let tries = 0;
  while (layout.bushes.length < 24 && tries++ < 5000) {
    const x = rng.int(2, SIZE - 3), z = rng.int(2, SIZE - 3);
    if (okBush(x, z)) place(x, z);
  }
  grid.changed.clear();
  return layout;
}
