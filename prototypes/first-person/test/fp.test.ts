// First-person rules (spec §12 tests, F35): ground, poses and epochs, swings and aim zones, releases, block, dodge,
// fight thresholds, separation, village tiles, an FP bot capture loop, determinism with inputs, the monster loop.
import { describe, it, expect } from 'vitest';
import { Island } from '../src/sim/island';
import { cs, champSpeedMul, releaseOnChampion, type ChampInput } from '../src/sim/champion';
import { offerDragged } from '../src/sim/favor';
import { resolveAway } from '../src/sim/offline';
import { reachabilityProblem } from '../src/sim/reachability';
import { serializeCore } from '../src/sim/serialize';
import { findPath } from '../src/sim/pathfind';
import { NV, RES } from '../src/sim/ground';
import { axisDist, bodyR, frontPoint, reachT } from '../src/sim/body';
import { telegraphRadius } from '../src/sim/monster-ai';
import { zoneFor, rayBox, hitBox } from '../src/sim/aim';
import { SIZE } from '../src/sim/world';
import { HOUR_MS } from '../src/sim/clock';
import type { Entity } from '../src/sim/types';
import { now, START } from './helpers';
import { kill, legFactor } from '../src/sim/combat';
import { crown } from '../src/sim/champion';
import { ChampionController, EYE_H } from '../src/input/controller';
import type { Controls } from '../src/input/controls';

const make = (seed = 1, ts = 1) => Island.create(seed, START, ts);
const M = 8;

function feed(island: Island, i: ChampInput) {
  island.sim.inputs.push(i);
}

/** Place the champion by hand (as a dev scenario does) and adopt the new epoch. */
function place(island: Island, x: number, z: number) {
  const sim = island.sim;
  const c = sim.champion()!;
  const p = sim.nearestWalkable(c, x, z, 4)!;
  c.x = p.x + 0.5;
  c.z = p.z + 0.5;
  cs(sim).epoch++;
  cs(sim).trail = [];
}

/** A first-person bot: walk toward a point along an A* path by sending poses, as the client controller would. */
function walkTo(island: Island, tx: number, tz: number, arrive: number, maxTicks: number, each?: () => void): boolean {
  const sim = island.sim;
  let pts: { x: number; z: number }[] = [];
  let k = 0;
  const plan = () => {
    const c = sim.champion()!;
    const raw = findPath(sim.grid, sim.costsFor('human'), Math.floor(c.x), Math.floor(c.z), Math.floor(tx), Math.floor(tz), 20000) ?? [];
    pts = raw.map((i) => ({ x: (i % SIZE) + 0.5, z: Math.floor(i / SIZE) + 0.5 }));
    pts.push({ x: tx, z: tz });
    k = 0;
  };
  plan();
  for (let t = 0; t < maxTicks; t++) {
    const c = sim.champion()!;
    if (Math.hypot(c.x - tx, c.z - tz) < arrive) return true;
    let wp = pts[k];
    while (wp && Math.hypot(wp.x - c.x, wp.z - c.z) < 0.08 && k < pts.length - 1) wp = pts[++k];
    if (!wp) plan();
    const step = (8.8 / M / 10) * champSpeedMul(sim) * terrain(island, c.x, c.z) * 0.95;
    const dx = wp.x - c.x, dz = wp.z - c.z, d = Math.hypot(dx, dz) || 1;
    const s = Math.min(step, d);
    feed(island, { type: 'pose', x: c.x + (dx / d) * s, z: c.z + (dz / d) * s, yaw: Math.atan2(dx, dz), pitch: 0, epoch: cs(sim).epoch, input: true });
    island.step();
    each?.();
  }
  return false;
}

function terrain(island: Island, x: number, z: number) {
  const sim = island.sim;
  const c = sim.costsFor('human').get(sim.grid.get(Math.floor(x), Math.floor(z))) ?? 1;
  return 1 / Math.min(3, Math.max(0.6, c));
}

describe('ground', () => {
  it('matches the mesh vertices exactly and is continuous across tile borders', () => {
    const sim = make(3).sim;
    const g = sim.ground;
    for (let k = 0; k < 400; k++) {
      const i = 20 + ((k * 37) % 200), j = 20 + ((k * 53) % 200);
      expect(Math.abs(g.y(i / RES, j / RES) - g.v[j * NV + i])).toBeLessThan(1e-4);
    }
    let worst = 0;
    for (let x = 20; x < 108; x++) for (const z of [30.5, 64.5, 90.5]) worst = Math.max(worst, Math.abs(g.y(x - 1e-4, z) - g.y(x + 1e-4, z)));
    expect(worst).toBeLessThan(0.01);
  });
});

describe('village tiles', () => {
  it('stamps houses and gates; every door and both gateways reach the altar', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const sim = make(seed).sim;
      const L = sim.layout;
      expect(L.houses.length).toBeGreaterThan(5);
      for (const h of L.houses) expect(sim.grid.get(h.x, h.z)).toBe('house');
      for (const g of L.gates) expect(sim.grid.get(g.x, g.z)).toBe('gate');
      expect(reachabilityProblem(sim)).toBeNull();
      const costs = sim.costsFor('human');
      for (const d of L.doors) {
        expect(sim.walkableFor('human', d.x, d.z)).toBe(true);
        expect(findPath(sim.grid, costs, d.x, d.z, L.villageAltar.x, L.villageAltar.z, 20000)).not.toBeNull();
      }
      for (const g of L.gates) expect(findPath(sim.grid, costs, g.x, g.z, L.villageAltar.x, L.villageAltar.z, 20000)).not.toBeNull();
    }
  });
});

describe('poses and epochs', () => {
  it('accepts legal moves, rejects walls, teleports and stale epochs', () => {
    const island = make(2);
    const sim = island.sim;
    const c = sim.champion()!;
    const S = cs(sim);
    island.step();
    const x0 = c.x, z0 = c.z;
    feed(island, { type: 'pose', x: x0 + 0.05, z: z0, yaw: 1, pitch: 0, epoch: S.epoch, input: true });
    island.step();
    expect(c.x).toBeCloseTo(x0 + 0.05, 5);
    expect(c.yaw).toBe(1);
    // a teleport is refused with a correction and a new epoch
    const e0 = S.epoch;
    feed(island, { type: 'pose', x: c.x + 5, z: c.z, yaw: 0, pitch: 0, epoch: S.epoch, input: true });
    island.step();
    expect(c.x).toBeCloseTo(x0 + 0.05, 5);
    expect(S.epoch).toBe(e0 + 1);
    // the in-flight pose of the old epoch is ignored
    feed(island, { type: 'pose', x: c.x + 0.02, z: c.z, yaw: 0, pitch: 0, epoch: e0, input: true });
    island.step();
    expect(c.x).toBeCloseTo(x0 + 0.05, 5);
    // walking into a wall tile is refused
    const L = sim.layout;
    let wall: { x: number; z: number } | null = null;
    for (let z = L.village.z - 12; z < L.village.z + 12 && !wall; z++) for (let x = L.village.x - 12; x < L.village.x + 12; x++) if (sim.grid.get(x, z) === 'wall' && sim.walkableFor('human', x + 1, z)) { wall = { x, z }; break; }
    expect(wall).not.toBeNull();
    c.x = wall!.x + 1.05;
    c.z = wall!.z + 0.5;
    S.epoch++;
    const e1 = S.epoch;
    feed(island, { type: 'pose', x: wall!.x + 0.9, z: wall!.z + 0.5, yaw: 0, pitch: 0, epoch: e1, input: true });
    island.step();
    expect(c.x).toBeCloseTo(wall!.x + 1.05, 5);
    expect(S.epoch).toBe(e1 + 1);
  });

  it('a long absence bumps the epoch, so a stale pose cannot drag the champion back (F6)', () => {
    const island = make(2);
    const sim = island.sim;
    const c = sim.champion()!;
    place(island, sim.layout.lairs[3].x + 3, sim.layout.lairs[3].z);
    const before = cs(sim).epoch;
    const away = { x: c.x, z: c.z };
    resolveAway(sim, 2 * HOUR_MS, 2 * HOUR_MS);
    expect(cs(sim).epoch).toBe(before + 1);
    const home = { x: c.x, z: c.z };
    expect(Math.hypot(home.x - away.x, home.z - away.z)).toBeGreaterThan(5);
    feed(island, { type: 'pose', x: away.x, z: away.z, yaw: 0, pitch: 0, epoch: before, input: true });
    island.step();
    expect(Math.hypot(c.x - home.x, c.z - home.z)).toBeLessThan(0.5);
  });
});

describe('dev: crown now', () => {
  it('a fallen champion is replaced immediately, with a new epoch, instead of at dawn', () => {
    const island = make(2);
    const sim = island.sim;
    const old = sim.champion()!;
    kill(sim, old, { amount: old.hp, type: 'dev', sourceId: -1, sourceKind: 'none' });
    expect(sim.championPendingDawn).toBe(true);
    expect(sim.champion()).toBeFalsy();
    const epoch = cs(sim).epoch;
    crown(sim);
    const c = sim.champion()!;
    expect(c).toBeTruthy();
    expect(c.id).not.toBe(old.id);
    expect(sim.championPendingDawn).toBe(false);
    expect(cs(sim).epoch).toBeGreaterThan(epoch);
    for (let i = 0; i < 10; i++) island.step();
    expect(sim.champion()!.id).toBe(c.id);
  });
});

describe('jump', () => {
  it('a hop clears ~0.85 m, keeps momentum, lands, and costs stamina; no jumping while dragging or mid-air', () => {
    const island = make(1);
    const ground = island.sim.ground;
    const held = new Set<string>(['forward']);
    const controls = { down: (a: string) => held.has(a), readLook: () => [0, 0] } as unknown as Controls;
    const sent: unknown[] = [];
    const c = new ChampionController(controls, ground, (m) => sent.push(m));
    c.walk.fill(20);
    c.ctrl = 'player';
    const v = island.sim.layout.village;
    c.snap(v.x + 0.5, v.z + 0.5);
    let t = 0;
    const step = (n: number) => { for (let i = 0; i < n; i++) { t += 1 / 60; c.update(1 / 60, t); } };
    step(60); // reach walking speed
    const speed = Math.hypot(c.vx, c.vz);
    let landed = 0;
    c.onLand = () => landed++;
    expect(c.tryJump(t)).toBe(true);
    expect(c.stamina).toBeLessThan(100);
    expect(c.tryJump(t)).toBe(false); // no double jump
    expect(c.tryDodge(t)).toBe(false); // no dodge in the air
    let peak = 0;
    held.clear(); // let go of W: momentum carries on
    for (let i = 0; i < 120 && c.air; i++) {
      step(1);
      peak = Math.max(peak, c.feetY - ground.y(c.x, c.z));
    }
    expect(landed).toBe(1);
    expect(peak).toBeGreaterThan(0.7);
    expect(peak).toBeLessThan(1.1);
    expect(Math.hypot(c.vx, c.vz)).toBeGreaterThan(speed * 0.95);
    step(30);
    expect(c.eyeY).toBeCloseTo(ground.y(c.x, c.z) + EYE_H, 1);
    c.dragging = true;
    expect(c.tryJump(t + 5)).toBe(false);
  });
});

describe('stamina', () => {
  function champ() {
    const island = make(1);
    const held = new Set<string>();
    const controls = { down: (a: string) => held.has(a), readLook: () => [0, 0] } as unknown as Controls;
    const c = new ChampionController(controls, island.sim.ground, () => {});
    c.walk.fill(20);
    c.ctrl = 'player';
    const v = island.sim.layout.village;
    c.snap(v.x + 0.5, v.z + 0.5);
    // the controller stamps spending with performance.now (the frame clock in the game)
    let t = performance.now() / 1000;
    const step = (sec: number) => { for (let i = 0; i < Math.round(sec * 60); i++) { t += 1 / 60; c.update(1 / 60, t); } };
    return { c, held, step, now: () => t };
  }

  it('attacks are free: swinging all fight long costs none, and stamina comes back meanwhile', () => {
    const { c, step, now } = champ();
    c.stamina = 40;
    for (let i = 0; i < 10; i++) {
      expect(c.trySwing(now())).toBe(true);
      step(0.62);
    }
    // swinging didn't hold regeneration off: 6 s of it, from 0.5 s on, at 30/s
    expect(c.stamina).toBe(100);
  });

  it('a last breath: with any stamina left a dodge or a jump goes through, and leaves you winded at 0', () => {
    const { c, step, now } = champ();
    c.stamina = 5;
    expect(c.tryDodge(now())).toBe(true);
    expect(c.stamina).toBe(0);
    expect(c.winded).toBe(true);
    // at 0, nothing to give: not until it starts coming back, half a second on
    step(0.3);
    expect(c.tryJump(now())).toBe(false);
    step(0.3);
    expect(c.stamina).toBeGreaterThan(0);
    expect(c.tryJump(now())).toBe(true);
  });

  it('winded you can still swing, dodge and jump, but not sprint or raise the shield, until stamina is back to 25', () => {
    const { c, held, step, now } = champ();
    c.stamina = 1;
    c.tryDodge(now());
    step(0.7);
    expect(c.winded).toBe(true);
    expect(c.trySwing(now())).toBe(true);
    c.setBlocking(true);
    expect(c.blocking).toBe(false);
    held.add('forward');
    held.add('sprint');
    step(0.1);
    expect(c.sprinting).toBe(false);
    expect(c.tryDodge(now())).toBe(true);
    // 25 again: winded no more
    held.clear();
    step(1.5);
    expect(c.winded).toBe(false);
    c.setBlocking(true);
    expect(c.blocking).toBe(true);
  });

  it('costs: a dodge 20, a jump 8, sprinting 10/s; nothing comes back for half a second after, then 30/s', () => {
    const { c, held, step, now } = champ();
    c.tryDodge(now());
    expect(c.stamina).toBe(80);
    step(0.6);
    c.tryJump(now());
    expect(c.stamina).toBeCloseTo(80 + 30 * 0.1 - 8, 0);
    const s0 = c.stamina;
    step(0.45);
    expect(c.stamina).toBe(s0);
    step(0.5);
    expect(c.stamina).toBeCloseTo(s0 + 30 * 0.45, 0);
    c.stamina = 100;
    held.add('forward');
    held.add('sprint');
    step(2);
    expect(c.stamina).toBeCloseTo(80, 0);
  });
});

describe('aim zones', () => {
  it('maps aim points to zones by body plan', () => {
    expect(zoneFor('lilit', 0.9, 0, 0)).toBe('head');
    expect(zoneFor('lilit', 0.3, -0.4, 0)).toBe('legL');
    expect(zoneFor('lilit', 0.3, 0.4, 0)).toBe('legR');
    expect(zoneFor('lilit', 0.7, -0.8, 0)).toBe('armL');
    expect(zoneFor('lilit', 0.55, -0.8, 0)).toBe('sig'); // talons, low on the arms
    expect(zoneFor('lilit', 0.6, 0.1, 0)).toBe('torso');
    expect(zoneFor('nephil', 0.6, 0.8, 0)).toBe('sig'); // the club arm
    expect(zoneFor('nephil', 0.6, -0.8, 0)).toBe('armL');
    expect(zoneFor('seir', 0.95, 0, 0)).toBe('sig'); // horns
    expect(zoneFor('reem', 0.6, 0, 0.9)).toBe('sig');
    expect(zoneFor('reem', 0.3, 0, 0.6)).toBe('head');
    expect(zoneFor('reem', 0.2, -0.5, 0.3)).toBe('armL');
    expect(zoneFor('reem', 0.2, 0.5, -0.3)).toBe('legR');
    expect(zoneFor('rahab', 0.5, 0, 0.7)).toBe('sig'); // jaws
    expect(zoneFor('saraph', 0.7, 0.8, 0)).toBe('sig'); // wings
    expect(zoneFor('tannin', 0.3, -0.2, -0.8)).toBe('legL'); // tail
    expect(zoneFor('tannin', 0.7, 0, 0)).toBe('sig'); // coils
  });

  it('a look ray entering the front of a quadruped hits its head end (F2)', () => {
    const box = hitBox('reem', 1.7);
    // reem at the origin facing −z (toward a viewer at z = −6)
    const hit = rayBox(0, 1.0, -6, 0, 0, 1, 0, 0, 0, Math.PI, box);
    expect(hit).not.toBeNull();
    expect(hit!.f).toBeCloseTo(1, 3);
    expect(zoneFor('reem', hit!.h, hit!.s, hit!.f)).not.toBe('torso');
    expect(rayBox(0, 1.0, -6, 0, 0, -1, 0, 0, 0, Math.PI, box)).toBeNull();
  });
});

describe('melee', () => {
  function duel(seed = 4) {
    const island = make(seed);
    const sim = island.sim;
    sim.invincible = true;
    const c = sim.champion()!;
    const m = sim.monsters().find((x) => x.monster!.region !== 6 && !x.monster!.flies)!;
    place(island, m.x + 0.5, m.z);
    m.state = 'prowl';
    island.step();
    return { island, sim, c, m };
  }

  it('a swing hits the target the client picked, in the aimed zone; downed and bound targets are skipped', () => {
    const { island, sim, c, m } = duel();
    m.x = c.x;
    m.z = c.z + (2.0 / M + bodyR(m));
    const hp0 = m.hp;
    feed(island, { type: 'swing', yaw: 0, pitch: 0, targetId: m.id, zone: 'legL' });
    island.step();
    expect(m.hp).toBeLessThan(hp0);
    expect(m.zones!.legL!.hp).toBeLessThan(m.zones!.legL!.max);
    // out of the arc (behind the champion): a whiff
    cs(sim).swingReady = 0;
    const hp1 = m.hp;
    feed(island, { type: 'swing', yaw: Math.PI, pitch: 0, targetId: m.id, zone: 'head' });
    island.step();
    expect(m.hp).toBe(hp1);
    // downed: swings pass over it
    m.state = 'downed';
    m.monster!.downedAt = sim.tick;
    cs(sim).swingReady = 0;
    feed(island, { type: 'swing', yaw: 0, pitch: 0, targetId: m.id, zone: 'torso' });
    island.step();
    expect(m.hp).toBe(hp1);
  });

  it('a release misses when you are behind it or dodging, and the shield takes 75 %', () => {
    const { island, sim, c, m } = duel();
    const hitR = telegraphRadius(m) + bodyR(c);
    // monster facing the champion, champion in reach
    m.x = c.x;
    m.z = c.z - reachT(m) * 0.7;
    m.yaw = 0;
    cs(sim).poses = [];
    expect(releaseOnChampion(sim, m, c, hitR)).toBe('hit');
    m.yaw = Math.PI; // facing away
    expect(releaseOnChampion(sim, m, c, hitR)).toBe('miss');
    m.yaw = 0;
    feed(island, { type: 'dodge' });
    island.step();
    m.x = c.x;
    m.z = c.z - reachT(m) * 0.7;
    m.yaw = 0;
    expect(releaseOnChampion(sim, m, c, hitR)).toBe('iframe');
    for (let i = 0; i < 4; i++) island.step();
    m.x = c.x;
    m.z = c.z - reachT(m) * 0.7;
    m.yaw = 0;
    c.yaw = Math.PI; // facing the monster
    cs(sim).blocking = true;
    cs(sim).poses = [];
    expect(releaseOnChampion(sim, m, c, hitR)).toBe('block');
  });

  it('every archetype stops its chase inside the range where its wind-up starts (F3)', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30 && seen.size < 8; seed++) {
      const sim = make(seed).sim;
      const c = sim.champion()!;
      for (const m of sim.monsters()) {
        const a = m.monster!.archetype;
        if (seen.has(a)) continue;
        seen.add(a);
        const stop = Math.max(bodyR(m) + bodyR(c) + 0.1 / M, reachT(m) * 0.8);
        const windup = telegraphRadius(m) - 0.4 / M;
        expect(stop, a).toBeLessThan(windup);
        // and its reach in meters is sane for first person
        expect(reachT(m) * M, a).toBeGreaterThan(2);
        expect(reachT(m) * M, a).toBeLessThan(6);
      }
    }
    expect(seen.size).toBe(8);
  });

  it('monsters in a fight close in and strike from the front point, without walking through you', () => {
    const { island, sim, c, m } = duel(6);
    m.target = c.id;
    m.state = 'fight';
    m.monster!.seen = true;
    let closest = Infinity, released = 0;
    for (let t = 0; t < 200; t++) {
      feed(island, { type: 'pose', x: c.x, z: c.z, yaw: c.yaw, pitch: 0, epoch: cs(sim).epoch, input: true });
      const w = m.monster!.windup;
      island.step();
      if (w >= 0 && m.monster!.windup < 0) released++;
      if (m.state === 'fight') closest = Math.min(closest, axisDist(m, c.x, c.z) - bodyR(m) - bodyR(c));
    }
    expect(released).toBeGreaterThan(0);
    expect(closest).toBeGreaterThan(-0.05);
    const fp = frontPoint(m);
    expect(Math.hypot(fp.x - c.x, fp.z - c.z)).toBeLessThan(telegraphRadius(m) + bodyR(c));
  });
});

describe('the island keeps its shape', () => {
  it('separation never pushes anyone into walls or water', () => {
    const island = make(5, 30);
    const sim = island.sim;
    for (let t = 0; t < 3000; t++) {
      island.step();
      if (t % 50) continue;
      for (const e of sim.ents.values()) {
        if (!e.inhabitant || e.hidden || e.carriedBy !== undefined || e.id === sim.championId) continue;
        expect(sim.walkableFor(e, e.x, e.z), `${e.name} on ${sim.grid.get(Math.floor(e.x), Math.floor(e.z))}`).toBe(true);
      }
    }
  });

  it('monsters still capture and sacrifice villagers at meter reaches (base test 4)', () => {
    const island = make(1, 144);
    const sim = island.sim;
    const ticks = (2 * 86_400_000) / (100 * 144);
    for (let t = 0; t < ticks && sim.stats.monsterSacrifices === 0; t++) {
      cs(sim).lastInput = sim.tick; // no autopilot: the champion stands at the village
      island.step();
    }
    expect(sim.stats.monsterSacrifices).toBeGreaterThan(0);
  });
});

describe('the FP capture loop', () => {
  it('a bot downs a monster with aimed swings, binds it, drags it home through the gate and burns it', () => {
    const island = make(4);
    const sim = island.sim;
    sim.invincible = true;
    const c = sim.champion()!;
    const m = sim.monsters().find((x) => x.monster!.region !== 6 && !x.monster!.flies)!;
    place(island, m.x + 0.6, m.z);
    let t = 0;
    while (m.state !== 'downed' && t++ < 3000) {
      const gapM = (axisDist(m, c.x, c.z) - bodyR(m)) * M;
      const yaw = Math.atan2(m.x - c.x, m.z - c.z);
      if (gapM > 2.2) {
        const s = 0.05;
        feed(island, { type: 'pose', x: c.x + Math.sin(yaw) * s, z: c.z + Math.cos(yaw) * s, yaw, pitch: 0, epoch: cs(sim).epoch, input: true });
      } else {
        feed(island, { type: 'pose', x: c.x, z: c.z, yaw, pitch: 0, epoch: cs(sim).epoch, input: true });
        if (t % 6 === 0) feed(island, { type: 'swing', yaw, pitch: 0, targetId: m.id, zone: t % 12 ? 'legL' : 'torso' });
      }
      island.step();
    }
    expect(m.state).toBe('downed');
    const maxHp = Math.round(sim.maxHp(m));
    feed(island, { type: 'interact', id: m.id });
    island.step();
    expect(sim.dragging).toBe(m.id);
    expect(m.state).toBe('bound');
    const A = sim.layout.villageAltar;
    let slowest = Infinity, helped = false, maxGap = 0;
    const ok = walkTo(island, A.x + 0.5, A.z + 0.9, 0.12, 30000, () => {
      slowest = Math.min(slowest, champSpeedMul(sim) / legFactor(c));
      helped ||= sim.humans().some((h) => h.state === 'help-drag');
      maxGap = Math.max(maxGap, Math.hypot(m.x - c.x, m.z - c.z));
    });
    expect(ok).toBe(true);
    expect(m.state).toBe('bound');
    expect(sim.dragging).toBe(m.id);
    // the body trails at rope length, never more than a few meters behind (F8)
    expect(maxGap * M).toBeLessThan(8);
    // dragging doesn't slow you (only your legs do), and villagers still pitch in near home (F5)
    expect(slowest).toBeCloseTo(sim.stat(c, 'speed') / 1.1, 6);
    expect(helped).toBe(true);
    const before = sim.favor.human;
    expect(offerDragged(sim)).toBeNull();
    expect(sim.favor.human - before).toBe(maxHp);
    expect(sim.ents.has(m.id)).toBe(false);
  });
});

describe('determinism', () => {
  it('the same seed and the same input stream give the same world', () => {
    const run = () => {
      const island = make(9);
      const sim = island.sim;
      const c = sim.champion()!;
      for (let t = 0; t < 1500; t++) {
        const yaw = (t / 300) * Math.PI;
        if (t % 2 === 0) feed(island, { type: 'pose', x: c.x + Math.sin(yaw) * 0.03, z: c.z + Math.cos(yaw) * 0.03, yaw, pitch: 0, epoch: cs(sim).epoch, input: true });
        if (t % 50 === 0) feed(island, { type: 'swing', yaw, pitch: 0, targetId: null, zone: null });
        if (t % 70 === 0) feed(island, { type: 'dodge' });
        island.step();
      }
      return JSON.stringify(serializeCore(sim));
    };
    expect(run()).toBe(run());
  });
});

void (null as unknown as Entity);
