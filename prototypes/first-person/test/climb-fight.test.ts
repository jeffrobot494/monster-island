// Climbing, phase 4 (docs/climbing-phase4-plan.md, Part E): monsters fighting back. Shakes and holding on, the
// nephil's grab, attacks from the body, the controller's side of it, and the flyers.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Ground, M, NV } from '../src/sim/ground';
import { SIZE, TileGrid } from '../src/sim/world';
import { ChampionController, type MountBody } from '../src/input/controller';
import { buildRig, ANIM, ZONE_BIT } from '../src/render/rigs';
import { bodyCaps, Rider } from '../src/render/climb-rig';
import type { Entities, View } from '../src/render/entities';
import { CLIMB, RIDE, SHAKE_TELL } from '../src/sim/climb-body';
import { SHAPE_M, feetY } from '../src/sim/body';
import { F_CORE_SHAPE, F_MONSTER } from '../src/protocol';
import { Island } from '../src/sim/island';
import { cs, type ChampInput } from '../src/sim/champion';
import { armFactor } from '../src/sim/combat';
import { DEFAULT_SETTINGS, islesOf } from '../src/sim/terrain-import';
import type { Entity } from '../src/sim/types';
import type { Controls, ActionName } from '../src/input/controls';
import { now, START } from './helpers';

// ---------- the sim ----------

/** seed 1 on the default terraformer island: it has a nephil, a ziz and a saraph */
function world(arch = 'nephil') {
  const island = Island.create(1, START, 1, { now }, DEFAULT_SETTINGS);
  const sim = island.sim;
  const c = sim.champion()!;
  const m = sim.monsters().find((e) => e.monster!.archetype === arch)!;
  expect(m).toBeDefined();
  // nothing else in the way
  for (const o of sim.monsters()) if (o !== m) o.monster!.ignoreChampUntil = sim.clockMs + 3_600_000;
  m.state = 'fight';
  m.target = c.id;
  m.yaw = 0;
  m.monster!.alt = 0;
  m.monster!.attackReadyAt = 0;
  c.x = m.x;
  c.z = m.z + 0.1; // in front of it (it faces +z)
  cs(sim).epoch++;
  const S = cs(sim);
  /** a mount pose on capsule `cap`, at (dx, dz) tiles from it and `alt` m up */
  const ride = (cap: number, dx = 0, dz = 0.1, alt = 3) => {
    const i: ChampInput = { type: 'pose', x: m.x + dx, z: m.z + dz, yaw: 0, pitch: 0, epoch: S.epoch, input: true, alt, climb: 'mount', mount: { id: m.id, cap } };
    sim.inputs.push(i);
  };
  /** step `n` ticks riding `cap`, collecting combat events */
  const events: { tick: number; kind: string; hard?: boolean; amount?: number }[] = [];
  const step = (n: number, cap: number, dx = 0, dz = 0.1, alt = 3, until?: () => boolean | void) => {
    for (let k = 0; k < n; k++) {
      ride(cap, dx, dz, alt);
      island.step();
      for (const e of S.combat) events.push({ tick: sim.tick, kind: e.kind, hard: e.hard, amount: e.amount });
      S.combat.length = 0;
      if (until?.()) return;
    }
  };
  return { island, sim, c, m, S, ride, step, events };
}

describe('shakes', () => {
  it('37: a ridden nephil shudders, then shakes: held, it costs stamina; not held, you are thrown off', () => {
    const w = world();
    const R = RIDE.nephil!;
    w.S.blocking = true;
    w.step(1, 0);
    expect(w.c.human!.mount?.id).toBe(w.m.id);
    const since = w.m.monster!.ride!.since;
    // the telegraph: F_SHAKE (ride.shakeAt) from SHAKE_TELL ticks before it lands
    const shaking: number[] = [];
    w.step(R.first + R.every + 2, 0, 0, 0.1, 3, () => {
      if (w.m.monster!.ride!.shakeAt >= 0) shaking.push(w.sim.tick);
    });
    const held = w.events.filter((e) => e.kind === 'shake');
    expect(held.map((e) => e.tick)).toEqual([since + R.first, since + R.first + R.every]);
    expect(held[0].amount).toBe(R.cost);
    expect(shaking[0]).toBe(since + R.first - SHAKE_TELL);
    expect(w.events.some((e) => e.kind === 'thrown')).toBe(false);
    expect(w.c.human!.mount?.id).toBe(w.m.id);
    // let go of it: the next shake throws you off, and your late mount poses are ignored, not corrected
    w.S.blocking = false;
    w.step(R.every + 2, 0, 0, 0.1, 3, () => w.events.some((e) => e.kind === 'thrown'));
    const thrown = w.events.find((e) => e.kind === 'thrown')!;
    expect(thrown).toBeDefined();
    expect(thrown.hard).toBe(false);
    expect(w.c.human!.mount).toBeUndefined();
    expect(w.c.human!.alt).toBeCloseTo(3, 5); // in the air now
    const e0 = w.S.epoch;
    w.step(9, 0);
    expect(w.c.human!.mount).toBeUndefined();
    expect(w.S.epoch).toBe(e0);
    // after that, getting back on is allowed
    w.step(3, 0);
    expect(w.c.human!.mount?.id).toBe(w.m.id);
  }, 60000);
});

describe("the nephil's grab", () => {
  it('38: on the shoulders it grabs and hurls you; on its back, or with its free arm gone, it can\'t', () => {
    // the shoulders: a windup, then damage and a hard throw
    let w = world();
    w.S.blocking = true;
    const hp = w.c.hp;
    w.step(1, 5);
    expect(w.m.monster!.grabbing).toBe(true);
    expect(w.m.monster!.windup).toBeGreaterThanOrEqual(0);
    w.step(12, 5, 0, 0.1, 3, () => w.events.some((e) => e.kind === 'thrown'));
    const t = w.events.find((e) => e.kind === 'thrown');
    expect(t?.hard).toBe(true);
    expect(w.c.hp).toBeLessThan(hp);
    expect(w.c.human!.mount).toBeUndefined();
    // the back of the torso: out of its reach
    w = world();
    w.S.blocking = true;
    let reached = false;
    w.step(R().first - SHAKE_TELL, 4, 0, -0.1, 3, () => {
      reached ||= !!w.m.monster!.grabbing;
    });
    expect(reached).toBe(false);
    // the shoulders with its left arm severed
    w = world();
    w.S.blocking = true;
    w.m.zones!.armL!.state = 'severed';
    w.step(R().first - SHAKE_TELL, 5, 0, 0.1, 3, () => {
      reached ||= !!w.m.monster!.grabbing;
    });
    expect(reached).toBe(false);
  }, 60000);
});

const R = () => RIDE.nephil!;

describe('attacks from the body', () => {
  it('39: a blow lands on the capsule you are on, doubled; on the head tripled, with a stagger; with a spear, a thrust', () => {
    const w = world();
    w.S.blocking = true;
    w.m.zones!.armL!.state = 'severed'; // no grab: the head is in its reach
    const base = (c: Entity) => 12 * (1 + 0.1 * (c.level - 1)) * w.sim.stat(c, 'strength') * armFactor(c) * w.S.weapon.mul;
    // a swing lets go of the hold (as on the client: no swinging while holding on), so take hold again after it
    const swing = () => w.sim.inputs.push({ type: 'swing', yaw: 0, pitch: 0, targetId: w.m.id, zone: null }, { type: 'block', on: true });
    // the thigh: legL, ×2
    w.step(1, 1);
    let hp = w.m.hp;
    const leg = w.m.zones!.legL!.hp;
    swing();
    w.step(1, 1);
    expect(hp - w.m.hp).toBeCloseTo(base(w.c) * 2, 5);
    expect(w.m.zones!.legL!.hp).toBeLessThan(leg);
    // the head: ×3, and it staggers (no shakes, no grab) for 2 s
    w.step(7, 10);
    w.m.monster!.ride!.next = w.sim.tick + 10; // a shake due soon
    hp = w.m.hp;
    swing();
    w.step(1, 10);
    expect(hp - w.m.hp).toBeCloseTo(base(w.c) * 3, 5);
    const until = w.m.monster!.staggerUntil!;
    expect(until).toBeGreaterThan(w.sim.tick);
    let shook = false;
    w.step(until - w.sim.tick - 1, 10, 0, 0.1, 3, () => {
      shook ||= w.m.monster!.ride!.shakeAt >= 0 || !!w.m.monster!.grabbing;
    });
    expect(shook).toBe(false);
    expect(w.events.some((e) => e.kind === 'shake' || e.kind === 'thrown')).toBe(false);
    // a spear in hand: a thrust from its back (15, doubled, piercing), and the spear stays in hand
    w.c.human!.spears = 1;
    w.step(10, 4, 0, -0.1);
    hp = w.m.hp;
    expect(w.c.human!.mount?.cap).toBe(4);
    w.sim.inputs.push({ type: 'wield', weapon: 'spear' });
    swing();
    w.step(1, 4, 0, -0.1);
    expect(w.c.human!.spears).toBe(1);
    expect(w.m.zones!.torso!.hp).toBeLessThan(w.m.zones!.torso!.max);
    expect(hp - w.m.hp).toBeCloseTo((base(w.c) / w.S.weapon.mul) * (15 / 12) * 2, 5);
    // right mouse on a body is holding on, not a throw: nothing leaves your hand
    w.step(10, 4, 0, -0.1);
    w.sim.inputs.push({ type: 'throw', yaw: 0, pitch: 0, targetId: w.m.id, zone: null });
    w.step(1, 4, 0, -0.1);
    expect(w.c.human!.spears).toBe(1);
    expect([...w.sim.ents.values()].some((e) => e.kind === 'spear' && e.spear?.st === 'flying')).toBe(false);
  }, 60000);
});

// ---------- the controller ----------

const FOOT = 2;
function flat() {
  const grid = new TileGrid();
  grid.types.fill('grass');
  grid.base = new Float32Array(NV * NV).fill(FOOT);
  grid.orig = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) grid.orig[i] = grid.height(i % SIZE, Math.floor(i / SIZE));
  return { grid, ground: new Ground(grid), walk: new Uint8Array(SIZE * SIZE).fill(20) };
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

/** a flat face facing +x at x = 64 tiles, 3 m up */
class FakeBody implements MountBody {
  readonly id = 9;
  readonly cap = 0;
  p: [number, number, number] = [64 * M, FOOT + 3, 64.5 * M];
  place() {
    return { p: [...this.p] as [number, number, number], n: [1, 0, 0] as [number, number, number] };
  }
  move(_dx: number, dy: number, dz: number) {
    this.p[1] += dy;
    this.p[2] += dz;
  }
  yaw() {
    return 0;
  }
  tilt(): [number, number] {
    return [0, 0];
  }
}

function mounted() {
  const w = flat();
  const controls = new FakeControls();
  const c = new ChampionController(controls as unknown as Controls, w.ground, () => {});
  c.walk = w.walk;
  c.grid = w.grid;
  c.ctrl = 'player';
  c.reason = 'player';
  c.snap(64.1, 64.5, 0);
  c.yaw = -Math.PI / 2;
  const b = new FakeBody();
  c.findMount = (_x, _y, _z, _m, how) => (how === 'ground' ? b : null);
  let t = 1000;
  expect(c.tryJump(t)).toBe(true);
  expect(c.mode).toBe('mount');
  const run = (secs: number, dt = 1 / 60) => {
    for (let k = 0; k < Math.round(secs / dt); k++) {
      t += dt;
      c.update(dt, t);
    }
  };
  return { c, controls, b, run, t: () => t };
}

describe('the controller fighting back', () => {
  it('40: holding on, a shake, being thrown off, swinging from the body, and a severed capsule', () => {
    // holding on: no moving, even with W down
    let w = mounted();
    w.c.setBlocking(true);
    expect(w.c.holding).toBe(true);
    const y0 = w.b.p[1];
    w.controls.keys.add('forward');
    w.run(0.5);
    expect(w.b.p[1]).toBeCloseTo(y0, 6);
    // a held shake costs its stamina
    const s0 = w.c.stamina;
    w.c.shake(15, w.t());
    expect(s0 - w.c.stamina).toBeCloseTo(15, 6);
    // no swinging while holding on; swinging once you let go of it, still on the body
    expect(w.c.trySwing(w.t())).toBe(false);
    w.c.setBlocking(false);
    expect(w.c.trySwing(w.t())).toBe(true);
    expect(w.c.mode).toBe('mount');
    // thrown off: a fall away from the body (it is at -x)
    w = mounted();
    w.run(0.1);
    w.c.throwOff(63, 64.5, false, w.t());
    expect(w.c.mode).toBe('air');
    expect(w.c.mount).toBeNull();
    const x0 = w.c.x;
    w.run(0.2);
    expect(w.c.x).toBeGreaterThan(x0);
    // a shake you can't pay for drops you
    w = mounted();
    w.c.stamina = 10;
    w.c.shake(15, w.t());
    expect(w.c.mode).toBe('air');

    // a severed capsule: the rider has nowhere to be, so the controller lets go
    const rig = buildRig('nephil', '#b08a6a', 0);
    const root = new THREE.Group();
    root.add(rig.root);
    rig.root.scale.setScalar(SHAPE_M * 2.2);
    root.position.set(64.5 * M, FOOT, 64.5 * M);
    rig.update(0, 0, ANIM.idle, 0, 0, 0, 0);
    const v = { id: 1, root, rig, shape: 'nephil', flags: F_MONSTER | F_CORE_SHAPE, scale: 2.2, mask: 0, yaw: 0, pos: root.position.clone(), struckAt: -1e9 } as unknown as View;
    const r = new Rider({ views: new Map([[1, v]]) } as unknown as Entities, 1);
    const thigh = bodyCaps(v)!.find((k) => k.i === 1)!;
    const p = thigh.a.clone().lerp(thigh.b, 0.5).add(new THREE.Vector3(0.5, 0, 0));
    expect(r.attach(p)).toBe(true);
    expect(r.cap).toBe(1);
    expect(r.place()).not.toBeNull();
    v.mask |= 1 << (8 + ZONE_BIT.legL);
    expect(r.place()).toBeNull();
  });
});

// ---------- the flyers ----------

describe('flyers', () => {
  it('41: ziz and saraph volumes; a ridden ziz takes you up over an isle; its wing gone, it crashes and is downed', () => {
    for (const arch of ['ziz', 'saraph']) {
      const rig = buildRig(arch, '#6a5a48', 0);
      for (const d of CLIMB[arch]!) {
        expect(rig.points[d.a], `${arch} ${d.a}`).toBeDefined();
        expect(rig.points[d.b], `${arch} ${d.b}`).toBeDefined();
      }
    }
    const w = world('ziz');
    const isles = islesOf(DEFAULT_SETTINGS);
    expect(isles.length).toBeGreaterThan(0);
    w.S.blocking = true; // holding on through its rolls
    // up on its back, riding it (alt follows its height, as the client's would)
    const zz = w.m;
    const back = (alt = feetY(w.sim.ground, zz) - w.sim.ground.y(zz.x, zz.z) + 1) => alt;
    w.step(1, 0, 0, 0, back());
    const goal = zz.monster!.ride!.goal!;
    expect(goal.land).toBeFalsy();
    const isle = isles.find((i) => Math.hypot(i.x - goal.x, i.z - goal.z) < 0.01)!;
    expect(isle).toBeDefined();
    // it climbs and flies over the isle (at most 60 s)
    for (let k = 0; k < 600; k++) {
      w.step(1, 0, 0, 0, back());
      if (Math.hypot(zz.x - isle.x, zz.z - isle.z) < isle.R * 0.5 && feetY(w.sim.ground, zz) > isle.top) break;
    }
    expect(Math.hypot(zz.x - isle.x, zz.z - isle.z)).toBeLessThan(isle.R * 0.5);
    expect(feetY(w.sim.ground, zz)).toBeGreaterThan(isle.top);
    expect(w.c.human!.mount?.id).toBe(zz.id);
    // let go over it, and standing on the isle's top (right under where you were) is a pose the sim accepts
    const e0 = w.S.epoch;
    const onTop = isle.top - w.sim.ground.y(w.c.x, w.c.z);
    w.sim.inputs.push({ type: 'pose', x: w.c.x, z: w.c.z, yaw: 0, pitch: 0, epoch: e0, input: true, alt: onTop });
    w.island.step();
    expect(w.S.epoch).toBe(e0);
    expect(w.c.human!.alt).toBeCloseTo(onTop, 3);
    expect(w.c.human!.mount).toBeUndefined();
    // a hard landing up there hurts, and leaves the champion up there (it used to clear the height, so the next
    // pose was an impossible climb and the correction dropped them to the ground)
    const hp = w.c.hp;
    w.sim.inputs.push({ type: 'land', impact: 16 }, { type: 'pose', x: w.c.x, z: w.c.z, yaw: 0, pitch: 0, epoch: e0, input: true, alt: onTop });
    w.island.step();
    expect(w.c.hp).toBeLessThan(hp);
    expect(w.S.epoch).toBe(e0);
    expect(w.c.human!.alt).toBeCloseTo(onTop, 3);

    // a fresh one: ridden off the ground, then its wing severed aloft — it comes down and is downed
    const v = world('ziz');
    v.S.blocking = true;
    const z2 = v.m;
    for (let k = 0; k < 60; k++) v.step(1, 0, 0, 0, feetY(v.sim.ground, z2) - v.sim.ground.y(z2.x, z2.z) + 1);
    const high = z2.monster!.alt!;
    expect(high).toBeGreaterThan(20);
    z2.zones!.sig!.state = 'severed';
    let ticks = 0;
    for (; ticks < 400 && z2.state !== 'downed'; ticks++) v.step(1, 0, 0, 0, feetY(v.sim.ground, z2) - v.sim.ground.y(z2.x, z2.z) + 1);
    expect(z2.state).toBe('downed');
    expect(z2.monster!.alt ?? 0).toBe(0);
    // 1 m a tick, not a stone's 3
    expect(ticks).toBeGreaterThan(high * 0.9);
  }, 120000);
});
