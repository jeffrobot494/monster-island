// Climbing on the feature mesh (docs/climbing-phase2-plan.md, Part D, tests 23–30): a synthetic spire, arch and
// overhang on flat ground, then the real default terrain and the sim's rules for arch tops.
import { describe, it, expect } from 'vitest';
import { Ground, M, NV } from '../src/sim/ground';
import { SIZE, TileGrid } from '../src/sim/world';
import { ChampionController } from '../src/input/controller';
import { FeatureSurface } from '../src/input/feature-surface';
import { buildFeatureMesh } from '../src/render/feature-mesh';
import { DEFAULT_SETTINGS } from '../src/sim/terrain-import';
import { Island } from '../src/sim/island';
import { cs, type ChampInput } from '../src/sim/champion';
import { champReachable } from '../src/sim/body';
import type { Controls, ActionName } from '../src/input/controls';
import { now, START } from './helpers';

const FOOT = 2;
const HANDS = 1.3;
type V = [number, number, number];

/** a quad's two triangles, wound so the normal points along `out` */
function quad(tris: number[], a: V, b: V, c: V, d: V, out: V) {
  const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
  const flip = n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0;
  for (const t of flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]) tris.push(...t);
}

/** an axis-aligned box in meters */
function box(tris: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  quad(tris, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
  quad(tris, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  quad(tris, [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0]);
  quad(tris, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
  quad(tris, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
  quad(tris, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
}

// all in meters: tile 64 starts at 512
const SPIRE = { x0: 64 * M, x1: 64 * M + 10, z0: 63.5 * M, z1: 63.5 * M + 10, top: FOOT + 20 };
const ARCH = { lx0: 72 * M, lx1: 72 * M + 4, rx0: 74 * M, rx1: 74 * M + 4, z0: 63.5 * M, z1: 63.5 * M + 6, under: FOOT + 10, top: FOOT + 13 };
/** a wedge whose -x face leans out 20° past vertical, 16 m tall */
const OVER = { x: 84 * M, h: 16, lean: Math.tan((20 * Math.PI) / 180), z0: 62 * M, z1: 66 * M };

function scene() {
  const tris: number[] = [];
  box(tris, SPIRE.x0, SPIRE.x1, FOOT - 1, SPIRE.top, SPIRE.z0, SPIRE.z1);
  box(tris, ARCH.lx0, ARCH.lx1, FOOT - 1, ARCH.under, ARCH.z0, ARCH.z1);
  box(tris, ARCH.rx0, ARCH.rx1, FOOT - 1, ARCH.under, ARCH.z0, ARCH.z1);
  box(tris, ARCH.lx0, ARCH.rx1, ARCH.under, ARCH.top, ARCH.z0, ARCH.z1);
  // the wedge: front face from (x, FOOT−1) to (x − lean·h, FOOT + h), back at x + 20
  const { x, h, lean, z0, z1 } = OVER, y0 = FOOT - 1, y1 = FOOT + h, xt = x - lean * (h + 1), xb = x + 20;
  quad(tris, [x, y0, z0], [xt, y1, z0], [xt, y1, z1], [x, y0, z1], [-1, -lean, 0]);
  quad(tris, [xt, y1, z0], [xb, y1, z0], [xb, y1, z1], [xt, y1, z1], [0, 1, 0]);
  quad(tris, [xb, y0, z0], [xb, y1, z0], [xb, y1, z1], [xb, y0, z1], [1, 0, 0]);
  for (const [zz, s] of [[z0, -1], [z1, 1]] as const) {
    tris.push(x, y0, zz, xt, y1, zz, xb, y1, zz, x, y0, zz, xb, y1, zz, xb, y0, zz);
    if (s < 0) for (let k = tris.length - 18; k < tris.length; k += 9) for (let j = 0; j < 3; j++) [tris[k + 3 + j], tris[k + 6 + j]] = [tris[k + 6 + j], tris[k + 3 + j]];
  }
  const grid = new TileGrid();
  grid.types.fill('grass');
  // footprints are cliff tiles, as the importer marks them
  const mark = (x0: number, x1: number, z0: number, z1: number) => {
    for (let z = Math.floor(z0 / M); z <= Math.floor((z1 - 0.01) / M); z++) for (let x = Math.floor(x0 / M); x <= Math.floor((x1 - 0.01) / M); x++) grid.types[z * SIZE + x] = 'cliff';
  };
  mark(SPIRE.x0, SPIRE.x1, SPIRE.z0, SPIRE.z1);
  mark(ARCH.lx0, ARCH.lx1, ARCH.z0, ARCH.z1);
  mark(ARCH.rx0, ARCH.rx1, ARCH.z0, ARCH.z1);
  mark(OVER.x - OVER.lean * OVER.h, OVER.x + 20, OVER.z0, OVER.z1);
  grid.base = new Float32Array(NV * NV).fill(FOOT);
  grid.orig = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) grid.orig[i] = grid.height(i % SIZE, Math.floor(i / SIZE));
  const ground = new Ground(grid);
  const walk = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) walk[i] = grid.def(grid.types[i]).walkable ? 20 : 0;
  return { grid, ground, walk, feat: new FeatureSurface(tris) };
}

class FakeControls {
  keys = new Set<ActionName>();
  down(a: ActionName) {
    return this.keys.has(a);
  }
  take() {
    return false;
  }
  readLook(): [number, number] {
    return [0, 0];
  }
}

type W = { grid: TileGrid; ground: Ground; walk: Uint8Array; feat: FeatureSurface | null };
function make(w: W, x: number, z: number, yaw = Math.PI / 2, alt = 0) {
  const controls = new FakeControls();
  const c = new ChampionController(controls as unknown as Controls, w.ground, () => {});
  c.walk = w.walk;
  c.grid = w.grid;
  c.feat = w.feat;
  c.ctrl = 'player';
  c.reason = 'player';
  c.snap(x, z, alt);
  c.yaw = yaw;
  const falls: number[] = [];
  c.onFall = (i) => falls.push(i);
  let t = 1000;
  const run = (secs: number, each?: () => void, dt = 1 / 60) => {
    for (let k = 0; k < Math.round(secs / dt); k++) {
      t += dt;
      c.update(dt, t);
      each?.();
    }
  };
  return { c, controls, falls, run };
}

/** is a point (tiles, m) inside a box (m)? */
const inBox = (x: number, y: number, z: number, b: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }) =>
  x * M > b.x0 && x * M < b.x1 && y > b.y0 && y < b.y1 && z * M > b.z0 && z * M < b.z1;

describe('feature surface', () => {
  it('23: floor on the top, none from an underside, ray distances, sphere hits', () => {
    const { feat } = scene();
    const cx = (SPIRE.x0 + SPIRE.x1) / 2 / M, cz = (SPIRE.z0 + SPIRE.z1) / 2 / M;
    expect(feat.floor(cx, cz, 100)!.y).toBeCloseTo(SPIRE.top, 4);
    expect(feat.floor(cx, cz, SPIRE.top - 1)).toBeNull(); // the bottom faces down: not a floor
    // under the arch span: nothing below 11 m; the span's top above it
    const ax = (ARCH.lx1 + ARCH.rx0) / 2 / M, az = (ARCH.z0 + ARCH.z1) / 2 / M;
    expect(feat.floor(ax, az, ARCH.under + 1)).toBeNull();
    expect(feat.floor(ax, az, 100)!.y).toBeCloseTo(ARCH.top, 4);
    // a ray from 3 m out, at 5 m up, into the spire's -x face
    const r = feat.ray((SPIRE.x0 - 3) / M, cz, FOOT + 5, 1, 0, 6)!;
    expect(r.d).toBeCloseTo(3, 3);
    expect(feat.nrm[r.t * 3]).toBeCloseTo(-1, 5);
    // a ray from inside the spire sees no front face of it
    expect(feat.ray(cx, cz, FOOT + 5, 1, 0, 4)).toBeNull();
    expect(feat.sphereHit((SPIRE.x0 - 0.2) / M, cz, FOOT + 1, 0.33)).toBeGreaterThanOrEqual(0);
    expect(feat.sphereHit((SPIRE.x0 - 0.5) / M, cz, FOOT + 1, 0.33)).toBe(-1);
    // the top is a floor, not a wall
    expect(feat.sphereHit(cx, cz, SPIRE.top + 0.1, 0.33)).toBe(-1);
  });
});

describe('climbing the feature mesh', () => {
  const spireZ = (SPIRE.z0 + SPIRE.z1) / 2 / M;

  it('24: walking into the spire is blocked; holding forward climbs it and mantles onto the top', () => {
    const w = scene();
    const { c, controls, run } = make(w, (SPIRE.x0 - 3) / M, spireZ);
    controls.keys.add('forward');
    let inside = false;
    run(1.5, () => {
      inside ||= c.x * M > SPIRE.x0 - 0.2;
    });
    expect(inside).toBe(false);
    expect(c.mode).toBe('wall');
    let mantled = false;
    run(16, () => {
      if (c.mode === 'mantle') controls.keys.clear(); // and stay up there
      mantled ||= c.mode === 'mantle';
      inside ||= c.mode !== 'mantle' && inBox(c.x, c.feetY + 0.6, c.z, { x0: SPIRE.x0 + 0.1, x1: SPIRE.x1, y0: FOOT, y1: SPIRE.top - 0.1, z0: SPIRE.z0, z1: SPIRE.z1 });
    });
    expect(inside).toBe(false);
    expect(mantled).toBe(true);
    expect(c.mode).toBe('walk');
    expect(c.feetY).toBeCloseTo(SPIRE.top, 1);
    expect(c.x * M).toBeGreaterThan(SPIRE.x0);
  });

  it('25: walking off the spire top is a fall, with a landing reported', () => {
    const w = scene();
    const { c, controls, falls, run } = make(w, (SPIRE.x0 + 5) / M, spireZ, Math.PI / 2, SPIRE.top - FOOT);
    run(0.3);
    expect(c.mode).toBe('walk');
    expect(c.feetY).toBeCloseTo(SPIRE.top, 2);
    controls.keys.add('forward');
    let fell = false;
    run(4, () => (fell ||= c.mode === 'air'));
    expect(fell).toBe(true);
    expect(c.mode).toBe('walk');
    expect(c.feetY).toBeCloseTo(FOOT, 1);
    expect(falls.length).toBe(1);
  });

  it('26: under the arch you stay on the ground; on the span you stay on it; walking off it falls', () => {
    const w = scene();
    const ax = (ARCH.lx1 + ARCH.rx0) / 2 / M;
    const under = make(w, ax, (ARCH.z0 - 6) / M, 0);
    under.controls.keys.add('forward');
    let maxY = 0;
    under.run(4, () => (maxY = Math.max(maxY, under.c.feetY)));
    expect(under.c.z * M).toBeGreaterThan(ARCH.z1 + 1); // went right under it
    expect(maxY).toBeLessThan(FOOT + 0.01);
    expect(under.c.mode).toBe('walk');
    // along the span (+x), from over the left leg
    const top = make(w, (ARCH.lx0 + 1) / M, (ARCH.z0 + 3) / M, Math.PI / 2, ARCH.top - FOOT);
    top.run(0.3);
    expect(top.c.feetY).toBeCloseTo(ARCH.top, 2);
    top.controls.keys.add('forward');
    let lowest = Infinity;
    top.run(2.5, () => (lowest = Math.min(lowest, top.c.feetY)));
    expect(top.c.x * M).toBeGreaterThan((ARCH.lx1 + ARCH.rx0) / 2); // out over the gap
    expect(lowest).toBeCloseTo(ARCH.top, 2);
    // then sideways off the span's edge (+z): a fall to the ground
    top.c.yaw = 0;
    top.run(3);
    expect(top.c.mode).toBe('walk');
    expect(top.c.feetY).toBeCloseTo(FOOT, 1);
    expect(top.falls.length).toBe(1);
  });

  it('27: a face leaning out 20° is climbable, drains ×2, and keeps the eye out of the rock', () => {
    const w = scene();
    const z = (OVER.z0 + OVER.z1) / 2 / M;
    const { c, controls, run } = make(w, (OVER.x - 3) / M, z);
    controls.keys.add('forward');
    run(1.5);
    expect(c.mode).toBe('wall');
    expect(c.face?.over).toBe(true);
    c.stamina = 100;
    let inRock = false;
    const st = c.stamina;
    run(2, () => {
      // the face's x at the eye's height
      const fx = OVER.x - OVER.lean * (c.eyeY - (FOOT - 1));
      inRock ||= c.x * M > fx - 0.1;
    });
    expect(inRock).toBe(false);
    expect(c.mode).toBe('wall');
    expect(st - c.stamina).toBeCloseTo(24, 0); // 6/s × 2 for 2 s
    run(10);
    expect(c.feetY).toBeCloseTo(FOOT + OVER.h, 0); // it pulled up onto the top
    expect(c.mode).toBe('walk');
  });

  it('28: an underside stops an upward climb', () => {
    const w = scene();
    // the left leg's inner face (+x side), climbed from under the span
    const z = (ARCH.z0 + ARCH.z1) / 2 / M;
    const { c, controls, run } = make(w, (ARCH.lx1 + 3) / M, z, -Math.PI / 2);
    controls.keys.add('forward');
    run(1.5);
    expect(c.mode).toBe('wall');
    let headIn = false;
    run(8, () => (headIn ||= c.eyeY > ARCH.under - 0.05 && c.mode === 'wall'));
    expect(headIn).toBe(false);
    expect(c.feetY).toBeGreaterThan(ARCH.under - 2.2); // it did get up there
  });
});

describe('the real terrain', () => {
  it('29: every triangle is hashed; real spire faces can be grabbed and climbed', () => {
    const island = Island.create(7, START, 1, { now }, DEFAULT_SETTINGS);
    const { surface } = buildFeatureMesh(DEFAULT_SETTINGS);
    expect(surface.count).toBeGreaterThan(5000);
    // every triangle can be found from its own centroid's tile
    let missing = 0;
    for (let t = 0; t < surface.count; t++) {
      const o = t * 9, T = surface.tri;
      const cx = (T[o] + T[o + 3] + T[o + 6]) / 3 / M, cz = (T[o + 2] + T[o + 5] + T[o + 8]) / 3 / M;
      if (cx < 0 || cz < 0 || cx >= SIZE || cz >= SIZE) continue;
      if (surface.sphereHit(cx, cz, (T[o + 1] + T[o + 4] + T[o + 7]) / 3, 0.01) !== t && surface.ny(t) < 0.64) {
        // another triangle may come first; check it's there at all
        const hit = surface.sphereHit(cx, cz, (T[o + 1] + T[o + 4] + T[o + 7]) / 3, 0.01);
        if (hit < 0) missing++;
      }
    }
    expect(missing).toBe(0);
    const sim = island.sim;
    const walk = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) walk[i] = sim.walkableFor('human', i % SIZE + 0.5, Math.floor(i / SIZE) + 0.5) ? 20 : 0;
    const w = { grid: sim.grid, ground: sim.ground, walk, feat: surface };
    // steep rock faces 3–40 m up with open air in front: grabbed there (as a correction mid-climb would), the
    // climber holds on and climbs on up, never ending up inside the rock
    let tried = 0, climbed = 0;
    const T = surface.tri, N = surface.nrm;
    for (let t = 0; t < surface.count && tried < 40; t += 7) {
      const ny = N[t * 3 + 1];
      if (ny > 0.4 || ny < -0.3) continue;
      const o = t * 9, h = Math.hypot(N[t * 3], N[t * 3 + 2]);
      const nx = N[t * 3] / h, nz = N[t * 3 + 2] / h;
      const cx = (T[o] + T[o + 3] + T[o + 6]) / 3 / M, cy = (T[o + 1] + T[o + 4] + T[o + 7]) / 3, cz = (T[o + 2] + T[o + 5] + T[o + 8]) / 3 / M;
      const bx = cx + (nx * 0.6) / M, bz = cz + (nz * 0.6) / M;
      if (bx < 2 || bz < 2 || bx > SIZE - 2 || bz > SIZE - 2) continue;
      const alt = cy - HANDS - sim.ground.y(bx, bz);
      if (alt < 3 || alt > 40) continue;
      // open air in front (nothing between 3 m out and the face) and room for the body
      const back = surface.ray(cx + (nx * 3) / M, cz + (nz * 3) / M, cy, -nx, -nz, 3.5);
      if (!back || back.t !== t || surface.sphereHit(bx, bz, cy - 0.5, 0.4) >= 0) continue;
      tried++;
      const k = make(w, bx, bz, Math.atan2(-nx, -nz), alt);
      if (k.c.mode !== 'wall') {
        if (process.env.DBG) console.log(`no grab at tri ${t}: ${k.c.mode}`);
        continue;
      }
      const y0 = k.c.feetY;
      k.controls.keys.add('forward');
      let fell = false;
      k.run(2, () => (fell ||= k.c.mode === 'air'));
      if (!fell && k.c.feetY > y0 + 1) climbed++;
      else if (process.env.DBG) console.log(`tri ${t}: fell ${fell}, rose ${(k.c.feetY - y0).toFixed(1)} m, mode ${k.c.mode}`);
    }
    expect(tried).toBeGreaterThan(5);
    console.info(`[test 29] ${climbed} of ${tried} grabs held and climbed`);
    expect(climbed / tried).toBeGreaterThan(0.7);
  }, 60000);

  it('30: the sim takes an arch-top pose over a drop, and a ground monster under it can\'t reach', () => {
    const island = Island.create(7, START, 1, { now }, DEFAULT_SETTINGS);
    const sim = island.sim;
    const c = sim.champion()!;
    // a walkable spot with a steep drop beside it: the feet stay level while the ground under them falls away
    let spot: { x: number; z: number; x2: number; drop: number } | null = null;
    for (let z = 4; z < SIZE - 4; z++) for (let x = 4; x < SIZE - 5; x++) {
      if (!sim.walkableFor('human', x + 0.5, z + 0.5) || !sim.walkableFor('human', x + 1.5, z + 0.5)) continue;
      const drop = sim.ground.y(x + 0.5, z + 0.5) - sim.ground.y(x + 1.5, z + 0.5);
      if (drop > 3 && (!spot || drop > spot.drop)) spot = { x: x + 0.5, z: z + 0.5, x2: x + 1.5, drop };
    }
    expect(spot).not.toBeNull();
    const feet = sim.ground.y(spot!.x, spot!.z) + 12;
    c.x = spot!.x;
    c.z = spot!.z;
    c.human!.alt = 12;
    cs(sim).epoch++;
    cs(sim).poses = [];
    const feed = (i: ChampInput) => sim.inputs.push(i);
    const p = (x: number) => feed({ type: 'pose', x, z: spot!.z, yaw: 0, pitch: 0, epoch: cs(sim).epoch, input: true, alt: feet - sim.ground.y(x, spot!.z), climb: 'perch' });
    p(spot!.x);
    island.step();
    // one tile along in 0.35-tile steps (a sprint); alt rises by meters a tick while the feet stay level
    let maxRise = 0;
    for (let x = spot!.x + 0.35; ; x = Math.min(spot!.x2, x + 0.35)) {
      const a0 = c.human!.alt!;
      p(x);
      island.step();
      maxRise = Math.max(maxRise, c.human!.alt! - a0);
      if (x >= spot!.x2) break;
    }
    expect(maxRise).toBeGreaterThan(2); // more than the old alt bound allowed in a tick
    expect(c.x).toBeCloseTo(spot!.x2, 5);
    expect(sim.ground.y(c.x, c.z) + c.human!.alt!).toBeCloseTo(feet, 3);
    // a ground monster under it can't reach; that's "up where it can't follow"
    const m = [...sim.ents.values()].find((e) => e.kind === 'monster' && !e.monster!.flies)!;
    m.x = c.x;
    m.z = c.z;
    expect(champReachable(sim.ground, m, c)).toBe(false);
  }, 60000);
});
