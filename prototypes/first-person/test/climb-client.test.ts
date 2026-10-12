// Climbing, client side (docs/climbing-phase1-plan.md, Part E, tests 12–22): the controller on a synthetic
// terraformer ground. No DOM: a fake Controls drives it.
import { describe, it, expect } from 'vitest';
import { Ground, M, NV, RES } from '../src/sim/ground';
import { SIZE, TileGrid } from '../src/sim/world';
import { ChampionController } from '../src/input/controller';
import { distToFace, faceAt, WALL } from '../src/input/climb-surface';
import type { Controls, ActionName } from '../src/input/controls';

/** A ground that runs along x: `prof(xTiles)` gives the height (m); tile types from `type(xTile)`. */
function world(prof: (x: number) => number, type: (x: number) => string) {
  const grid = new TileGrid();
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) grid.types[z * SIZE + x] = type(x);
  grid.base = new Float32Array(NV * NV);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) grid.base[j * NV + i] = prof(i / RES);
  grid.orig = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) grid.orig[z * SIZE + x] = grid.height(x, z);
  const ground = new Ground(grid);
  const walk = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) walk[i] = grid.def(grid.types[i]).walkable ? 20 : 0;
  return { grid, ground, walk };
}

/** a 20 m step (78.7°) over one 4 m cell at x 64–64.5; cliff tiles 63–64 */
const FOOT = 2, TOP = 22;
const step = (top = 'grass', foot = 'grass', at = 64) =>
  world((x) => (x <= at ? FOOT : x >= at + 0.5 ? TOP : FOOT + (TOP - FOOT) * ((x - at) / 0.5)), (x) => (x === 63 || x === 64 ? 'cliff' : x < 63 ? foot : top));
/** a long 60° face from x 60 to 66 */
const SLOPE60 = Math.tan((60 * Math.PI) / 180);
const ramp60 = () => world((x) => FOOT + Math.min(6, Math.max(0, x - 60)) * M * SLOPE60, (x) => (x >= 59 && x <= 66 ? 'cliff' : 'grass'));

class FakeControls {
  keys = new Set<ActionName>();
  presses = new Set<ActionName>();
  down(a: ActionName) {
    return this.keys.has(a);
  }
  take(a: ActionName) {
    const had = this.presses.has(a);
    this.presses.delete(a);
    return had;
  }
  readLook(): [number, number] {
    return [0, 0];
  }
}

function make(w: ReturnType<typeof world>, x: number, z = 64, yaw = Math.PI / 2) {
  const controls = new FakeControls();
  const sent: unknown[] = [];
  const c = new ChampionController(controls as unknown as Controls, w.ground, (m) => sent.push(m));
  c.walk = w.walk;
  c.grid = w.grid;
  c.ctrl = 'player';
  c.reason = 'player';
  c.snap(x, z);
  c.yaw = yaw;
  const falls: number[] = [];
  c.onFall = (i) => falls.push(i);
  let t = performance.now() / 1000;
  /** run for `secs` at `dt`, calling `each` after every frame */
  const run = (secs: number, dt = 1 / 60, each?: () => void) => {
    for (let k = 0; k < Math.round(secs / dt); k++) {
      t += dt;
      c.update(dt, t);
      each?.();
    }
  };
  return { c, controls, sent, falls, run, now: () => t };
}

describe('climb surface', () => {
  it('12: faceAt points out of the step; distToFace finds it', () => {
    const w = step();
    const f = faceAt(w.ground, 64.25, 64);
    expect(f.nx).toBeLessThan(-0.99);
    expect(f.slope).toBeGreaterThan(WALL);
    // from x 63.5 the ground reaches 12 m at x 64.25: 0.75 tiles = 6 m
    const d = distToFace(w.ground, 63.5, 64, -1, 0, 12, 8)!;
    expect(Math.abs(d - 6)).toBeLessThan(0.1);
  });
});

describe('climbing controller', () => {
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    it(`13: at dt 1/${Math.round(1 / dt)} walking never goes up the face, and walking off the top always falls`, () => {
      const w = step();
      const up = make(w, 63.6);
      up.c.dragging = true; // no climbing, just walking into it
      up.controls.keys.add('forward');
      up.run(3, dt);
      expect(up.c.mode).toBe('walk');
      expect(up.c.x).toBeLessThan(64.1);
      expect(up.c.feetY).toBeLessThan(FOOT + 3);
      const down = make(w, 65.2, 64, -Math.PI / 2);
      down.controls.keys.add('forward');
      let fell = false;
      down.run(3, dt, () => (fell ||= down.c.mode === 'air'));
      expect(fell).toBe(true);
      expect(down.c.mode).toBe('walk');
      expect(down.c.feetY).toBeLessThan(FOOT + 0.5);
      expect(down.falls.length).toBe(1);
      expect(down.falls[0]).toBeGreaterThan(13);
    });
  }

  it('14: pushing into the face starts a climb; holding forward climbs it and mantles on top', () => {
    const { c, controls, run } = make(step(), 63.6);
    controls.keys.add('forward');
    run(1.2);
    expect(c.mode).toBe('wall');
    let mantled = false;
    run(14, 1 / 60, () => (mantled ||= c.mode === 'mantle'));
    expect(mantled).toBe(true);
    expect(c.mode).toBe('walk');
    expect(c.x).toBeGreaterThan(64.5);
    expect(Math.abs(c.feetY - TOP)).toBeLessThan(0.2);
  });

  it('15: holding still on a 60° face stays on the wall (no flicker to walk)', () => {
    const { c, controls, run } = make(ramp60(), 59.6);
    controls.keys.add('forward');
    run(3);
    expect(c.mode).toBe('wall');
    controls.keys.delete('forward');
    const modes = new Set<string>();
    const y = c.feetY;
    run(2, 1 / 60, () => modes.add(c.mode));
    expect([...modes]).toEqual(['wall']);
    expect(Math.abs(c.feetY - y)).toBeLessThan(0.01);
  });

  it('16: out of stamina it falls, and reports a hard landing', () => {
    const { c, controls, falls, run } = make(step(), 63.6);
    controls.keys.add('forward');
    run(1.2);
    expect(c.mode).toBe('wall');
    run(6); // ~10 m up
    expect(c.feetY - FOOT).toBeGreaterThan(8);
    c.stamina = 2;
    controls.keys.clear();
    run(4);
    expect(c.mode).toBe('walk');
    expect(falls.length).toBe(1);
    expect(falls[0]).toBeGreaterThan(13);
  });

  it('17: landing on a steep face slides down it instead of standing', () => {
    const w = ramp60();
    const { c, run } = make(w, 58);
    c.x = 63;
    c.mode = 'air';
    c.feetY = w.ground.y(63, 64) + 2;
    let stoodOnFace = false;
    run(4, 1 / 60, () => (stoodOnFace ||= c.mode === 'walk' && faceAt(w.ground, c.x, c.z).slope > WALL));
    expect(stoodOnFace).toBe(false);
    expect(c.mode).toBe('walk');
    expect(c.x).toBeLessThan(60.2);
  });

  it('18: over water at the foot: no stuck walk mode; no mantle onto a house', () => {
    const w = world((x) => (x <= 64 ? -3 : x >= 64.5 ? TOP : -3 + (TOP + 3) * ((x - 64) / 0.5)), (x) => (x === 63 || x === 64 ? 'cliff' : x < 63 ? 'shallow-water' : 'grass'));
    const { c, controls, run } = make(w, 65.2, 64, -Math.PI / 2);
    // walk off the top holding Space: grab the wall on the way down
    controls.keys.add('forward');
    controls.keys.add('jump');
    run(1.5, 1 / 60, () => c.climbing && controls.keys.clear());
    expect(c.mode).toBe('wall');
    controls.keys.clear();
    controls.keys.add('back');
    const bad: string[] = [];
    run(12, 1 / 60, () => {
      if (c.mode === 'walk' && !c.walkable(c.x, c.z)) bad.push(`walk at ${c.x.toFixed(2)}`);
      if (c.mode === 'wall' && c.feetY < w.ground.y(c.x, c.z) - 0.01) bad.push('feet under ground');
    });
    expect(bad).toEqual([]);

    // a house right on the lip (the face ends at the tile edge): climb up, never mantle
    const h = step('house', 'grass', 64.5);
    const up = make(h, 63.6);
    up.controls.keys.add('forward');
    let mantled = false, high = 0;
    up.run(14, 1 / 60, () => {
      mantled ||= up.c.mode === 'mantle';
      high = Math.max(high, up.c.feetY);
    });
    expect(high).toBeGreaterThan(TOP - 2); // it did climb to the lip
    expect(mantled).toBe(false);
    expect(up.c.x).toBeLessThan(65);
  });

  it('19: paused while hanging: stays on the wall, no drain, no drop; a resync snap keeps the climb', () => {
    const w = step();
    const { c, controls, run } = make(w, 63.6);
    controls.keys.add('forward');
    run(4);
    expect(c.mode).toBe('wall');
    const st = c.stamina, eye = c.eyeY;
    c.ctrl = 'sim';
    c.reason = 'hold';
    run(2);
    expect(c.mode).toBe('wall');
    expect(c.stamina).toBe(st);
    expect(c.eyeY).toBeCloseTo(eye, 5);
    c.ctrl = 'player';
    c.reason = 'player';
    c.snap(c.x, c.z, c.feetY - w.ground.y(c.x, c.z));
    expect(c.mode).toBe('wall');
  });

  it('20: paused mid-fall: the fall continues and still reports the landing', () => {
    const { c, controls, falls, run } = make(step(), 65.2, 64, -Math.PI / 2);
    controls.keys.add('forward');
    run(2, 1 / 60, () => {
      if (c.mode === 'air' && c.reason === 'player') {
        c.ctrl = 'sim';
        c.reason = 'hold';
        controls.keys.clear();
      }
    });
    run(3);
    expect(c.reason).toBe('hold');
    expect(c.mode).toBe('walk');
    expect(falls.length).toBe(1);
  });

  it('21: a correction far away, up beside a face, regrabs it without Space', () => {
    const w = step();
    const { c } = make(w, 60);
    // a climber's spot: 0.45 m out from the face at feet height 12
    const bx = 64 + ((12 - FOOT) / (TOP - FOOT)) * 0.5 - 0.45 / M;
    c.snap(bx, 64, 12 - w.ground.y(bx, 64));
    expect(c.mode).toBe('wall');
  });

  it('22: no climb while dragging or downed; Space on a wall never ground-jumps', () => {
    const w = step();
    for (const set of [(c: ChampionController) => (c.dragging = true), (c: ChampionController) => (c.view = 'downed')]) {
      const k = make(w, 63.6);
      set(k.c);
      k.controls.keys.add('forward');
      k.run(2);
      expect(k.c.mode).toBe('walk');
    }
    const { c, controls, run, now } = make(w, 63.6);
    controls.keys.add('forward');
    run(1.2);
    expect(c.mode).toBe('wall');
    controls.keys.clear();
    expect(c.tryJump(now())).toBe(false);
    // facing the wall: Space is a lunge up, ~2 m
    const y = c.feetY;
    c.wallJump(now());
    run(0.4);
    expect(c.mode).toBe('wall');
    expect(c.feetY - y).toBeGreaterThan(1.7);
    // looking away: a jump off
    c.yaw = -Math.PI / 2;
    c.wallJump(now());
    expect(c.mode).toBe('air');
  });
});
