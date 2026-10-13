// The arena's director (src/arena/README.md): spawns monster waves through the gates, keeps the guards topped up,
// brings a fallen champion back, clears bodies, and reports. It only puts things in the arena; how they fight is
// the game's own code (or its sandbox copy), untouched.
import type { DeathInfo, SimListener } from '../sim/sim';
import type { Entity, Job } from '../sim/types';
import { TICKS_PER_SECOND, HOUR_MS } from '../sim/clock';
import { ARCH } from '../sim/monsters-gen';
import { makeMonsterName, makePerson } from '../sim/lore';
import { JOB_TINT } from '../sim/core-defs';
import { humanMaxHp, initZones, monsterMaxHp } from '../sim/combat';
import { JOB_LABEL, shapeForJob } from '../sim/populate';
import { RACK_SPEARS, setSpears, spawnSpear } from '../sim/spears';
import { clearClimb, cs } from '../sim/champion';
import { M } from '../sim/ground';
import type { ArenaSim } from './arena-sim';
import { C } from './geometry';
import type { ArenaRules, ArenaStatus } from './rules';

const sec = (s: number) => Math.round(s * TICKS_PER_SECOND);
/** a tag the arena puts on the people it spawns */
const ARENA_TAG = 'arena';
/** guards with this tag follow the champion (src/arena/sandbox/sim/village.ts reads it; the game has no followers yet) */
export const FOLLOWER_TAG = 'follower';

export class ArenaDirector implements SimListener {
  spawned = 0;
  kills = 0;
  deaths = 0;
  guardDeaths = 0;
  private roundStart = 0;
  private nextWave = 0;
  private champBackAt = -1;
  /** tick each fallen guard may be replaced */
  private guardQueue: number[] = [];
  /** when each body first appeared */
  private born = new Map<number, number>();
  private gateTurn = 0;

  constructor(private sim: ArenaSim, public rules: ArenaRules) {
    sim.listeners.push(this);
  }

  /** Start (or restart) a round: clear the floor, refill the racks, champion and guards back at the spawn. */
  reset() {
    const sim = this.sim;
    for (const e of [...sim.ents.values()]) {
      if (e.kind === 'monster' || e.kind === 'corpse' || e.kind === 'part' || e.kind === 'blood' || e.kind === 'spear' || e.role === 'spear-rack') sim.remove(e);
      else if (e.kind === 'human') sim.remove(e);
    }
    sim.championId = -1;
    sim.championPendingDawn = false;
    sim.dragging = -1;
    sim.order = null;
    this.born.clear();
    this.guardQueue = [];
    this.spawned = this.kills = this.deaths = this.guardDeaths = 0;
    this.roundStart = sim.tick;
    this.nextWave = sim.tick + sec(Math.min(5, this.rules.spawnEvery));
    this.champBackAt = -1;
    this.placeRacks();
    this.spawnChampion();
    for (let k = 0; k < this.rules.guards; k++) this.spawnGuard();
    this.apply(this.rules);
  }

  /** New rules, live. */
  apply(rules: ArenaRules) {
    const sim = this.sim;
    const waveWas = this.rules.spawnEvery;
    this.rules = rules;
    this.hold();
    if (rules.spawnEvery !== waveWas) this.nextWave = Math.min(this.nextWave, sim.tick + sec(rules.spawnEvery));
    for (const g of this.guards()) this.setFollow(g, rules.guardsFollow);
    // fewer guards wanted: the newest go; more: they come now
    for (const g of this.guards().slice(rules.guards)) sim.remove(g);
    const missing = rules.guards - this.guards().length;
    this.guardQueue = this.guardQueue.slice(0, Math.max(0, missing));
    while (this.guardQueue.length < missing) this.guardQueue.push(sim.tick);
  }

  guards(): Entity[] {
    return this.sim.humans().filter((h) => h.human!.job === 'guard').sort((a, b) => a.id - b.id);
  }

  // ---------- the tick ----------

  /** The game's systems held where the arena wants them, every tick (and before the first). */
  private hold() {
    const sim = this.sim;
    // the village economy stands still: never starving, never growing
    sim.food = sim.foodCap * 0.4;
    // the monsters are always out for blood: the game's raid behavior, with the whole floor as the "village"
    sim.raidUntil = sim.clockMs + 9 * HOUR_MS;
    // no shofar: the guards at their posts would sound it at every monster
    sim.alarmUntil = 0;
    sim.alarmCooldownUntil = sim.tick + 1e6;
    sim.invincible = this.rules.invincible;
    sim.fixedHour = this.rules.hour;
  }

  onTick() {
    const sim = this.sim;
    this.hold();
    // the game would crown a guard at dawn: the arena brings a champion back its own way
    if (sim.championPendingDawn) cs(sim).diedTick = sim.tick;
    if (!sim.champion() && this.champBackAt < 0) this.champBackAt = sim.tick + sec(this.rules.championRespawn);
    if (this.champBackAt >= 0 && sim.tick >= this.champBackAt) this.spawnChampion();

    for (const e of [...sim.ents.values()]) {
      // newcomers and anyone else the game's systems bring: the arena only has its own people
      if (e.kind === 'human' && !e.tags.includes(ARENA_TAG)) sim.remove(e);
      else if (e.kind === 'animal') sim.remove(e);
      else if (e.role?.startsWith('lair:') && e.tags.includes('empty')) e.tags = e.tags.filter((t) => t !== 'empty');
      else if (e.kind === 'corpse' || e.kind === 'part' || e.kind === 'blood') {
        const b = this.born.get(e.id);
        if (b === undefined) this.born.set(e.id, sim.tick);
        else if (this.rules.bodiesLinger > 0 && sim.tick - b > sec(this.rules.bodiesLinger) && sim.dragging !== e.id) {
          sim.remove(e);
          this.born.delete(e.id);
        }
      }
    }

    // guards
    while (this.guardQueue.length && sim.tick >= this.guardQueue[0] && this.guards().length < this.rules.guards) {
      this.guardQueue.shift();
      this.spawnGuard();
    }

    // waves
    const alive = sim.monsters().length;
    const left = this.rules.roundLimit > 0 ? this.rules.roundLimit - this.spawned : Infinity;
    if (this.rules.autoSpawn && sim.tick >= this.nextWave && left > 0 && this.rules.monsters.length) {
      const n = Math.min(this.rules.waveSize, this.rules.maxAlive - alive, left);
      for (let k = 0; k < n; k++) this.spawnMonster(null);
      if (n > 0 || alive >= this.rules.maxAlive) this.nextWave = sim.tick + sec(this.rules.spawnEvery);
    }
  }

  onDeath(e: Entity, _info: DeathInfo) {
    const sim = this.sim;
    if (e.kind === 'monster') this.kills++;
    else if (e.id === sim.championId) {
      this.deaths++;
      sim.toast(`Back in ${this.rules.championRespawn} s.`);
    } else if (e.human?.job === 'guard') {
      this.guardDeaths++;
      if (this.rules.guardRespawn > 0) this.guardQueue.push(sim.tick + sec(this.rules.guardRespawn));
    }
  }

  status(): ArenaStatus {
    const sim = this.sim;
    const left = this.rules.roundLimit > 0 ? this.rules.roundLimit - this.spawned : Infinity;
    const waveDue = this.rules.autoSpawn && left > 0 && this.rules.monsters.length > 0 && sim.monsters().length < this.rules.maxAlive;
    return {
      type: 'arenaStatus',
      alive: sim.monsters().map((m) => ({ archetype: m.monster!.archetype, hp: Math.round(m.hp), max: Math.round(sim.maxHp(m)), level: m.level, state: m.state })),
      guards: this.guards().length,
      spawned: this.spawned,
      kills: this.kills,
      deaths: this.deaths,
      guardDeaths: this.guardDeaths,
      nextWave: waveDue ? Math.max(0, (this.nextWave - sim.tick) / TICKS_PER_SECOND) : null,
      respawn: this.champBackAt >= 0 ? Math.max(0, (this.champBackAt - sim.tick) / TICKS_PER_SECOND) : null,
      roundSeconds: (sim.tick - this.roundStart) / TICKS_PER_SECOND,
    };
  }

  // ---------- spawning ----------

  private person(job: Job, level: number, x: number, z: number): Entity {
    const sim = this.sim;
    const p = makePerson(sim.rng, JOB_LABEL[job]);
    const e = sim.spawn({ kind: 'human', x, z, shape: shapeForJob(job), tint: JOB_TINT[job], scale: 1, tags: [ARENA_TAG] });
    e.faction = 'human';
    e.inhabitant = true;
    e.name = p.name;
    e.level = level;
    e.human = { job, shift: 'day', homeId: -1, bio: p.bio, male: p.male, site: -1, workedMs: 0, downedAt: 0, attackReadyAt: 0, screamAt: 0, capturedAt: 0, missingReported: false };
    e.base = { speed: job === 'champion' ? 1.1 : 0.8, maxHp: humanMaxHp(level), strength: 1, sight: 1 };
    e.hp = e.base.maxHp;
    initZones(e);
    e.state = 'idle';
    e.yaw = Math.PI; // facing the arena (−z)
    for (const l of sim.listeners) l.onSpawn?.(e);
    return e;
  }

  spawnChampion() {
    const sim = this.sim;
    this.champBackAt = -1;
    const old = sim.champion();
    if (old) sim.remove(old);
    const s = sim.arena.spawn;
    const c = this.person('champion', this.rules.championLevel, s.x, s.z);
    c.tags.push('champion');
    setSpears(c, this.rules.championSpears);
    clearClimb(c);
    sim.championId = c.id;
    sim.championPendingDawn = false;
    sim.order = null;
    sim.dragging = -1;
    const S = cs(sim);
    S.lastInput = sim.tick;
    // a new epoch with a correction: the client snaps its view to the spawn (poses from before are ignored)
    S.epoch++;
    S.correction = { x: c.x, z: c.z, epoch: S.epoch };
    S.trail = [];
    S.poses = [];
    S.wield = 'sword';
    S.blocking = false;
    S.iframesUntil = sim.tick + sec(1.5);
    return c;
  }

  spawnGuard() {
    const sim = this.sim;
    const s = sim.arena.spawn;
    const k = this.guards().length;
    const a = (k / Math.max(1, this.rules.guards)) * Math.PI * 2;
    const g = this.person('guard', this.rules.guardLevel, s.x + Math.cos(a) * 1.2, s.z - 0.8 + Math.sin(a) * 0.8);
    setSpears(g, this.rules.guardSpears);
    this.setFollow(g, this.rules.guardsFollow);
    return g;
  }

  private setFollow(g: Entity, on: boolean) {
    const has = g.tags.includes(FOLLOWER_TAG);
    if (on && !has) g.tags.push(FOLLOWER_TAG);
    else if (!on && has) g.tags = g.tags.filter((t) => t !== FOLLOWER_TAG);
    g.human!.site = -1;
    this.sim.stop(g);
  }

  /** One monster through a gate: the given archetype, or a random allowed one. */
  spawnMonster(archetype: string | null): Entity | null {
    const sim = this.sim;
    const id = archetype ?? sim.rng.pick(this.rules.monsters);
    const a = id ? ARCH[id] : undefined;
    if (!a) return null;
    const L = sim.layout;
    const r = 1 + (this.gateTurn++ % 6);
    const gate = L.lairs[r];
    // a step out of the gate, toward the middle
    const dx = C - gate.x, dz = C - gate.z, dl = Math.hypot(dx, dz) || 1;
    const x = gate.x + 0.5 + (dx / dl) * 1.2, z = gate.z + 0.5 + (dz / dl) * 1.2;
    const name = makeMonsterName(sim.rng);
    const m = sim.spawn({ kind: 'monster', x, z, shape: a.id, tint: sim.rng.pick(a.palette)!, scale: a.scale * Math.pow(1.05, this.rules.monsterLevel - 1) });
    m.faction = 'monster';
    m.inhabitant = true;
    m.name = `${name.name} ${name.epithet}`;
    m.level = this.rules.monsterLevel;
    m.yaw = Math.atan2(dx, dz);
    m.monster = {
      archetype: a.id, epithet: name.epithet, region: r, lairX: gate.x + 0.5, lairZ: gate.z + 0.5,
      hours: 'restless', restless: [], neighbors: [], baseHp: a.hp, dmg: a.dmg, dmgType: a.dmgType, reach: a.reach,
      flies: !!a.flies, swims: !!a.swims, enragedUntil: 0, huntAt: [], huntUntil: 0, ground: null, prey: -1, grabAt: 0, feedAt: 0, visit: null,
      lairFound: true, seen: true, seenHours: [], lastSeenClock: 0, roarAt: -9999, respondTo: null, downedAt: 0,
      windup: -1, attackReadyAt: 0, runFrom: null,
    };
    m.base = { speed: a.speed, maxHp: monsterMaxHp(m), strength: 1, sight: 1 };
    m.hp = m.base.maxHp;
    initZones(m);
    m.state = 'raid';
    m.idleUntil = 0;
    for (const l of sim.listeners) l.onSpawn?.(m);
    this.spawned++;
    sim.sound('roar', m.x, m.z, m.scale);
    return m;
  }

  private placeRacks() {
    const sim = this.sim;
    for (const r of sim.arena.racks) {
      const rack = sim.spawn({ kind: 'structure', x: r.x, z: r.z, shape: 'spear-rack' });
      rack.role = 'spear-rack';
      rack.yaw = r.yaw;
      const ax = Math.cos(r.yaw), az = -Math.sin(r.yaw);
      for (let k = 0; k < RACK_SPEARS; k++) {
        const off = ((k - (RACK_SPEARS - 1) / 2) * 0.4) / M;
        spawnSpear(sim, rack.x + ax * off, rack.z + az * off, 'rack', r.yaw);
      }
    }
  }
}
