// Combat and the violent death system (§7): zones, crippling, severing, downed, death types, corpses, XP.
import type { Sim, DeathInfo } from './sim';
import type { DeathType, DmgType, Entity, Zone } from './types';
import { ARCH } from './monsters-gen';
import { calDay } from './clock';
import { onChampionDied } from './champion';
import { dropSpears } from './spears';

export const humanMaxHp = (level: number) => 60 + 20 * (level - 1);
export function monsterMaxHp(m: Entity): number {
  return Math.round(m.monster!.baseHp * Math.pow(1.1, m.level - 1));
}

const HUMAN_ZONES: [Zone, number, number][] = [ // zone, share of maxHp, hit weight
  ['head', 0.15, 8], ['torso', 0.4, 38], ['armL', 0.12, 10], ['armR', 0.12, 10], ['legL', 0.13, 12], ['legR', 0.13, 12],
];
const SIG: [Zone, number, number] = ['sig', 0.15, 10];

function zoneTable(e: Entity) {
  return e.kind === 'monster' ? [...HUMAN_ZONES, SIG] : HUMAN_ZONES;
}

export function initZones(e: Entity) {
  const max = e.base.maxHp;
  e.zones = {};
  for (const [z, share] of zoneTable(e)) e.zones[z] = { hp: max * share, max: max * share, state: 'ok' };
}

/** Rescale zone maxima after a max-HP change, keeping each zone's damage. */
export function rescaleZones(sim: Sim, e: Entity) {
  if (!e.zones) return;
  const max = sim.maxHp(e);
  for (const [z, share] of zoneTable(e)) {
    const st = e.zones[z];
    if (!st) continue;
    const lost = st.max - st.hp;
    st.max = max * share;
    if (st.state === 'ok') st.hp = Math.max(1, st.max - lost);
  }
}

const isHurt = (e: Entity, z: Zone) => e.zones?.[z] && e.zones[z]!.state !== 'ok';

export function legFactor(e: Entity): number {
  const n = (isHurt(e, 'legL') ? 1 : 0) + (isHurt(e, 'legR') ? 1 : 0);
  return n === 2 ? 0.25 : n === 1 ? 0.6 : 1;
}

export function armFactor(e: Entity): number {
  return (isHurt(e, 'armL') ? 0.7 : 1) * (isHurt(e, 'armR') ? 0.7 : 1);
}

export function sigLost(e: Entity): boolean {
  return !!isHurt(e, 'sig');
}

/** Heal hp and zones proportionally (zones heal back to ok, never regrow severed limbs). */
export function heal(sim: Sim, e: Entity, n: number) {
  const max = sim.maxHp(e);
  const before = e.hp;
  e.hp = Math.min(max, e.hp + n);
  const frac = (e.hp - before) / max;
  if (e.zones) for (const z of Object.values(e.zones)) {
    if (!z || z.state === 'severed') continue;
    z.hp = Math.min(z.max, z.hp + z.max * frac * 1.5);
    if (z.state === 'crippled' && z.hp >= z.max * 0.5) z.state = 'ok';
  }
}

function pickZone(sim: Sim, e: Entity): Zone | undefined {
  if (!e.zones) return undefined;
  const opts = zoneTable(e).filter(([z]) => e.zones![z] && e.zones![z]!.state !== 'severed');
  let total = 0;
  for (const [, , w] of opts) total += w;
  let r = sim.rng.next() * total;
  for (const [z, , w] of opts) {
    r -= w;
    if (r <= 0) return z;
  }
  return opts[0]?.[0];
}

const QUIET = new Set(['poison', 'hunger', 'fire-tick', 'cold', 'magic']);
export const severThreshold = (max: number) => Math.max(max * 0.08, 12);

export interface DamageOpts {
  type: DmgType | string;
  zone?: Zone;
  sourceId?: number;
  deathType?: DeathType;
  noRules?: boolean;
  /** extra multiplier applied before rules (enrage, ambush) */
  mul?: number;
}

/** The one damage pipeline for everything with HP (core and modules). */
export interface DamageResult { killed: boolean; downed: boolean; dealt: number; zone?: Zone; severed?: boolean }

export function applyDamage(sim: Sim, t: Entity, amount: number, o: DamageOpts): DamageResult {
  if (!sim.ents.has(t.id) || t.hp <= 0) return { killed: false, downed: false, dealt: 0 };
  const src = o.sourceId !== undefined ? sim.ents.get(o.sourceId) : undefined;
  let d = amount * (o.mul ?? 1);
  if (!o.noRules && sim.damageRules.length) {
    const info = { amount: d, type: String(o.type), targetKind: t.kind, targetFaction: t.faction, sourceKind: src?.kind ?? 'none', sourceFaction: src?.faction };
    for (const r of sim.damageRules) {
      let m: number | undefined;
      try {
        m = r.fn(info);
      } catch {
        m = undefined;
      }
      if (typeof m === 'number' && Number.isFinite(m) && m >= 0) d *= Math.min(10, m);
    }
  }
  if (!(d > 0)) return { killed: false, downed: false, dealt: 0 };
  if (t.id === sim.championId && src && src.kind !== 'human') sim.out.hurt = (sim.out.hurt ?? 0) + d;
  const max = sim.maxHp(t);
  const before = t.hp;
  const isChamp = t.id === sim.championId;
  if (isChamp && sim.invincible) d = Math.min(d, Math.max(0, t.hp - max * 0.5));
  t.hp -= d;

  // zones
  let severed: Zone | null = null;
  const zone = o.zone ?? pickZone(sim, t);
  if (zone && t.zones?.[zone]) {
    const z = t.zones[zone]!;
    const vital = zone === 'head' || zone === 'torso';
    if (z.state === 'crippled' && d >= severThreshold(max) && (!vital || before <= max * 0.2)) {
      z.state = 'severed';
      z.hp = 0;
      if (vital) t.hp = 0;
      else severed = zone;
    } else if (z.state === 'ok') {
      z.hp -= d;
      if (z.hp <= 0) {
        z.hp = 0;
        z.state = 'crippled';
      }
    }
  }
  if (severed) spawnSevered(sim, t, severed);

  // feedback
  if (o.type === 'fire') {
    t.burnUntil = sim.tick + 50;
    t.burnSource = o.sourceId;
    sim.attach(t, 'fire');
  } else if (!QUIET.has(String(o.type)) && t.kind !== 'structure') sim.burstOn(d >= max * 0.15 ? 'blood-big' : 'blood', t, zone === 'head' ? 'head' : zone === 'legL' || zone === 'legR' ? 'feet' : 'center');

  // xp for dealing damage across factions
  const dealt = Math.min(before, d);
  if (src && src.faction && t.faction && src.faction !== t.faction && src.inhabitant) gainXp(sim, src, src.kind === 'human' ? dealt * 0.5 : dealt);
  if (src?.kind === 'monster' && t.kind === 'human' && t.harmedBy) t.harmedBy = undefined;

  const info: DeathInfo = { amount: d, type: String(o.type), zone, sourceId: o.sourceId ?? -1, sourceKind: src?.kind ?? 'none' };
  for (const l of sim.listeners) l.onDamage?.(t, info);

  if (t.hp <= 0) {
    t.hp = 0;
    kill(sim, t, { ...info, deathType: o.deathType ?? chooseDeath(t, o, src, d, max, severed) });
    return { killed: true, downed: false, dealt, zone, severed: !!severed };
  }
  // downed: crossing 20 % from above
  if (t.inhabitant && t.state !== 'downed' && t.state !== 'bound' && t.state !== 'captive' && before > max * 0.2 && t.hp <= max * 0.2) {
    if (!(isChamp && sim.invincible)) {
      setDowned(sim, t);
      return { killed: false, downed: true, dealt, zone, severed: !!severed };
    }
  }
  return { killed: false, downed: false, dealt, zone, severed: !!severed };
}

export function setDowned(sim: Sim, t: Entity) {
  dropCarried(sim, t);
  sim.stop(t);
  t.state = 'downed';
  t.roll = 1;
  if (t.monster) t.monster.downedAt = sim.tick;
  if (t.human) t.human.downedAt = sim.tick;
  if (t.id === sim.championId) {
    sim.order = null;
    if (sim.dragging >= 0) releaseDragged(sim);
    sim.alert({ kind: 'champion', text: 'You are beaten down! Crawl away before they drag you off.' });
  }
  sim.emote(t, '💫', 3);
  if (t.kind === 'monster') sim.sound('roar', t.x, t.z, t.scale * 0.8);
}

function chooseDeath(t: Entity, o: DamageOpts, src: Entity | undefined, d: number, max: number, severed: Zone | null): DeathType {
  if (severed) return 'dismembered';
  if (o.type === 'fire' || (t.burnUntil ?? 0) > 0) return 'burned';
  if (o.type === 'crush') return 'crushed';
  if (o.type === 'bite') return 'bitten';
  if (o.type === 'pierce') return 'impaled';
  if (src?.kind === 'monster' && src.scale >= 1.8 && t.kind === 'human') return 'torn';
  if (o.type === 'slash' && d >= severThreshold(max)) return 'dismembered';
  return 'slain';
}

// ---------- carrying and dragging ----------

/** Whatever e carries falls to the ground. */
export function dropCarried(sim: Sim, e: Entity) {
  if (e.carrying === undefined) return;
  const c = sim.ents.get(e.carrying);
  e.carrying = undefined;
  if (!c) return;
  c.carriedBy = undefined;
  c.lift = 0;
  if (c.kind === 'human') {
    const n = sim.nearestWalkable(c, c.x, c.z, 4);
    if (n) { c.x = n.x + 0.5; c.z = n.z + 0.5; }
    if (c.state === 'captive') {
      c.state = c.hp <= sim.maxHp(c) * 0.2 ? 'downed' : 'flee';
      c.roll = c.state === 'downed' ? 1 : 0;
      if (c.human) c.human.downedAt = sim.tick;
      sim.emote(c, '😮‍💨', 2);
    }
  } else if (c.kind === 'animal') {
    c.state = 'graze';
  }
}

export function releaseDragged(sim: Sim) {
  const d = sim.ents.get(sim.dragging);
  sim.dragging = -1;
  if (!d) return;
  if (d.kind === 'monster' && d.state === 'bound') {
    d.stateUntil = sim.tick + 300; // stays bound a little while, then downed again
  }
}

// ---------- death ----------

export function kill(sim: Sim, e: Entity, info: DeathInfo) {
  if (!sim.ents.has(e.id)) return;
  const deathType = (info.deathType ?? 'slain') as DeathType;
  for (const l of sim.listeners) l.onDeath?.(e, info);
  dropCarried(sim, e);
  if (e.carriedBy !== undefined) {
    const c = sim.ents.get(e.carriedBy);
    if (c) c.carrying = undefined;
  }
  if (sim.dragging === e.id) sim.dragging = -1;
  const src = sim.ents.get(info.sourceId);
  const max = sim.maxHp(e);
  const where = regionName(sim, e);

  if (e.kind === 'monster') {
    sim.stats.monsterKills++;
    if (e.monster!.alt) e.monster!.alt = 0; // a flyer killed in the air drops
    if (src?.kind === 'human') gainXp(sim, src, 50);
    const m = e.monster!;
    for (const nid of m.neighbors) {
      const n = sim.ents.get(nid);
      if (!n || n.kind !== 'monster') continue;
      n.monster!.enragedUntil = sim.clockMs + 2 * 86_400_000;
      if (n.monster!.seen) sim.log(`${firstName(n)} howls for ${firstName(e)}. It will come for the village.`, 2, 'core', 'enraged');
    }
    const lair = sim.byRole(`lair:${m.region}`);
    if (lair) lair.tags.push('empty');
    sim.log(`${e.name} is dead${src?.kind === 'human' ? `, slain by ${src.name}` : ''}${deathType !== 'slain' ? ` (${DEATH_WORD[deathType]})` : ''}.`, 3, 'core', 'monster-death');
  } else if (e.kind === 'human') {
    sim.stats.villagerDeaths++;
    dropSpears(sim, e);
    if (e.shape === 'guard-bare') e.shape = 'guard';
    if (src?.kind === 'monster') gainXp(sim, src, 25);
    const how = src ? `${DEATH_VERB[deathType]} by ${src.name ?? src.kind}` : DEATH_VERB[deathType];
    const job = e.human!.job === 'champion' ? 'the champion' : e.human!.job;
    sim.log(`${e.name}, ${job}, was ${how}${where ? ` in ${where}` : ''}.`, e.id === sim.championId ? 3 : 2, 'core', 'death');
    if (e.id === sim.championId) {
      sim.championId = -1;
      sim.championPendingDawn = true;
      sim.order = null;
      onChampionDied(sim);
      sim.alert({ kind: 'champion', text: `${e.name} has fallen. A new champion will be chosen at dawn.` });
    }
  }
  sim.remove(e);
  spawnCorpse(sim, e, max, deathType, info);
  sim.checkGameOver();
}

const DEATH_WORD: Record<DeathType, string> = { dismembered: 'dismembered', torn: 'torn apart', bitten: 'bitten', burned: 'burned alive', crushed: 'crushed', impaled: 'impaled', eaten: 'eaten', slain: 'slain' };
const DEATH_VERB: Record<DeathType, string> = { dismembered: 'hacked limb from limb', torn: 'torn in two', bitten: 'bitten open', burned: 'burned alive', crushed: 'crushed flat', impaled: 'impaled', eaten: 'eaten', slain: 'slain' };

export function firstName(e: Entity) {
  return (e.name ?? e.kind).split(' ')[0];
}

export function regionName(sim: Sim, e: { x: number; z: number }): string {
  const r = sim.grid.regionAt(e.x, e.z);
  return ['the village', 'Cedar Heights', 'the Olive Terraces', 'the Salt Flats', 'the Wilderness of Stones', 'the Ruins of the Anakim', 'the High Place'][r] ?? '';
}

function bloodPool(sim: Sim, x: number, z: number, scale = 1) {
  const pools = [...sim.ents.values()].filter((b) => b.kind === 'blood');
  if (pools.length >= 60) sim.remove(pools[0]);
  const b = sim.spawn({ kind: 'blood', x, z, shape: 'blood', scale: scale * (0.7 + sim.rng.next() * 0.6) });
  b.yaw = sim.rng.next() * Math.PI * 2;
}

function spawnCorpse(sim: Sim, e: Entity, maxHp: number, deathType: DeathType, info: DeathInfo) {
  const species = e.kind === 'human' ? 'human' : e.monster?.archetype ?? e.animal?.species ?? e.kind;
  const day = calDay(sim.clockMs);
  let revivable = false;
  const make = (shape: string, scale: number) => {
    const c = sim.spawn({ kind: 'corpse', x: e.x, z: e.z, shape, tint: e.tint, scale });
    c.yaw = e.yaw;
    c.roll = 1;
    c.faction = e.faction;
    c.name = e.name;
    c.corpse = { species, name: e.name, maxHp, diedClock: sim.clockMs, diedCalDay: day, deathType, faction: e.faction, bones: false, bonesNights: 0 };
    if (e.inhabitant && !revivable) {
      revivable = true;
      const snap = structuredClone({ ...e, path: null, want: null, data: {} });
      c.data.__revive = snap as unknown as Record<string, unknown>;
    }
    return c;
  };
  const away = sim.ents.get(info.sourceId);
  const ax = away ? e.x - away.x : sim.rng.next() - 0.5, az = away ? e.z - away.z : sim.rng.next() - 0.5;
  const al = Math.hypot(ax, az) || 1;
  switch (deathType) {
    case 'torn': {
      const upper = make(e.kind === 'human' ? 'corpse-upper' : e.shape, e.kind === 'human' ? e.scale : e.scale * 0.6);
      upper.roll = e.kind === 'human' ? 0 : 1;
      upper.anim = { type: 'fly', t: 8, dx: (ax / al) * 0.04, dz: (az / al) * 0.04 };
      const lower = sim.spawn({ kind: 'part', x: e.x, z: e.z, shape: e.kind === 'human' ? 'corpse-lower' : e.shape, tint: e.tint, scale: e.kind === 'human' ? e.scale : e.scale * 0.5 });
      lower.anim = { type: 'fly', t: 8, dx: (-ax / al) * 0.04, dz: (-az / al) * 0.04 };
      lower.roll = e.kind === 'human' ? 0 : 1;
      lower.expireCalDay = day + 3;
      sim.burst('blood-big', e.x, e.z);
      sim.burst('blood-big', e.x, e.z);
      bloodPool(sim, e.x, e.z, 1.4);
      break;
    }
    case 'burned': {
      const c = make(e.shape, e.scale);
      c.roll = 0;
      c.anim = { type: 'burnrun', t: 30, dx: (sim.rng.next() - 0.5) * 0.06, dz: (sim.rng.next() - 0.5) * 0.06 };
      sim.attach(c, 'fire');
      break;
    }
    case 'crushed': {
      const c = make(e.shape, e.scale);
      c.squash = 0.25;
      bloodPool(sim, e.x, e.z, 1.2);
      sim.burst('blood-big', e.x, e.z);
      break;
    }
    case 'impaled': {
      const c = make(e.shape, e.scale);
      c.roll = 0;
      c.anim = { type: 'impale', t: 40, dx: (ax / al) * 0.04, dz: (az / al) * 0.04 };
      sim.burst('blood', e.x, e.z);
      break;
    }
    case 'dismembered': {
      make(e.shape, e.scale).anim = { type: 'crawl', t: 20, dx: (ax / al) * 0.006, dz: (az / al) * 0.006 };
      sim.burst('blood-big', e.x, e.z);
      bloodPool(sim, e.x, e.z);
      break;
    }
    case 'bitten': {
      make(e.shape, e.scale);
      sim.burst('blood-big', e.x, e.z);
      bloodPool(sim, e.x, e.z);
      break;
    }
    default: {
      make(e.shape, e.scale);
      bloodPool(sim, e.x, e.z, 0.8);
    }
  }
}

export function spawnSevered(sim: Sim, e: Entity, zone: Zone) {
  let shape = zone === 'head' ? 'part-head' : 'part-limb';
  if (zone === 'sig' && e.monster) {
    const sig = ARCH[e.monster.archetype].sig;
    shape = sig.includes('wing') ? 'part-wing' : sig.includes('horn') ? 'part-horn' : 'part-limb';
  }
  const p = sim.spawn({ kind: 'part', x: e.x, z: e.z, shape, tint: e.kind === 'human' ? '#c8946a' : e.tint, scale: e.scale });
  const a = sim.rng.next() * Math.PI * 2;
  p.anim = { type: 'fly', t: 10, dx: Math.cos(a) * 0.04, dz: Math.sin(a) * 0.04 };
  p.expireCalDay = calDay(sim.clockMs) + 4;
  p.yaw = a;
  sim.burst('blood-big', e.x, e.z);
  bloodPool(sim, e.x, e.z, 0.6);
  if (e.monster?.seen || e.kind === 'human') sim.emote(e, '🩸', 2);
}

// ---------- per-tick helpers ----------

export function stepBurning(sim: Sim, e: Entity) {
  if (e.kind === 'corpse') return;
  if (sim.tick >= (e.burnUntil ?? 0)) {
    e.burnUntil = undefined;
    sim.detach(e, 'fire');
    return;
  }
  if (sim.tick % 10 === 0) applyDamage(sim, e, 2, { type: 'fire-tick', sourceId: e.burnSource, deathType: 'burned' });
}

export function stepCorpse(sim: Sim, e: Entity) {
  const a = e.anim;
  if (!a) return;
  a.t--;
  const walk = (k = 1) => {
    const nx = e.x + (a.dx ?? 0) * k, nz = e.z + (a.dz ?? 0) * k;
    if (sim.grid.inBounds(Math.floor(nx), Math.floor(nz))) { e.x = nx; e.z = nz; }
  };
  switch (a.type) {
    case 'fly':
      walk();
      e.lift = Math.sin((a.t / 10) * Math.PI) * 1.2;
      break;
    case 'crawl':
      walk();
      break;
    case 'burnrun':
      walk();
      if (a.t % 6 === 0) { a.dx = (sim.rng.next() - 0.5) * 0.06; a.dz = (sim.rng.next() - 0.5) * 0.06; }
      if (a.t <= 0) {
        e.roll = 1;
        e.tint = '#2a2420';
        sim.detach(e, 'fire');
        sim.attach(e, 'smoke');
        e.anim = { type: 'smoke', t: 600 };
        return;
      }
      break;
    case 'impale':
      if (a.t > 30) e.lift = (40 - a.t) * 0.2;
      else if (a.t > 10) e.lift = 2.0;
      else {
        walk(1);
        e.lift = Math.max(0, e.lift - 0.2);
        e.roll = Math.min(1, e.roll + 0.1);
      }
      break;
    case 'smoke':
      if (a.t <= 0) sim.detach(e, 'smoke');
      break;
    case 'eaten':
      e.scale = Math.max(0.35 * (e.corpse ? 1 : 1), e.scale - 0.65 / 200 * (e.data.__s0 as any ?? 1));
      if (a.t % 25 === 0) sim.burst('blood', e.x, e.z);
      if (a.t <= 0 && e.corpse) {
        e.corpse.bones = true;
        e.corpse.deathType = 'eaten';
        e.shape = 'bones';
        e.roll = 0;
        e.squash = 1;
        e.scale = 1;
      }
      break;
  }
  if (a.t <= 0) {
    e.anim = undefined;
    e.lift = 0;
  }
}

export function stepAnimal(sim: Sim, e: Entity) {
  if (e.carriedBy !== undefined) return;
  if (e.path || e.want) {
    sim.advancePath(e, sim.stat(e, 'speed'));
    return;
  }
  if (e.idleUntil > sim.tick) return;
  const r = e.animal!.region;
  for (let k = 0; k < 4; k++) {
    const x = Math.floor(e.x + sim.rng.int(-5, 5)), z = Math.floor(e.z + sim.rng.int(-5, 5));
    if (sim.grid.regionAt(x, z) !== r || !sim.walkableFor(e, x, z)) continue;
    if (sim.goTo(e, x, z)) break;
  }
  e.idleUntil = sim.tick + sim.rng.int(100, 400);
}

// ---------- XP ----------

export function xpToNext(e: Entity): number {
  return (e.kind === 'monster' ? 150 : 100) * e.level;
}

export function gainXp(sim: Sim, e: Entity, n: number) {
  if (!(n > 0) || !sim.ents.has(e.id)) return;
  e.xp += n;
  while (e.xp >= xpToNext(e)) {
    e.xp -= xpToNext(e);
    levelUp(sim, e);
  }
}

export function levelUp(sim: Sim, e: Entity) {
  const before = sim.maxHp(e);
  e.level++;
  if (e.kind === 'monster') {
    e.base.maxHp = monsterMaxHp(e);
    e.scale = ARCH[e.monster!.archetype].scale * Math.pow(1.05, e.level - 1);
  } else e.base.maxHp = humanMaxHp(e.level);
  const after = sim.maxHp(e);
  e.hp = Math.min(after, e.hp + (after - before));
  rescaleZones(sim, e);
  sim.emote(e, '⬆', 2);
  sim.burst('levelup', e.x, e.z);
  if (e.id === sim.championId) sim.log(`${e.name} grows stronger: level ${e.level} (${Math.round(after)} HP).`, 2, 'core', 'levelup');
  else if (e.kind === 'monster' && e.monster!.seen) sim.log(`${e.name} has grown larger and fiercer (level ${e.level}).`, 2, 'core', 'levelup');
}
