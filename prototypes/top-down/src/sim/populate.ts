// Initial population (§5.1, §6): structures, villagers, the champion, monsters, wild animals.
import type { Sim } from './sim';
import type { Entity, Job } from './types';
import { makePerson } from './lore';
import { ARCH, generateMonsters, neighborGraph } from './monsters-gen';
import { JOB_TINT } from './core-defs';
import { humanMaxHp, monsterMaxHp } from './combat';
import { initZones } from './combat';
import { hourOf } from './clock';
import { REGION_NAMES } from './island-gen';
import { rollHunts } from './monster-ai';

export const JOB_LABEL: Record<Job, string> = {
  champion: 'champion', shepherd: 'shepherd', vinedresser: 'vinedresser', woodcutter: 'woodcutter', fisherman: 'fisherman', farmer: 'farmer', guard: 'guard',
};

export function shapeForJob(job: Job): string {
  return job === 'champion' ? 'champion' : job === 'guard' ? 'guard' : job === 'shepherd' ? 'shepherd' : 'human';
}

export function populate(sim: Sim) {
  const L = sim.layout;
  const S = (role: string, p: { x: number; z: number }, shape: string, yaw = 0) => {
    const e = sim.spawn({ kind: 'structure', x: p.x + 0.5, z: p.z + 0.5, shape });
    e.role = role;
    e.yaw = yaw;
    return e;
  };
  const houses: Entity[] = [];
  for (const p of L.houses) {
    const yaw = Math.atan2(L.village.x - p.x, L.village.z - p.z);
    const h = S('house', p, 'house', yaw);
    houses.push(h);
  }
  const altar = S('village-altar', L.villageAltar, 'village-altar');
  sim.attach(altar, 'altar');
  S('high-altar', L.highAltar, 'high-altar');
  S('fold', L.fold, 'fold');
  S('granary', L.granary, 'granary');
  for (let r = 1; r <= 6; r++) {
    const l = S(`lair:${r}`, L.lairs[r], `lair-${r}`, sim.rng.next() * Math.PI * 2);
    l.region = r;
  }

  // villagers: 4 shepherds, 3 vinedressers, 3 woodcutters, 3 fishermen, 4 farmers, 3 guards
  const jobs: Job[] = [
    'shepherd', 'shepherd', 'shepherd', 'shepherd', 'vinedresser', 'vinedresser', 'vinedresser', 'woodcutter', 'woodcutter', 'woodcutter',
    'fisherman', 'fisherman', 'fisherman', 'farmer', 'farmer', 'farmer', 'farmer', 'guard', 'guard', 'guard',
  ];
  const nightShift = new Set([0, 1, 10, 17]); // 2 shepherds, 1 fisherman, 1 guard
  jobs.forEach((job, k) => {
    const home = houses[k % houses.length];
    spawnHuman(sim, job, home, job === 'guard' ? 2 : 1, nightShift.has(k) ? 'night' : 'day');
  });
  // the champion
  const champ = spawnHuman(sim, 'champion', houses[0], 3, 'day');
  champ.tags.push('champion');
  sim.championId = champ.id;
  champ.x = L.villageAltar.x + 0.5;
  champ.z = L.villageAltar.z + 1.5;
  // the elder: the first farmer gets the title
  const elder = sim.humans().find((h) => h.human?.job === 'farmer');
  if (elder) elder.tags.push('elder');

  // monsters
  const gen = generateMonsters(sim.seed);
  const graph = neighborGraph(gen.length, sim.seed);
  const ids: number[] = [];
  gen.forEach((g) => {
    const a = ARCH[g.archetype];
    const lair = L.lairs[g.region];
    const m = sim.spawn({ kind: 'monster', x: lair.x + 0.5, z: lair.z + 1.2, shape: a.id, tint: g.tint, scale: a.scale });
    m.faction = 'monster';
    m.inhabitant = true;
    m.name = `${g.name} ${g.epithet}`;
    m.level = 1;
    m.monster = {
      archetype: a.id, epithet: g.epithet, region: g.region, lairX: lair.x + 0.5, lairZ: lair.z + 0.5,
      hours: g.hours, restless: [], neighbors: [], baseHp: g.hp, dmg: g.dmg, dmgType: a.dmgType, reach: a.reach,
      flies: !!a.flies, swims: !!a.swims, enragedUntil: 0, huntAt: [], huntUntil: 0, ground: null, prey: -1, grabAt: 0, feedAt: 0, visit: null,
      lairFound: false, seen: false, seenHours: [], lastSeenClock: 0, roarAt: -9999, respondTo: null, downedAt: 0,
      windup: -1, attackReadyAt: 0, runFrom: null,
    };
    m.base = { speed: a.speed, maxHp: monsterMaxHp(m), strength: 1, sight: 1 };
    m.hp = m.base.maxHp;
    initZones(m);
    m.state = 'rest';
    ids.push(m.id);
  });
  for (let k = 0; k < ids.length; k++) {
    const m = sim.ents.get(ids[k])!;
    m.monster!.neighbors = graph[k].map((j) => ids[j]);
  }
  rollRestless(sim);
  for (const m of sim.monsters()) rollHunts(sim, m);

  // wild animals
  for (const p of L.goats) spawnAnimal(sim, 'goat', p);
  for (const p of L.oxen) spawnAnimal(sim, 'ox', p);

  sim.log(`Day 1. The village of twenty souls wakes on an island in the Great Sea. Six horrors hide in its hills. You are ${champ.name}, their champion.`, 3);
  void hourOf;
  void REGION_NAMES;
}

export function spawnHuman(sim: Sim, job: Job, home: Entity, level: number, shift: 'day' | 'night'): Entity {
  const p = makePerson(sim.rng, JOB_LABEL[job]);
  const e = sim.spawn({ kind: 'human', x: home.x, z: home.z + 0.8, shape: shapeForJob(job), tint: JOB_TINT[job], scale: 1 });
  e.faction = 'human';
  e.inhabitant = true;
  e.name = p.name;
  e.level = level;
  e.human = {
    job, shift, homeId: home.id, bio: p.bio, male: p.male, site: -1, workedMs: 0, downedAt: 0, attackReadyAt: 0,
    screamAt: 0, capturedAt: 0, missingReported: false,
  };
  e.base = { speed: job === 'champion' ? 1.1 : 0.8, maxHp: humanMaxHp(level), strength: 1, sight: 1 };
  e.hp = e.base.maxHp;
  initZones(e);
  e.state = 'idle';
  e.yaw = sim.rng.next() * Math.PI * 2;
  for (const l of sim.listeners) l.onSpawn?.(e);
  return e;
}

export function spawnAnimal(sim: Sim, species: 'goat' | 'ox', p: { x: number; z: number }): Entity {
  const tint = species === 'goat' ? sim.rng.pick(['#4a3a2a', '#e0d8c8', '#6a5a48'])! : sim.rng.pick(['#5a4030', '#3a2a20'])!;
  const e = sim.spawn({ kind: 'animal', x: p.x + 0.5, z: p.z + 0.5, shape: species, tint, scale: 1 });
  e.animal = { species, region: sim.grid.regionAt(p.x, p.z) };
  e.base = { speed: species === 'goat' ? 0.6 : 0.5, maxHp: species === 'goat' ? 40 : 80, strength: 1, sight: 1 };
  e.hp = e.base.maxHp;
  e.state = 'graze';
  return e;
}

/** Restless monsters get 3 random 3-hour windows per day. */
export function rollRestless(sim: Sim) {
  for (const m of sim.monsters()) {
    if (m.monster!.hours !== 'restless') continue;
    m.monster!.restless = [0, 1, 2].map(() => {
      const a = sim.rng.int(0, 23);
      return [a, (a + 3) % 24] as [number, number];
    });
  }
}
