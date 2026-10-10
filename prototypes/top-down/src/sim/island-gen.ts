// Island generation (§3.3): mask → 7 regions (Voronoi on a ring of seeds) → terrain per region → village, High Place,
// lairs, roads → reachability. Pure and seeded.
import { Rng, hashSeed } from './rng';
import { SIZE, TileGrid } from './world';

export const REGION_NAMES = ['Village and harbor', 'Cedar Heights', 'Olive Terraces', 'Salt Flats', 'Wilderness of Stones', 'Ruins of the Anakim', 'The High Place'];
export const LAIR_NAMES = ['', 'the cave beneath the giant cedar', 'the abandoned wine-press cave', 'the sunken cistern', 'the cliff tomb', "the ruined giant's hall", 'the catacomb under the shrine'];

export interface P {
  x: number;
  z: number;
}

export interface IslandLayout {
  center: P;
  seeds: P[]; // per region
  village: P;
  wallRadius: number;
  gates: P[]; // [inner (toward the island center), harbor]
  houses: P[];
  villageAltar: P;
  fold: P;
  granary: P;
  highAltar: P;
  lairs: P[]; // index = region (0 unused)
  guardPosts: P[];
  goats: P[];
  oxen: P[];
}

const C = SIZE / 2;

function valueNoise(seed: number) {
  const cell = (ix: number, iz: number) => hashSeed(seed, ix, iz) / 4294967296;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, z: number) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = smooth(x - ix), fz = smooth(z - iz);
    const a = cell(ix, iz), b = cell(ix + 1, iz), c = cell(ix, iz + 1), d = cell(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
}

const isWater = (t: string) => t === 'deep-water' || t === 'shallow-water';

export function generateIsland(seed: number, grid: TileGrid): IslandLayout {
  const rng = new Rng(hashSeed(seed, 'island'));
  const n1 = valueNoise(hashSeed(seed, 'n1'));
  const n2 = valueNoise(hashSeed(seed, 'n2'));
  const nf = valueNoise(hashSeed(seed, 'fill'));
  const nh = valueNoise(hashSeed(seed, 'hill'));
  const nw = valueNoise(hashSeed(seed, 'wadi'));
  const T = grid.types;
  const I = (x: number, z: number) => grid.idx(x, z);

  // 1. Mask
  const hmap = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - C, z - C) / 58;
      const noise = n1(x / 16, z / 16) * 0.65 + n2(x / 7, z / 7) * 0.35;
      const h = 1 - d * d * 1.1 + (noise - 0.5) * 0.4;
      hmap[I(x, z)] = h;
      T[I(x, z)] = h < 0.1 ? 'deep-water' : h < 0.18 ? 'shallow-water' : 'grass';
    }
  }
  for (let i = 0; i < SIZE; i++) for (const k of [0, 1, SIZE - 2, SIZE - 1]) {
    T[I(i, k)] = 'deep-water';
    T[I(k, i)] = 'deep-water';
  }

  // 2. Region seeds on a ring (z grows south): village SW, cedar N, olive SE, salt E, wilderness NE, ruins W
  const DEG = Math.PI / 180;
  const ring: [number, number][] = [[135, 42], [270, 34], [65, 32], [10, 40], [320, 36], [200, 36]]; // regions 0..5
  const seeds: P[] = ring.map(([a, r]) => {
    const ang = (a + rng.int(-12, 12)) * DEG;
    return { x: Math.round(C + Math.cos(ang) * r), z: Math.round(C + Math.sin(ang) * r) };
  });
  seeds.push({ x: C, z: C }); // 6: the High Place
  const village = seeds[0];

  const disk = (cx: number, cz: number, r: number, fn: (x: number, z: number, d: number) => void) => {
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (!grid.inBounds(x, z)) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d <= r) fn(x, z, d);
    }
  };
  // the village sits on solid land; so does the High Place
  disk(village.x, village.z, 15, (x, z) => {
    if (isWater(T[I(x, z)]) && x > 2 && z > 2 && x < SIZE - 3 && z < SIZE - 3) {
      T[I(x, z)] = 'grass';
      hmap[I(x, z)] = Math.max(hmap[I(x, z)], 0.25);
    }
  });
  disk(C, C, 14, (x, z) => {
    T[I(x, z)] = 'grass';
    hmap[I(x, z)] = Math.max(hmap[I(x, z)], 0.5);
  });

  // 3. Regions (Voronoi; High Place = within 10 of center)
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
    const i = I(x, z);
    if (isWater(T[i])) continue;
    if (Math.hypot(x - C, z - C) < 10) {
      grid.region[i] = 6;
      continue;
    }
    let best = 0, bd = Infinity;
    for (let r = 0; r < 6; r++) {
      const d = Math.hypot(x - seeds[r].x, z - seeds[r].z) * (r === 0 ? 1.15 : 1);
      if (d < bd) { bd = d; best = r; }
    }
    grid.region[i] = best;
  }

  // 4. Terrain per region
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
    const i = I(x, z);
    if (isWater(T[i])) continue;
    const f = nf(x / 6, z / 6), hl = nh(x / 10, z / 10), w = nw(x / 9, z / 9);
    let t = 'grass';
    switch (grid.region[i]) {
      case 0: t = f > 0.72 ? 'scrub' : 'grass'; break;
      case 1:
        t = f > 0.3 ? 'cedar' : 'grass';
        if (hl > 0.7) { t = 'rock'; grid.elev[i] = 0.6 + (hl - 0.7) * 5; }
        break;
      case 2: {
        const band = Math.floor((x * 0.7 + z * 0.7) / 3) % 3;
        t = f > 0.78 ? 'scrub' : band === 0 ? 'vineyard' : band === 1 ? 'olive' : f > 0.45 ? 'olive' : 'grass';
        break;
      }
      case 3:
        t = f > 0.58 ? 'marsh' : 'salt';
        if (f > 0.82) t = 'shallow-water';
        break;
      case 4:
        t = 'scrub';
        if (Math.abs(w - 0.5) < 0.035) t = 'wadi';
        else if (hl > 0.72) { t = 'rock'; grid.elev[i] = 0.6 + (hl - 0.72) * 5; }
        break;
      case 5: {
        const gx = ((x % 7) + 7) % 7, gz = ((z % 7) + 7) % 7;
        t = (gx === 0 || gz === 0) && f > 0.35 ? 'ruin-floor' : f > 0.6 ? 'ruin-floor' : 'grass';
        if (f > 0.86) { t = 'rock'; grid.elev[i] = 0.9; }
        break;
      }
      case 6: {
        const d = Math.hypot(x - C, z - C);
        if (d < 3.2) { t = 'shrine-floor'; grid.elev[i] = 2.5; }
        else if (d < 8) { t = 'rock'; grid.elev[i] = 0.6 + (1 - (d - 3.2) / 4.8) * 1.8; }
        else t = f > 0.4 ? 'olive' : 'grass';
        break;
      }
    }
    if (hmap[i] < 0.24 && grid.region[i] !== 3 && t !== 'rock') t = 'sand'; // beaches
    T[i] = t;
  }

  // 5. Village: walls, gates, street, houses, fields
  const wallR = 9;
  const toCenter = Math.atan2(C - village.z, C - village.x);
  const gateAng = [toCenter, toCenter + Math.PI];
  const gates: P[] = gateAng.map((a) => ({ x: Math.round(village.x + Math.cos(a) * wallR), z: Math.round(village.z + Math.sin(a) * wallR) }));
  disk(village.x, village.z, wallR + 6, (x, z, d) => {
    const i = I(x, z);
    if (d < wallR - 0.5) T[i] = 'grass';
    else if (d < wallR + 0.5) T[i] = 'wall';
    else if (!isWater(T[i]) && T[i] !== 'sand') {
      const a = Math.atan2(z - village.z, x - village.x);
      let da = Math.abs(a - toCenter);
      if (da > Math.PI) da = Math.PI * 2 - da;
      T[i] = da < Math.PI * 0.62 && d > wallR + 1.5 ? 'wheat' : 'grass';
    }
    if (!isWater(T[i])) grid.region[i] = 0;
  });
  const line = (a: P, b: P, type: string) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 2);
    for (let k = 0; k <= n; k++) {
      const x = Math.round(a.x + ((b.x - a.x) * k) / n), z = Math.round(a.z + ((b.z - a.z) * k) / n);
      if (grid.inBounds(x, z)) T[I(x, z)] = type;
    }
  };
  for (const g of gates) disk(g.x, g.z, 1.6, (x, z) => (T[I(x, z)] = 'road'));
  line(gates[0], gates[1], 'road');
  // harbor: road from the outer gate out to the sea, then a short pier
  const out = { x: Math.cos(gateAng[1]), z: Math.sin(gateAng[1]) };
  let px = gates[1].x, pz = gates[1].z, pier = 0;
  for (let k = 0; k < 40 && pier < 4; k++) {
    px += out.x;
    pz += out.z;
    const x = Math.round(px), z = Math.round(pz);
    if (x < 3 || z < 3 || x > SIZE - 4 || z > SIZE - 4) break;
    if (isWater(T[I(x, z)])) pier++;
    T[I(x, z)] = 'road';
    grid.region[I(x, z)] = 0;
  }
  const houses: P[] = [];
  for (let k = 0; k < 16 && houses.length < 10; k++) {
    const a = toCenter + (k / 16) * Math.PI * 2 + Math.PI / 16;
    const h = { x: Math.round(village.x + Math.cos(a) * 6.2), z: Math.round(village.z + Math.sin(a) * 6.2) };
    if (T[I(h.x, h.z)] === 'road' || houses.some((o) => Math.hypot(o.x - h.x, o.z - h.z) < 2.2)) continue;
    houses.push(h);
  }
  const perp = { x: -Math.sin(toCenter), z: Math.cos(toCenter) };
  const at = (along: number, side: number): P => ({
    x: Math.round(village.x + Math.cos(toCenter) * along + perp.x * side),
    z: Math.round(village.z + Math.sin(toCenter) * along + perp.z * side),
  });
  const villageAltar = at(0.5, 2.2);
  const fold = at(-2.5, -3);
  const granary = at(2.5, -2.6);

  // 6. Road from the inner gate to the High Place, and a stair up the hill
  const foot = { x: Math.round(C + Math.cos(toCenter + Math.PI) * 8.5), z: Math.round(C + Math.sin(toCenter + Math.PI) * 8.5) };
  line(gates[0], foot, 'road');
  for (let k = 0; k <= 9; k++) {
    const x = Math.round(foot.x + ((C - foot.x) * k) / 9), z = Math.round(foot.z + ((C - foot.z) * k) / 9);
    const i = I(x, z);
    T[i] = 'shrine-floor';
    grid.elev[i] = Math.max(0.6, Math.min(2.5, 0.6 + (k / 9) * 1.9));
  }
  const highAltar = { x: C, z: C };

  // 7. Lairs (55–80 % of the way from the center to each region's seed; the catacomb is beside the altar)
  const lairs: P[] = [{ x: -1, z: -1 }];
  for (let r = 1; r <= 5; r++) {
    const s = seeds[r];
    const k = 0.55 + rng.next() * 0.25;
    let lx = Math.round(C + (s.x - C) * k * 1.6), lz = Math.round(C + (s.z - C) * k * 1.6);
    for (let step = 0; step < 80; step++) {
      if (grid.inBounds(lx, lz)) {
        const i = I(lx, lz);
        if (!isWater(T[i]) && grid.region[i] === r && T[i] !== 'wall') break;
      }
      if (step % 2 === 0) lx += Math.sign(C - lx);
      else lz += Math.sign(C - lz);
    }
    lairs.push({ x: lx, z: lz });
  }
  const hpA = rng.next() * Math.PI * 2;
  lairs.push({ x: Math.round(C + Math.cos(hpA) * 4.5), z: Math.round(C + Math.sin(hpA) * 4.5) });
  const base = ['grass', 'cedar', 'olive', 'salt', 'scrub', 'ruin-floor', 'rock'];
  for (let r = 1; r <= 6; r++) {
    const l = lairs[r];
    disk(l.x, l.z, 1.6, (x, z) => {
      const i = I(x, z);
      if (r === 6) return;
      if (isWater(T[i]) || T[i] === 'marsh' || T[i] === 'rock') T[i] = base[r];
      grid.region[i] = r;
    });
    connectPath(grid, l, highAltar);
  }

  // 8. Reachability from the inner gate: unreachable land becomes shallow water
  const reach = new Uint8Array(SIZE * SIZE);
  const q = [I(gates[0].x, gates[0].z)];
  reach[q[0]] = 1;
  while (q.length) {
    const i = q.pop()!;
    const x = i % SIZE, z = (i / SIZE) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!grid.inBounds(nx, nz)) continue;
      const j = I(nx, nz);
      if (reach[j] || !grid.def(T[j]).walkable) continue;
      reach[j] = 1;
      q.push(j);
    }
  }
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!reach[i] && grid.def(T[i]).walkable) T[i] = 'shallow-water';
    if (isWater(T[i])) grid.region[i] = 255;
    if (T[i] === 'wall') grid.region[i] = 0;
  }

  // 9. Guard posts (just inside each gate, either side of the street) and wild animals
  const guardPosts: P[] = [];
  for (let gi = 0; gi < 2; gi++) {
    const a = gateAng[gi];
    for (const off of [-1.8, 1.8]) {
      guardPosts.push({
        x: Math.round(village.x + Math.cos(a) * (wallR - 1.5) + perp.x * off),
        z: Math.round(village.z + Math.sin(a) * (wallR - 1.5) + perp.z * off),
      });
    }
  }
  const randomIn = (regions: number[], n: number): P[] => {
    const res: P[] = [];
    for (let tries = 0; tries < 6000 && res.length < n; tries++) {
      const x = rng.int(3, SIZE - 4), z = rng.int(3, SIZE - 4);
      const i = I(x, z);
      if (!regions.includes(grid.region[i]) || !grid.def(T[i]).walkable || T[i] === 'rock') continue;
      res.push({ x, z });
    }
    return res;
  };
  const goats = randomIn([4, 1], 8);
  const oxen = randomIn([2, 5], 3);

  grid.changed.clear();
  return { center: { x: C, z: C }, seeds, village, wallRadius: wallR, gates, houses, villageAltar, fold, granary, highAltar, lairs, guardPosts, goats, oxen };
}

/** Guarantee a walkable corridor from a to b along a straight line (unwalkable tiles become road or rock-stair). */
function connectPath(grid: TileGrid, a: P, b: P) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 2);
  for (let k = 0; k <= n; k++) {
    const x = Math.round(a.x + ((b.x - a.x) * k) / n), z = Math.round(a.z + ((b.z - a.z) * k) / n);
    if (!grid.inBounds(x, z)) continue;
    const i = grid.idx(x, z);
    const t = grid.types[i];
    if (!grid.def(t).walkable) {
      grid.types[i] = 'road';
      if (grid.region[i] === 255) grid.region[i] = grid.regionAt(a.x, a.z);
    }
  }
}
