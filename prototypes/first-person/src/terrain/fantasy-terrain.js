/*
 * FantasyTerrain — procedural low-poly, high-topology terrain.
 * ES module copy of Documents/monster-game/fantasy-terrain.js (only the UMD wrapper changed), shared by the
 * terraformer page and the game (src/sim/terrain-import.ts).
 * Pure JavaScript, zero dependencies, engine-agnostic.
 *
 * Pipeline:
 *   createField(opts)        -> signed density field (d > 0 = solid rock)
 *   sampleGrid(field, opts)  -> coarse 3D sample grid (cell size = poly budget)
 *   surfaceNets(grid, opts)  -> indexed triangle mesh (caves, overhangs, arches OK)
 *   buildFlatMesh(...)       -> non-indexed, flat-shaded positions/normals/colors
 *   scatterCrystals(...)     -> glowing crystal transforms on cave surfaces
 *   spawnPoints(...)         -> flat, open ground points for gameplay
 *
 * The field is a pure function of world position + seed, so you can sample it
 * in chunks (pass origin/size to sampleGrid with closeEdges:false) and the
 * seams line up, including the facet jitter (hashed on global cell index).
 */
const FantasyTerrain = (function () {
  'use strict';

  // ---------- utilities ----------
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash3(x, y, z, s) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ Math.imul(s, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  function smoothstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- seeded 3D simplex noise (Gustavson) ----------
  function makeSimplex3(rand) {
    const g = new Float32Array([1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1]);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    const perm = new Uint8Array(512), pm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm[i] = perm[i] % 12; }
    const F3 = 1 / 3, G3 = 1 / 6;
    return function (xin, yin, zin) {
      const s = (xin + yin + zin) * F3;
      const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
      const t = (i + j + k) * G3;
      const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
      let i1, j1, k1, i2, j2, k2;
      if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
      } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      }
      const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
      const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
      const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
      const ii = i & 255, jj = j & 255, kk = k & 255;
      let n = 0, tt, gi;
      tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
      if (tt > 0) { gi = pm[ii + perm[jj + perm[kk]]] * 3; tt *= tt; n += tt * tt * (g[gi] * x0 + g[gi + 1] * y0 + g[gi + 2] * z0); }
      tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
      if (tt > 0) { gi = pm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (g[gi] * x1 + g[gi + 1] * y1 + g[gi + 2] * z1); }
      tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
      if (tt > 0) { gi = pm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (g[gi] * x2 + g[gi + 1] * y2 + g[gi + 2] * z2); }
      tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
      if (tt > 0) { gi = pm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (g[gi] * x3 + g[gi + 1] * y3 + g[gi + 2] * z3); }
      return 32 * n;
    };
  }

  // ---------- parameters ----------
  const DEFAULTS = {
    seed: 'monster-island',
    size: [128, 64, 128],   // world extent in units (x, y, z)
    baseHeight: 12,         // ground floor height
    hillHeight: 22,         // relief on top of baseHeight
    terraceStep: 5,         // height of each cliff step (0 = no terraces)
    terraceSharp: 0.3,      // fraction of a step that is cliff face (lower = sheerer)
    warp: 8,                // domain warp, world units (twistier = more alien)
    canyons: 0.6,           // 0..1 width/frequency of river canyons
    caves: 0.5,             // 0..1 spaghetti tunnel radius
    caverns: 0.4,           // 0..1 big underground chambers
    spires: 0.5,            // 0..1 count of twisted spires / hoodoos
    islands: 0.5,           // 0..1 count of floating islands
    arches: 0.5,            // 0..1 count of natural arches
    island: true,           // radial falloff into the sea (false for infinite chunks)
    waterLevel: 7,
  };

  // ---------- density field ----------
  function createField(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const rand = mulberry32(hashStr(String(o.seed)));
    const N = makeSimplex3(rand);
    const W = o.size[0], H = o.size[1], D = o.size[2];
    const cx = W / 2, cz = D / 2;

    function fbm(x, y, z, oct) {
      let s = 0, a = 1, f = 1, n = 0;
      for (let i = 0; i < oct; i++) { s += a * N(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2.03; }
      return s / n;
    }
    function terrace(h) {
      if (o.terraceStep <= 0) return h;
      const t = h / o.terraceStep, fl = Math.floor(t), f = t - fl;
      const sharp = Math.max(0.02, o.terraceSharp), c = 1 - sharp;
      let f2 = f < c ? 0 : (f - c) / sharp;
      f2 = f2 * f2 * (3 - 2 * f2);
      return (fl + f2) * o.terraceStep;
    }

    // Per-column data (cache this when sweeping a vertical column)
    function column(x, z) {
      const wx = x + o.warp * N(x * 0.015, 11.3, z * 0.015);
      const wz = z + o.warp * N(x * 0.015, 23.7, z * 0.015);
      let h = o.baseHeight + o.hillHeight * (0.5 + 0.9 * fbm(wx * 0.011, 5.1, wz * 0.011, 4));
      let fall = 1;
      if (o.island) {
        const dx = (x - cx) / cx, dz = (z - cz) / cz;
        const r = Math.sqrt(dx * dx + dz * dz) + 0.18 * N(x * 0.025, 77.7, z * 0.025);
        fall = 1 - smoothstep(0.62, 0.92, r);
        h = lerp(o.waterLevel - 8, h, fall);
      }
      h = terrace(h);
      let cn = 1, floorY = 0;
      if (o.canyons > 0) {
        cn = Math.abs(N(wx * 0.008 + 31.1, 3.3, wz * 0.008 - 12.7));
        floorY = o.waterLevel - 1.5 + 1.5 * N(x * 0.05, 9.9, z * 0.05);
      }
      return { h, cn, floorY, fall };
    }

    // Placed features
    const spires = [];
    const nSp = Math.round(o.spires * 12);
    for (let i = 0; i < nSp; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.55;
      const R = 2.6 + rand() * 3.2;
      const sp = {
        x: cx + Math.cos(a) * r * cx, z: cz + Math.sin(a) * r * cz,
        R, top: H * (0.5 + rand() * 0.42), ph: rand() * 6.28,
        lean: 1 + rand() * 4, twist: (rand() - 0.5) * 0.3, lobes: 2 + Math.floor(rand() * 3),
        cap: rand() < 0.5, capR: R * (1.8 + rand() * 1.2), capH: 2 + rand() * 2.5,
      };
      sp.bound = Math.max(R * 1.6, sp.capR * 1.2) + sp.lean;
      spires.push(sp);
    }
    const arches = [];
    const nAr = Math.round(o.arches * 6);
    for (let i = 0; i < nAr; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.5;
      const x = cx + Math.cos(a) * r * cx, z = cz + Math.sin(a) * r * cz;
      const R = 7 + rand() * 9, tr = 1.8 + rand() * 1.8, yaw = rand() * Math.PI;
      arches.push({ x, z, y: column(x, z).h - R * 0.3, R, r: tr, c: Math.cos(yaw), s: Math.sin(yaw) });
    }
    const isles = [];
    const nIs = Math.round(o.islands * 7);
    for (let i = 0; i < nIs; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.8;
      const R = 6 + rand() * 10;
      isles.push({
        x: cx + Math.cos(a) * r * cx, z: cz + Math.sin(a) * r * cz,
        top: H * (0.7 + rand() * 0.2), R, depth: R * (0.8 + rand() * 0.9), k: rand() * 100,
      });
    }

    function densityCol(x, y, z, c) {
      let d = c.h - y;

      // River canyons: ridged noise bands carved down to near water level, widening upward
      if (o.canyons > 0 && d > 0) {
        const w = 0.07 * o.canyons * (1 + Math.max(0, y - c.floorY) * 0.03);
        if (c.cn < w) {
          const m = 1 - smoothstep(w * 0.55, w, c.cn);
          d = Math.min(d, (c.floorY - y) + (1 - m) * 30);
        }
      }
      // Spaghetti caves: intersection of two noise zero-sets = winding tunnels
      if (o.caves > 0 && d > 0) {
        const a = N(x * 0.028, y * 0.042, z * 0.028);
        const b = N(x * 0.028 + 71.3, y * 0.042 - 33.1, z * 0.028 + 19.7);
        d = Math.min(d, (Math.sqrt(a * a + b * b) - 0.25 * o.caves) * 20);
      }
      // Caverns: low-frequency blobs, only well below the surface
      if (o.caverns > 0 && d > 0) {
        const v = N(x * 0.017 - 90.2, y * 0.026 + 4.4, z * 0.017 + 40.6);
        const band = smoothstep(3, 9, c.h - y) * smoothstep(1, 5, y);
        d = Math.min(d, ((0.75 - o.caverns * 0.5) - v) * 35 + (1 - band) * 20);
      }
      // Twisted spires / hoodoos with overhanging caps
      for (let i = 0; i < spires.length; i++) {
        const s = spires[i];
        if (y > s.top) continue;
        const dx = x - s.x - Math.sin(y * 0.07 + s.ph) * s.lean;
        const dz = z - s.z - Math.cos(y * 0.06 + s.ph) * s.lean;
        const d2 = dx * dx + dz * dz;
        if (d2 > s.bound * s.bound) continue;
        const dist = Math.sqrt(d2), k = 1 - y / s.top;
        const th = Math.atan2(dz, dx);
        const r = s.R * Math.pow(k, 0.6) * (1 + 0.28 * Math.cos(s.lobes * (th - y * s.twist))) * (1 + 0.15 * Math.sin(y * 0.35 + s.ph));
        d = Math.max(d, r - dist);
        if (s.cap) {
          const cb = s.top - s.capH;
          d = Math.max(d, Math.min(s.capR * (1 + 0.2 * Math.cos(3 * th + s.ph)) - dist, y - cb, s.top - y));
        }
      }
      // Natural arches: half-buried, noise-roughened tori
      for (let i = 0; i < arches.length; i++) {
        const a = arches[i];
        const px = x - a.x, py = y - a.y, pz = z - a.z, B = a.R + a.r * 1.5;
        if (Math.abs(py) > B || px * px + pz * pz > B * B) continue;
        const u = px * a.c + pz * a.s, v = -px * a.s + pz * a.c;
        const q = Math.sqrt(u * u + py * py) - a.R;
        d = Math.max(d, a.r * (1 + 0.35 * N(x * 0.12, y * 0.12, z * 0.12)) - Math.sqrt(q * q + v * v));
      }
      // Floating islands: flat tops, carrot-shaped rocky bottoms
      for (let i = 0; i < isles.length; i++) {
        const s = isles[i];
        if (y > s.top + 3 || y < s.top - s.depth - 4) continue;
        const dx = x - s.x, dz = z - s.z, d2 = dx * dx + dz * dz;
        if (d2 > s.R * s.R * 1.7) continue;
        const rr = Math.sqrt(d2) / s.R + 0.22 * N(x * 0.09, s.k, z * 0.09);
        if (rr >= 1) continue;
        const top = s.top + (1 - rr) * 1.5;
        const bottom = s.top - 1.2 - s.depth * Math.pow(1 - rr, 1.3) + 1.2 * N(x * 0.2, y * 0.1 + s.k, z * 0.2);
        d = Math.max(d, Math.min(top - y, y - bottom, (1 - rr) * s.R));
      }
      return d;
    }

    return {
      options: o,
      size: o.size,
      noise: N,
      column,
      densityCol,
      density: (x, y, z) => densityCol(x, y, z, column(x, z)),
      groundHeight: (x, z) => column(x, z).h,
      isles,
    };
  }

  // ---------- sampling ----------
  function sampleGrid(field, opts) {
    opts = opts || {};
    const cell = opts.cell || 2;
    const origin = opts.origin || [0, 0, 0];
    const size = opts.size || field.size;
    const closeEdges = opts.closeEdges !== false;
    const nx = Math.floor(size[0] / cell) + 1, ny = Math.floor(size[1] / cell) + 1, nz = Math.floor(size[2] / cell) + 1;
    const data = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const wz = origin[2] + k * cell;
      for (let i = 0; i < nx; i++) {
        const wx = origin[0] + i * cell;
        const col = field.column(wx, wz);
        const edgeXZ = i === 0 || i === nx - 1 || k === 0 || k === nz - 1;
        for (let j = 0; j < ny; j++) {
          let v = field.densityCol(wx, origin[1] + j * cell, wz, col);
          if (closeEdges && (edgeXZ || j === 0 || j === ny - 1)) v = -1;
          data[i + nx * (j + ny * k)] = v;
        }
      }
    }
    return { data, nx, ny, nz, cell, origin };
  }

  // ---------- Surface Nets mesher ----------
  // One vertex per sign-changing cell -> naturally coarse, faceted, handles any topology.
  function surfaceNets(grid, opts) {
    opts = opts || {};
    const jitter = opts.jitter || 0, jseed = opts.seed | 0;
    const { data, nx, ny, nz, cell, origin } = grid;
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const vidx = new Int32Array(cx * cy * cz).fill(-1);
    const pos = [];
    const S = (x, y, z) => x + nx * (y + ny * z);
    const off = []; for (let i = 0; i < 8; i++) off.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
    const edges = []; for (let i = 0; i < 8; i++) for (const b of [1, 2, 4]) if (!(i & b)) edges.push([i, i | b]);
    const vals = new Float32Array(8);
    const gx0 = Math.round(origin[0] / cell), gy0 = Math.round(origin[1] / cell), gz0 = Math.round(origin[2] / cell);

    for (let z = 0; z < cz; z++) for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
      let mask = 0;
      for (let i = 0; i < 8; i++) { const v = data[S(x + off[i][0], y + off[i][1], z + off[i][2])]; vals[i] = v; if (v > 0) mask |= 1 << i; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let e = 0; e < 12; e++) {
        const a = edges[e][0], b = edges[e][1], va = vals[a], vb = vals[b];
        if ((va > 0) === (vb > 0)) continue;
        const t = va / (va - vb), oa = off[a], ob = off[b];
        sx += oa[0] + t * (ob[0] - oa[0]); sy += oa[1] + t * (ob[1] - oa[1]); sz += oa[2] + t * (ob[2] - oa[2]); n++;
      }
      let px = sx / n, py = sy / n, pz = sz / n;
      if (jitter) {
        const gx = gx0 + x, gy = gy0 + y, gz = gz0 + z;
        px = Math.min(0.97, Math.max(0.03, px + (hash3(gx, gy, gz, jseed) - 0.5) * jitter));
        py = Math.min(0.97, Math.max(0.03, py + (hash3(gx, gy, gz, jseed + 1) - 0.5) * jitter));
        pz = Math.min(0.97, Math.max(0.03, pz + (hash3(gx, gy, gz, jseed + 2) - 0.5) * jitter));
      }
      vidx[x + cx * (y + cy * z)] = pos.length / 3;
      pos.push(origin[0] + (x + px) * cell, origin[1] + (y + py) * cell, origin[2] + (z + pz) * cell);
    }

    const V = (x, y, z) => vidx[x + cx * (y + cy * z)];
    const ind = [];
    // Loops are ordered so their normal points +axis; flip when solid is on the + side.
    const quad = (a, b, c, d, flip) => { if (flip) ind.push(a, c, b, a, d, c); else ind.push(a, b, c, a, c, d); };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const s0 = data[S(x, y, z)] > 0;
      if (x < cx && y > 0 && z > 0 && y < cy && z < cz && s0 !== (data[S(x + 1, y, z)] > 0))
        quad(V(x, y - 1, z - 1), V(x, y, z - 1), V(x, y, z), V(x, y - 1, z), !s0);
      if (y < cy && x > 0 && z > 0 && x < cx && z < cz && s0 !== (data[S(x, y + 1, z)] > 0))
        quad(V(x - 1, y, z - 1), V(x - 1, y, z), V(x, y, z), V(x, y, z - 1), !s0);
      if (z < cz && x > 0 && y > 0 && x < cx && y < cy && s0 !== (data[S(x, y, z + 1)] > 0))
        quad(V(x - 1, y - 1, z), V(x, y - 1, z), V(x, y, z), V(x - 1, y, z), !s0);
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(ind) };
  }

  // ---------- palettes ----------
  const PALETTES = {
    monster: {
      name: 'Monster Island', sky: 0x3a2f52, fog: 0x3a2f52, water: 0x2f6f7a, waterGlow: 0x000000,
      top: 0x5f8f3a, top2: 0x9db34e, sand: 0x8c7a5b, rockA: 0x6b5a7a, rockB: 0x564766,
      under: 0x2e2538, cave: 0x3b3350, caveFloor: 0x4b405f, crystals: [0x5ef2d6, 0xb46bff, 0xff6fae],
    },
    ember: {
      name: 'Ember Wastes', sky: 0x2a1512, fog: 0x3a1a12, water: 0xff5a14, waterGlow: 0xb83a08,
      top: 0x3f3a35, top2: 0x6e6255, sand: 0x2b2420, rockA: 0x8a3b24, rockB: 0x6a2a1a,
      under: 0x24130e, cave: 0x30180f, caveFloor: 0x3e2014, crystals: [0xffb03a, 0xff5a1f, 0xffe36b],
    },
    frost: {
      name: 'Frost Hollow', sky: 0xa9c4da, fog: 0xa9c4da, water: 0x2f6e9e, waterGlow: 0x000000,
      top: 0xe6eef4, top2: 0xffffff, sand: 0xb7c6d2, rockA: 0x6f8aa3, rockB: 0x5a738b,
      under: 0x3d5266, cave: 0x2c3e52, caveFloor: 0x3a5068, crystals: [0x7fd7ff, 0xc9a6ff, 0xe8fbff],
    },
  };
  const rgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

  // Face kinds
  const KIND = { TOP: 0, ROCK: 1, UNDER: 2, CAVE: 3, SAND: 4 };

  // ---------- flat-shaded mesh with per-face colour ----------
  function buildFlatMesh(mesh, field, palette) {
    const pal = typeof palette === 'string' ? PALETTES[palette] : (palette || PALETTES.monster);
    const C = {}; for (const k in pal) if (typeof pal[k] === 'number') C[k] = rgb(pal[k]);
    const P = mesh.positions, I = mesh.indices, nt = I.length / 3;
    const o = field.options, H = field.size[1];
    const positions = new Float32Array(nt * 9), normals = new Float32Array(nt * 9), colors = new Float32Array(nt * 9);
    const centroids = new Float32Array(nt * 3), faceNormals = new Float32Array(nt * 3), kinds = new Uint8Array(nt);
    const col = [0, 0, 0];
    for (let t = 0; t < nt; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;

      const covered = field.density(mx, my + 5, mz) > 0 && field.density(mx, my + 12, mz) > 0;
      let kind, base;
      if (my < o.waterLevel - 2) { kind = KIND.UNDER; base = C.under; }
      else if (covered) { kind = KIND.CAVE; base = ny > 0.5 ? C.caveFloor : C.cave; }
      else if (ny > 0.62 && my < o.waterLevel + 1.3) { kind = KIND.SAND; base = C.sand; }
      else if (ny > 0.62) {
        kind = KIND.TOP;
        const f = smoothstep(o.baseHeight, H * 0.8, my);
        col[0] = lerp(C.top[0], C.top2[0], f); col[1] = lerp(C.top[1], C.top2[1], f); col[2] = lerp(C.top[2], C.top2[2], f);
        base = col;
      } else if (ny < -0.35) { kind = KIND.UNDER; base = C.under; }
      else {
        kind = KIND.ROCK;
        const band = Math.floor((my + 1.5 * field.noise(mx * 0.05, 0, mz * 0.05)) / 3) & 1;
        base = band ? C.rockA : C.rockB;
      }
      const shade = 0.92 + 0.16 * hash3(t, 7, 3, 1);
      const r = base[0] * shade, g = base[1] * shade, bl = base[2] * shade;
      const v = [ax, ay, az, bx, by, bz, cx, cy, cz];
      for (let k = 0; k < 3; k++) {
        const o9 = t * 9 + k * 3;
        positions[o9] = v[k * 3]; positions[o9 + 1] = v[k * 3 + 1]; positions[o9 + 2] = v[k * 3 + 2];
        normals[o9] = nx; normals[o9 + 1] = ny; normals[o9 + 2] = nz;
        colors[o9] = r; colors[o9 + 1] = g; colors[o9 + 2] = bl;
      }
      centroids[t * 3] = mx; centroids[t * 3 + 1] = my; centroids[t * 3 + 2] = mz;
      faceNormals[t * 3] = nx; faceNormals[t * 3 + 1] = ny; faceNormals[t * 3 + 2] = nz;
      kinds[t] = kind;
    }
    return { positions, normals, colors, centroids, faceNormals, kinds, triangleCount: nt, palette: pal };
  }

  // ---------- decoration ----------
  function scatterCrystals(flat, field, opts) {
    opts = opts || {};
    const rate = opts.rate == null ? 0.06 : opts.rate;
    const rand = mulberry32(hashStr(String(field.options.seed) + ':crystals'));
    const out = [];
    const nCol = flat.palette.crystals.length;
    for (let t = 0; t < flat.triangleCount; t++) {
      if (flat.kinds[t] !== KIND.CAVE || rand() > rate) continue;
      const shards = 1 + Math.floor(rand() * 3), color = flat.palette.crystals[Math.floor(rand() * nCol)];
      for (let s = 0; s < shards; s++) {
        let nx = flat.faceNormals[t * 3] + (rand() - 0.5) * 0.7;
        let ny = flat.faceNormals[t * 3 + 1] + (rand() - 0.5) * 0.7;
        let nz = flat.faceNormals[t * 3 + 2] + (rand() - 0.5) * 0.7;
        const l = Math.hypot(nx, ny, nz) || 1;
        out.push({
          position: [flat.centroids[t * 3], flat.centroids[t * 3 + 1], flat.centroids[t * 3 + 2]],
          direction: [nx / l, ny / l, nz / l], scale: 0.6 + rand() * 1.6, spin: rand() * 6.28, color,
        });
      }
    }
    return out;
  }

  function spawnPoints(flat, opts) {
    opts = opts || {};
    const count = opts.count || 16, minDist = opts.minDist || 12, seed = opts.seed || 'spawn';
    const rand = mulberry32(hashStr(String(seed)));
    const cand = [];
    for (let t = 0; t < flat.triangleCount; t++)
      if (flat.kinds[t] === KIND.TOP && flat.faceNormals[t * 3 + 1] > 0.95) cand.push(t);
    const pts = [];
    for (let tries = 0; tries < count * 30 && pts.length < count && cand.length; tries++) {
      const t = cand[Math.floor(rand() * cand.length)];
      const p = [flat.centroids[t * 3], flat.centroids[t * 3 + 1], flat.centroids[t * 3 + 2]];
      if (pts.every((q) => Math.hypot(q[0] - p[0], q[2] - p[2]) >= minDist)) pts.push(p);
    }
    return pts;
  }

  // ---------- convenience ----------
  function generate(opts) {
    opts = opts || {};
    const field = createField(opts);
    const grid = sampleGrid(field, { cell: opts.cell || 2 });
    const mesh = surfaceNets(grid, { jitter: opts.jitter == null ? 0.2 : opts.jitter, seed: hashStr(String(field.options.seed)) });
    const flat = buildFlatMesh(mesh, field, opts.palette || 'monster');
    const crystals = scatterCrystals(flat, field, { rate: opts.crystalRate });
    return { field, grid, mesh, flat, crystals, spawns: spawnPoints(flat, { seed: field.options.seed }) };
  }

  return { DEFAULTS, PALETTES, KIND, createField, sampleGrid, surfaceNets, buildFlatMesh, scatterCrystals, spawnPoints, generate, makeSimplex3, mulberry32, hashStr };
})();

export default FantasyTerrain;
