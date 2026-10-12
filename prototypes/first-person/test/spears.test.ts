// Spears as real items, flyers that soar and spot from far, and the nightly raid.
import { describe, it, expect } from 'vitest';
import { Island } from '../src/sim/island';
import { cs, crown } from '../src/sim/champion';
import { CRUISE_M, startRaid, raidHour, RAID_CHANCE } from '../src/sim/monster-ai';
import { houseBreached } from '../src/sim/village';
import { RACK_SPEARS, spearsOf } from '../src/sim/spears';
import { serializeCore, deserializeCore } from '../src/sim/serialize';
import { generateMonsters } from '../src/sim/monsters-gen';
import type { Entity } from '../src/sim/types';
import { now, START } from './helpers';
import { armFactor, kill } from '../src/sim/combat';
import { bodyR } from '../src/sim/body';

const make = (seed = 1) => Island.create(seed, START, 1, { now });
const spears = (sim: Island['sim']) => [...sim.ents.values()].filter((e) => e.kind === 'spear');
const carried = (sim: Island['sim']) => sim.humans().reduce((n, h) => n + spearsOf(h), 0);

function place(sim: Island['sim'], e: Entity, x: number, z: number) {
  const p = sim.nearestWalkable(e, x, z, 6)!;
  e.x = p.x + 0.5;
  e.z = p.z + 0.5;
  sim.stop(e);
  if (e.id === sim.championId) cs(sim).epoch++;
}

describe('spears', () => {
  it('the village starts with a rack of spears; the champion and every guard carry one', () => {
    const sim = make(1).sim;
    expect(spears(sim).filter((s) => s.spear!.st === 'rack').length).toBe(RACK_SPEARS);
    expect(spearsOf(sim.champion()!)).toBe(1);
    for (const g of sim.humans().filter((h) => h.human!.job === 'guard')) expect(spearsOf(g)).toBe(1);
  });

  it('a thrown spear flies, strikes the monster it was aimed at, and lies where it fell; the count is conserved', () => {
    const island = make(2);
    const sim = island.sim;
    const c = sim.champion()!;
    const m = sim.monsters().find((x) => !x.monster!.flies)!;
    const total = spears(sim).length + carried(sim);
    // stand 20 m from a resting monster in the open
    place(sim, c, m.monster!.lairX + 6, m.monster!.lairZ);
    place(sim, m, c.x + 2.5, c.z);
    m.state = 'prowl';
    const hp = m.hp;
    const yaw = Math.atan2(m.x - c.x, m.z - c.z);
    sim.inputs.push({ type: 'throw', yaw, pitch: 0, targetId: m.id, zone: 'torso' });
    sim.step();
    expect(spearsOf(c)).toBe(0);
    const flying = spears(sim).find((s) => s.spear!.st === 'flying');
    expect(flying).toBeTruthy();
    for (let i = 0; i < 30 && flying!.spear!.st === 'flying'; i++) sim.step();
    expect(m.hp).toBeLessThan(hp);
    expect(flying!.spear!.st).toBe('ground');
    expect(Math.hypot(flying!.x - m.x, flying!.z - m.z)).toBeLessThan(1);
    expect(spears(sim).length + carried(sim)).toBe(total);
  });

  it('no spear, no throw: nothing comes out of thin air', () => {
    const sim = make(3).sim;
    const c = sim.champion()!;
    c.human!.spears = 0;
    const n = spears(sim).length;
    sim.inputs.push({ type: 'throw', yaw: 0, pitch: 0.2, targetId: null, zone: null });
    sim.step();
    expect(spears(sim).length).toBe(n);
    expect(sim.actionError).toMatch(/No spears/);
  });

  it('a spear thrown into the open lands, and walking over it picks it back up (up to three)', () => {
    const sim = make(4).sim;
    const c = sim.champion()!;
    const V = sim.layout.village;
    place(sim, c, V.x, V.z + 3);
    sim.inputs.push({ type: 'throw', yaw: 0, pitch: 0.15, targetId: null, zone: null });
    sim.step();
    const s = spears(sim).find((x) => x.spear!.st === 'flying')!;
    for (let i = 0; i < 40 && s.spear!.st === 'flying'; i++) sim.step();
    expect(s.spear!.st).toBe('ground');
    expect(spearsOf(c)).toBe(0);
    // walk to it
    c.x = s.x;
    c.z = s.z;
    sim.step();
    sim.step();
    expect(sim.ents.has(s.id)).toBe(false);
    expect(spearsOf(c)).toBe(1);
  });

  it('the champion takes spears from the rack with E, but carries no more than three', () => {
    const sim = make(5).sim;
    const c = sim.champion()!;
    const rack = spears(sim).filter((s) => s.spear!.st === 'rack');
    place(sim, c, rack[0].x, rack[0].z);
    c.x = rack[0].x;
    c.z = rack[0].z + 0.1;
    for (const s of rack.slice(0, 3)) {
      sim.inputs.push({ type: 'interact', id: s.id });
      sim.step();
    }
    expect(spearsOf(c)).toBe(3);
    expect(sim.actionError).toMatch(/cannot carry more/);
  });

  it('a guard throws his spear at a monster near the walls, then goes to fetch one', () => {
    const sim = make(6).sim;
    const V = sim.layout.village;
    const g = sim.humans().find((h) => h.human!.job === 'guard')!;
    const m = sim.monsters().find((x) => !x.monster!.flies)!;
    place(sim, g, V.x + sim.layout.wallRadius - 1, V.z);
    place(sim, m, g.x + 4, g.z);
    m.state = 'prowl';
    let thrown = false;
    for (let i = 0; i < 40 && !thrown; i++) {
      sim.step();
      thrown = spearsOf(g) === 0;
    }
    expect(thrown).toBe(true);
    // the monster leaves; the guard re-arms
    sim.remove(m);
    for (let i = 0; i < 1500 && spearsOf(g) === 0; i++) sim.step();
    expect(spearsOf(g)).toBe(1);
  });

  it('a guard who dies drops his spear on the ground', () => {
    const sim = make(7).sim;
    const g = sim.humans().find((h) => h.human!.job === 'guard')!;
    const n = spears(sim).length;
    kill(sim, g, { amount: 99, type: 'slash', sourceId: -1, sourceKind: 'none' });
    expect(spears(sim).length).toBe(n + 1);
  });

  it('spears survive a save and load', () => {
    const sim = make(8).sim;
    const restored = deserializeCore(JSON.parse(JSON.stringify(serializeCore(sim))));
    expect(spears(restored).length).toBe(spears(sim).length);
    expect(spearsOf(restored.champion()!)).toBe(1);
  });
});

describe('the spear in hand', () => {
  const M = 8;
  /** The champion beside a monster in the open, nothing in the way, and the monster put at bearing b (rad), d m from
   *  its body, side-on (so the nearest point of its body is its middle). */
  function duel(seed = 4) {
    const island = make(seed);
    const sim = island.sim;
    sim.invincible = true;
    const c = sim.champion()!;
    const m = sim.monsters().find((x) => x.monster!.region !== 6 && !x.monster!.flies)!;
    place(sim, c, m.x + 0.5, m.z);
    m.state = 'prowl';
    island.step();
    const put = (b: number, d: number) => {
      const r = d / M + bodyR(m);
      m.x = c.x + Math.sin(b) * r;
      m.z = c.z + Math.cos(b) * r;
      m.yaw = b + Math.PI / 2;
      sim.stop(m);
    };
    const blow = (weapon: 'sword' | 'spear') => {
      cs(sim).swingReady = 0;
      const hp = m.hp;
      sim.inputs.push({ type: 'wield', weapon }, { type: 'swing', yaw: 0, pitch: 0, targetId: m.id, zone: 'torso' });
      island.step();
      return hp - m.hp;
    };
    return { island, sim, c, m, put, blow };
  }

  it('a thrust reaches a meter further than the sword, on a narrower line, for 15 piercing', () => {
    const { sim, c, m, put, blow } = duel();
    c.human!.spears = 1;
    const k = (1 + 0.1 * (c.level - 1)) * sim.stat(c, 'strength') * armFactor(c);
    // 4 m off: out of the sword's reach, in the spear's
    put(0, 4);
    expect(blow('sword')).toBe(0);
    expect(blow('spear')).toBeCloseTo(15 * k, 5);
    // 15° wider than the spear's line takes (30° and the body's width), well inside the sword's (70°)
    put(0, 2);
    const wide = Math.PI / 6 + Math.atan2(bodyR(m), 2 / M + bodyR(m)) + Math.PI / 12;
    put(wide, 2);
    expect(blow('spear')).toBe(0);
    expect(blow('sword')).toBeCloseTo(12 * k * cs(sim).weapon.mul, 5);
    // a thrust still uses the spear, and keeps it
    expect(c.human!.spears).toBe(1);
  });

  it('no spear, no spear in hand; the last one thrown, or a new champion, puts the sword back; no shield with a spear', () => {
    const { island, sim, c } = duel(5);
    const S = cs(sim);
    c.human!.spears = 0;
    sim.inputs.push({ type: 'wield', weapon: 'spear' });
    island.step();
    expect(S.wield).toBe('sword');
    expect(sim.actionError).toMatch(/No spears/);
    // a spear in hand: the shield stays down; the sword: up it comes
    c.human!.spears = 1;
    sim.inputs.push({ type: 'wield', weapon: 'spear' }, { type: 'block', on: true });
    island.step();
    expect(S.wield).toBe('spear');
    expect(S.blocking).toBe(false);
    sim.inputs.push({ type: 'wield', weapon: 'sword' }, { type: 'block', on: true });
    island.step();
    expect(S.blocking).toBe(true);
    // thrown away: it's the sword again
    sim.inputs.push({ type: 'block', on: false }, { type: 'wield', weapon: 'spear' });
    island.step();
    S.swingReady = 0;
    sim.inputs.push({ type: 'throw', yaw: 0, pitch: 0.2, targetId: null, zone: null });
    island.step();
    expect(spearsOf(c)).toBe(0);
    expect(S.wield).toBe('sword');
    // lost some other way (dropped): the next tick
    c.human!.spears = 1;
    sim.inputs.push({ type: 'wield', weapon: 'spear' });
    island.step();
    c.human!.spears = 0;
    island.step();
    expect(S.wield).toBe('sword');
    // a new champion takes up the sword
    c.human!.spears = 1;
    sim.inputs.push({ type: 'wield', weapon: 'spear' });
    island.step();
    expect(S.wield).toBe('spear');
    kill(sim, c, { amount: c.hp, type: 'dev', sourceId: -1, sourceKind: 'none' });
    crown(sim);
    expect(S.wield).toBe('sword');
  });

  it('what is in hand is saved; saves from before the spear load with the sword', () => {
    const { island, sim, c } = duel(6);
    c.human!.spears = 1;
    sim.inputs.push({ type: 'wield', weapon: 'spear' });
    island.step();
    const core = serializeCore(sim);
    expect((deserializeCore(core) as unknown as { champState: { wield: string } }).champState.wield).toBe('spear');
    delete (core.champState as { wield?: string }).wield;
    expect((deserializeCore(core) as unknown as { champState: { wield: string } }).champState.wield).toBe('sword');
  });
});

describe('flyers', () => {
  it('every island has two flyers: the ziz and the saraph', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const g = generateMonsters(seed);
      expect(g.map((x) => x.archetype)).toEqual(expect.arrayContaining(['ziz', 'saraph']));
      expect(new Set(g.map((x) => x.region)).size).toBe(6);
    }
  });

  it('a prowling flyer climbs to its soaring height and spots a lone villager from far away', () => {
    const island = make(9);
    const sim = island.sim;
    const z = sim.monsters().find((m) => m.monster!.archetype === 'ziz')!;
    // noon: the ziz hunts by day
    while (sim.hour < 11 || sim.hour > 13) sim.advanceClock(60_000);
    z.state = 'prowl';
    z.monster!.huntAt = [];
    for (let i = 0; i < 200; i++) sim.step();
    expect(z.monster!.alt).toBeGreaterThan(CRUISE_M - 1);
    // a day-shift villager 200 m away, well beyond the 80 m a monster sees from the ground
    const h = sim.humans().find((x) => x.id !== sim.championId && x.human!.shift === 'day' && !x.hidden)!;
    place(sim, h, z.x + 25, z.z);
    z.monster!.huntAt = [sim.clockMs + 10 * 60 * 60_000];
    let spotAt = -1;
    for (let i = 0; i < 60 && spotAt < 0; i++) {
      sim.step();
      const p = sim.ents.get(z.monster!.prey);
      if (p?.kind === 'human') spotAt = Math.hypot(p.x - z.x, p.z - z.z);
    }
    expect(spotAt).toBeGreaterThan(12);
    // and it stoops: lower as it closes
    for (let i = 0; i < 150 && z.monster!.alt! > 3; i++) sim.step();
    expect(z.monster!.alt).toBeLessThanOrEqual(3);
  }, 20_000);
});

describe('the raid', () => {
  it('rolls at 20:00 with a 30 % chance', () => {
    expect(RAID_CHANCE).toBe(0.3);
    let raids = 0;
    const N = 400;
    const sim = make(10).sim;
    for (let k = 0; k < N; k++) {
      sim.raidUntil = 0;
      raidHour(sim, 20);
      if (sim.raidUntil > sim.clockMs) raids++;
    }
    expect(raids / N).toBeGreaterThan(0.22);
    expect(raids / N).toBeLessThan(0.38);
  });

  it('every monster marches on the village and breaks into houses', () => {
    const island = make(11);
    const sim = island.sim;
    // night: everyone off shift is inside
    while (Math.floor(sim.hour) !== 21) sim.advanceClock(60_000);
    sim.raidUntil = 0;
    for (let i = 0; i < 50; i++) sim.step();
    startRaid(sim);
    const V = sim.layout.village;
    const d0 = sim.monsters().map((m) => Math.hypot(m.x - V.x, m.z - V.z));
    for (let i = 0; i < 2500; i++) sim.step();
    const d1 = sim.monsters().map((m) => Math.hypot(m.x - V.x, m.z - V.z));
    const closer = d1.filter((d, k) => d < d0[k] - 5).length;
    expect(closer).toBeGreaterThanOrEqual(4);
    const houses = [...sim.ents.values()].filter((e) => e.role === 'house');
    const touched = houses.filter((h) => houseBreached(sim, h) || (h.data.core?.breachedUntil as number | undefined)).length;
    const dead = sim.stats.villagerDeaths + sim.stats.monsterSacrifices;
    expect(touched + dead).toBeGreaterThan(0);
  });
});
