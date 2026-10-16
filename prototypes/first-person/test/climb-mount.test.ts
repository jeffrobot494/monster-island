// Climbing on monsters (docs/climbing-phase3-plan.md, Part E, tests 31–36): the nephil's climb volumes on both rigs,
// a rider following and moving over a procedural nephil, the controller's mount mode, the rules for getting on, and
// the sim's side.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Ground, M, NV } from '../src/sim/ground';
import { SIZE, TileGrid } from '../src/sim/world';
import { ChampionController, type MountBody } from '../src/input/controller';
import { buildRig, ANIM } from '../src/render/rigs';
import { MODELS } from '../src/render/glb-rig';
import { bodyCaps, capDist, Mounts, Rider } from '../src/render/climb-rig';
import type { Entities, View } from '../src/render/entities';
import { CLIMB } from '../src/sim/climb-body';
import { SHAPE_M } from '../src/sim/body';
import { F_CORE_SHAPE, F_DOWNED, F_MONSTER } from '../src/protocol';
import { Island } from '../src/sim/island';
import { cs, groundChampion, type ChampInput } from '../src/sim/champion';
import { DEFAULT_SETTINGS } from '../src/sim/terrain-import';
import type { Controls, ActionName } from '../src/input/controls';
import { now, START } from './helpers';

const FOOT = 2;
const SCALE = 2.2; // the nephil's base scale
const NX = 64.5, NZ = 64.5; // tiles

/** flat terraformer-style ground at FOOT */
function flat() {
  const grid = new TileGrid();
  grid.types.fill('grass');
  grid.base = new Float32Array(NV * NV).fill(FOOT);
  grid.orig = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) grid.orig[i] = grid.height(i % SIZE, Math.floor(i / SIZE));
  const ground = new Ground(grid);
  const walk = new Uint8Array(SIZE * SIZE).fill(20);
  return { grid, ground, walk };
}

/** a procedural nephil view standing at (NX, NZ) on the ground, facing +z */
function nephil(id = 1, flags = F_MONSTER | F_CORE_SHAPE): View {
  const rig = buildRig('nephil', '#b08a6a', 0);
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  root.add(rig.root);
  rig.root.scale.setScalar(SHAPE_M * SCALE);
  root.position.set(NX * M, FOOT, NZ * M);
  rig.update(0, 0, ANIM.idle, 0, 0, 0, 0);
  return { id, root, rig, shape: 'nephil', flags, scale: SCALE, mask: 0, yaw: 0, pos: root.position.clone(), struckAt: -1e9 } as unknown as View;
}

const entsOf = (...vs: View[]) => ({ views: new Map(vs.map((v) => [v.id, v])) }) as unknown as Entities;

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

function make(x: number, z: number, yaw: number, alt = 0) {
  const w = flat();
  const controls = new FakeControls();
  const c = new ChampionController(controls as unknown as Controls, w.ground, () => {});
  c.walk = w.walk;
  c.grid = w.grid;
  c.ctrl = 'player';
  c.reason = 'player';
  c.snap(x, z, alt);
  c.yaw = yaw;
  const falls: number[] = [];
  c.onFall = (i) => falls.push(i);
  let t = 1000;
  const run = (secs: number, each?: () => boolean | void, dt = 1 / 60) => {
    for (let k = 0; k < Math.round(secs / dt); k++) {
      t += dt;
      c.update(dt, t);
      if (each?.()) return;
    }
  };
  return { c, controls, falls, run, t: () => t };
}

/** the anchor's depth inside any capsule (m, positive = sunk in) */
function sunk(caps: NonNullable<ReturnType<typeof bodyCaps>>, p: THREE.Vector3) {
  let d = 0;
  for (const k of caps) d = Math.max(d, -capDist(k, p));
  return d;
}

describe('climb volumes', () => {
  it('31: every nephil capsule has its points on the procedural rig and on the model', () => {
    const rig = buildRig('nephil', '#b08a6a', 0);
    const glb = readFileSync(new URL('../src/render/models/nephil.glb', import.meta.url));
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString()) as { nodes: { name: string }[] };
    const bones = new Set(json.nodes.map((n) => n.name));
    const pts = MODELS.nephil.points;
    for (const cap of CLIMB.nephil!) {
      for (const p of [cap.a, cap.b]) {
        expect(rig.points[p], p).toBeDefined();
        expect(pts[p], p).toBeDefined();
        expect(bones.has(pts[p]!), pts[p]).toBe(true);
      }
    }
    expect(CLIMB.nephil!.length).toBe(11);
  });
});

describe('riding a body', () => {
  it('32: the anchor stays on its spot while the body walks, turns and rolls onto its side', () => {
    const v = nephil();
    const r = new Rider(entsOf(v), v.id);
    let caps = bodyCaps(v)!;
    const shin = caps.find((k) => k.i === 0)!;
    const mid = shin.a.clone().lerp(shin.b, 0.5);
    expect(r.attach(mid.clone().add(new THREE.Vector3(0, 0, shin.r + 0.05)))).toBe(true);
    expect(r.cap).toBe(0);
    const p0 = new THREE.Vector3(...r.place()!.p);
    const local = shin.frame.worldToLocal(p0.clone());
    const check = () => {
      v.root.updateMatrixWorld(true);
      const pl = r.place()!;
      const p = new THREE.Vector3(...pl.p);
      caps = bodyCaps(v)!;
      expect(r.cap).toBe(0);
      expect(p.distanceTo(shin.frame.localToWorld(local.clone()))).toBeLessThan(0.01);
      expect(Math.abs(capDist(caps.find((k) => k.i === 0)!, p))).toBeLessThan(0.001);
    };
    // a walk cycle while it strides across the ground
    for (let k = 0; k < 60; k++) {
      v.rig!.update(1 / 30, k / 30, ANIM.walk, 0.4, 0, 0, 0);
      v.root.position.x += 0.05;
      check();
    }
    // turning 90°
    for (let k = 0; k <= 10; k++) {
      v.root.rotation.y = v.yaw = (k / 10) * (Math.PI / 2);
      check();
    }
    // rolling onto its side (downed)
    v.rig!.pose.rotation.z = Math.PI / 2;
    check();
  });

  it('33: holding W climbs a standing nephil from the shin, up the leg and torso to the shoulders, never sinking in', () => {
    const v = nephil(1, F_MONSTER | F_CORE_SHAPE | F_DOWNED); // downed by flag only, so Space mounts; the rig stands
    const caps0 = bodyCaps(v)!;
    const thigh = caps0.find((k) => k.i === 1)!;
    // in front of the left leg, facing it
    const { c, controls, run } = make(thigh.a.x / M, (thigh.a.z + 1.2) / M, Math.PI);
    const mounts = new Mounts(entsOf(v));
    // reach low, for the shin (the hands are on the torso's lower end, the loincloth, at 1.3 m)
    c.findMount = (x, y, z, maxM, how) => mounts.find(new THREE.Vector3(x, y - 0.9, z), maxM, how);
    expect(c.tryJump(1000)).toBe(true);
    expect(c.mount!.cap).toBe(0);
    expect(c.mode).toBe('mount');
    const shoulders = caps0.find((k) => k.i === 5)!;
    const seen = new Set<number>();
    let top = -Infinity, worst = 0;
    controls.keys.add('forward');
    run(8, () => {
      if (c.mode !== 'mount') return true;
      const p = new THREE.Vector3(...c.mount!.place()!.p);
      seen.add(c.mount!.cap);
      top = Math.max(top, p.y);
      worst = Math.max(worst, sunk(bodyCaps(v)!, p));
      return p.y >= shoulders.a.y + shoulders.r - 0.05;
    });
    console.info(`[test 33] capsules ${[...seen].join(',')}, top ${(top - FOOT).toFixed(2)} m, worst ${(worst * 100).toFixed(1)} cm`);
    expect(c.mode).toBe('mount');
    expect(top).toBeGreaterThanOrEqual(shoulders.a.y + shoulders.r - 0.05);
    expect(seen.has(0) && seen.has(4)).toBe(true); // the shin and the torso
    expect(worst).toBeLessThan(0.02);
  });
});

/** a flat wall facing +x, at x = WX m, from the ground to TOP m above it, where its top faces up */
const WX = 64 * M, TOP = 8;
class FakeBody implements MountBody {
  readonly id = 9;
  readonly cap = 0;
  p: [number, number, number];
  gone = false;
  constructor(y: number) {
    this.p = [WX, FOOT + y, 64.5 * M];
  }
  place() {
    if (this.gone) return null;
    const n: [number, number, number] = this.p[1] >= FOOT + TOP ? [0, 1, 0] : [1, 0, 0];
    return { p: [...this.p] as [number, number, number], n };
  }
  move(_dx: number, dy: number, dz: number) {
    this.p[1] = Math.min(FOOT + TOP, Math.max(FOOT, this.p[1] + dy));
    this.p[2] += dz;
  }
  yaw() {
    return 0;
  }
  tilt(): [number, number] {
    return [0, 0];
  }
}

describe('the controller on a body', () => {
  const at = (y: number) => {
    const w = make((WX + 0.8) / M, 64.5, -Math.PI / 2);
    const b = new FakeBody(y);
    w.c.findMount = (_x, _y, _z, _m, how) => (how === 'ground' ? b : null);
    expect(w.c.tryJump(w.t())).toBe(true);
    expect(w.c.mode).toBe('mount');
    return { ...w, b };
  };

  it('34: drain, perching, running out, letting go and falls, and climbing down', () => {
    // moving drains 6/s, and the anchor moves at 1.8 m/s
    let w = at(1.5);
    const y0 = w.b.p[1], s0 = w.c.stamina;
    w.controls.keys.add('forward');
    w.run(1);
    expect(w.b.p[1] - y0).toBeCloseTo(1.8, 1);
    expect(s0 - w.c.stamina).toBeCloseTo(6, 0);
    // holding still drains 3/s
    w.controls.keys.clear();
    let s1 = w.c.stamina;
    w.run(1);
    expect(s1 - w.c.stamina).toBeCloseTo(3, 0);
    // on the top: perched, standing on it, and it regenerates
    w.controls.keys.add('forward');
    w.run(4);
    expect(w.c.perched).toBe(true);
    expect(w.c.feetY).toBeCloseTo(FOOT + TOP, 1);
    w.controls.keys.clear();
    w.c.stamina = s1 = 50; // (it comes back quickly: from half, so there is room to see it)
    w.run(2);
    expect(w.c.stamina).toBeGreaterThan(s1);
    expect(w.c.mode).toBe('mount');
    // out of stamina on the face: you fall
    w.b.p[1] = FOOT + TOP - 1;
    w.run(0.1);
    expect(w.c.perched).toBe(false);
    w.c.stamina = 0.5;
    w.run(0.5);
    expect(w.c.mode === 'air' || w.c.mode === 'walk').toBe(true);
    expect(w.c.mount).toBeNull();
    // C from the top: a fall from 8 m hurts
    w = at(TOP);
    w.run(0.1);
    w.c.letGo(w.t());
    expect(w.c.mode).toBe('air');
    w.run(3, () => w.c.mode === 'walk');
    expect(w.c.mode).toBe('walk');
    expect(w.falls.length).toBe(1);
    // climbing down the face puts you on your feet
    w = at(2);
    w.controls.keys.add('back');
    w.run(3, () => w.c.mode !== 'mount');
    expect(w.c.mode).toBe('walk');
    expect(w.falls.length).toBe(0);
    // the body gone (killed, out of view): a fall
    w = at(3);
    w.b.gone = true;
    w.run(0.05);
    expect(w.c.mode).toBe('air');
  });

  it('35: getting on: Space beside a downed one, Space held in its recovery window, or a drop from above', () => {
    const v = nephil();
    const mounts = new Mounts(entsOf(v));
    const thigh = bodyCaps(v)!.find((k) => k.i === 1)!;
    const beside = () => {
      const w = make(thigh.a.x / M, (thigh.a.z + 1.0) / M, Math.PI);
      w.c.findMount = (x, y, z, maxM, how) => mounts.find(new THREE.Vector3(x, y, z), maxM, how);
      return w;
    };
    // standing: Space jumps, and holding it in the air doesn't grab
    let w = beside();
    w.controls.keys.add('jump');
    expect(w.c.tryJump(w.t())).toBe(true);
    expect(w.c.mode).toBe('air');
    w.run(0.6, () => w.c.mode === 'mount');
    expect(w.c.mode).not.toBe('mount');
    // downed: Space climbs on
    v.flags |= F_DOWNED;
    w = beside();
    expect(w.c.tryJump(w.t())).toBe(true);
    expect(w.c.mode).toBe('mount');
    v.flags &= ~F_DOWNED;
    // just after its blow lands: a jump with Space held grabs it
    v.struckAt = performance.now();
    w = beside();
    w.controls.keys.add('jump');
    w.c.tryJump(w.t());
    w.run(0.6, () => w.c.mode === 'mount');
    expect(w.c.mode).toBe('mount');
    v.struckAt = -1e9;
    // falling onto its shoulders from 7 m: a grab, no Space, no fall damage
    const sh = bodyCaps(v)!.find((k) => k.i === 5)!;
    const mid = sh.a.clone().lerp(sh.b, 0.5);
    w = make(mid.x / M, mid.z / M, 0, 7);
    w.c.findMount = (x, y, z, maxM, how) => mounts.find(new THREE.Vector3(x, y, z), maxM, how);
    expect(w.c.mode).toBe('air');
    w.run(2, () => w.c.mode !== 'air');
    expect(w.c.mode).toBe('mount');
    expect(w.falls.length).toBe(0);
    expect(w.c.perched).toBe(true);
  });
});

describe('the sim', () => {
  it('36: mount poses: accepted on a nephil, refused elsewhere; the ridden nephil leaves its rider be', () => {
    const island = Island.create(1, START, 1, DEFAULT_SETTINGS); // seed 1 has a nephil
    const sim = island.sim;
    const c = sim.champion()!;
    const n = sim.monsters().find((m) => m.monster!.archetype === 'nephil')!;
    expect(n).toBeDefined();
    const other = sim.monsters().find((m) => m.monster!.archetype !== 'nephil')!;
    const feed = (i: ChampInput) => sim.inputs.push(i);
    const ride = (m: typeof n, dx: number, alt: number, cap = 4) =>
      feed({ type: 'pose', x: m.x + dx, z: m.z, yaw: 0, pitch: 0, epoch: cs(sim).epoch, input: true, alt, climb: 'mount', mount: { id: m.id, cap } });
    // beside the nephil, out of the way of everything else
    c.x = n.x + 0.2;
    c.z = n.z;
    cs(sim).epoch++;
    n.monster!.ignoreChampUntil = sim.clockMs + 3_600_000;
    ride(n, 0.05, 3);
    island.step();
    expect(c.human!.mount).toEqual({ id: n.id, cap: 4 });
    expect(c.human!.climb).toBe('mount');
    expect(c.human!.alt).toBeCloseTo(3, 5);
    expect(c.x).toBeCloseTo(n.x + 0.05, 5);
    // too far from it, too high above it, or on a monster with no climb volumes: a correction
    for (const bad of [() => ride(n, 2, 3), () => ride(n, 0.05, 40), () => ride(other, 0.05, 1)]) {
      const e = cs(sim).epoch;
      bad();
      island.step();
      expect(cs(sim).epoch).toBe(e + 1);
    }
    // no blows at its rider and no shove, for 60 ticks (on the shin, out of its grab, and holding on through its
    // shakes: phase 4, test/climb-fight.test.ts)
    ride(n, 0.05, 3, 0);
    island.step();
    delete n.monster!.ignoreChampUntil;
    n.state = 'fight';
    n.target = c.id;
    cs(sim).blocking = true;
    const hp = c.hp;
    for (let k = 0; k < 60; k++) {
      ride(n, 0.05, 3, 0);
      const nx = n.x;
      island.step();
      expect(n.monster!.windup).toBe(-1);
      if (n.state === 'fight') expect(Math.abs(n.x - nx)).toBeLessThan(1e-9);
    }
    expect(c.hp).toBe(hp);
    expect(c.human!.mount?.id).toBe(n.id);
    // off the body: hand-over clears it
    groundChampion(sim, c);
    expect(c.human!.mount).toBeUndefined();
    expect(c.human!.climb).toBeUndefined();
    // procedural islands ignore mount poses
    const p = Island.create(1, START, 1);
    const pc = p.sim.champion()!, pn = p.sim.monsters().find((m) => m.monster!.archetype === 'nephil')!;
    const x0 = pc.x;
    p.sim.inputs.push({ type: 'pose', x: pn.x, z: pn.z, yaw: 0, pitch: 0, epoch: cs(p.sim).epoch, input: true, alt: 3, climb: 'mount', mount: { id: pn.id, cap: 4 } });
    p.step();
    expect(pc.x).toBe(x0);
    expect(pc.human!.mount).toBeUndefined();
  }, 60000);
});
