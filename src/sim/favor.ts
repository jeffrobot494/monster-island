// Favor, offerings and Judgment (§8, R22, R23).
import type { Sim } from './sim';
import type { Entity, Faction } from './types';
import { calDay } from './clock';
import { firstName, gainXp, kill } from './combat';

export const DOMAINS = ['creatures', 'weather', 'sky', 'land', 'plants', 'bodies', 'laws'] as const;
export const GOD_NAME: Record<Faction, string> = { human: 'The Most High', monster: 'Dagon' };

export function scaleFor(favor: number): number {
  return favor < 100 ? 1 : favor < 300 ? 2 : favor < 600 ? 3 : favor < 1000 ? 4 : 5;
}

export function offerFavor(sim: Sim, faction: Faction, value: number, altar: 'village' | 'high', victimKind: string) {
  sim.favor[faction] += value;
  for (const l of sim.listeners) l.onSacrifice?.({ faction, altar, victimKind, favor: value });
}

/** Value of an offering at the village altar (live = 100 % max HP; fresh carcass = 50 %; bones = 0). */
export function offeringValue(sim: Sim, e: Entity): number {
  if (e.kind === 'corpse' && e.corpse) {
    if (e.corpse.bones || e.corpse.diedCalDay !== calDay(sim.clockMs)) return 0;
    return Math.round(e.corpse.maxHp * 0.5);
  }
  return Math.round(sim.maxHp(e));
}

function altarBurn(sim: Sim, value: number, faction: Faction) {
  const A = sim.layout.villageAltar;
  sim.burst(faction === 'human' ? 'pillar' : 'dark-pillar', A.x + 0.5, A.z + 0.5, sim.grid.height(A.x, A.z) + 0.8);
  sim.burst('fire', A.x + 0.5, A.z + 0.5, sim.grid.height(A.x, A.z) + 0.8);
  const alt = sim.byRole('village-altar');
  if (alt) sim.emote(alt, `+${value}`, 2.5);
}

export function nearAltar(sim: Sim): boolean {
  const c = sim.champion();
  const A = sim.layout.villageAltar;
  return !!c && Math.hypot(A.x + 0.5 - c.x, A.z + 0.5 - c.z) < 2.8;
}

export function offerLamb(sim: Sim): string | null {
  if (!nearAltar(sim)) return 'You must stand at the altar.';
  if (sim.fold <= 0) return 'The fold is empty.';
  sim.fold--;
  offerFavor(sim, 'human', 40, 'village', 'lamb');
  sim.stats.humanSacrifices++;
  altarBurn(sim, 40, 'human');
  sim.log('A lamb is burned to the Most High. (+40 favor)', 1, 'core', 'offering');
  return null;
}

export function offerDragged(sim: Sim): string | null {
  if (!nearAltar(sim)) return 'You must stand at the altar.';
  const d = sim.ents.get(sim.dragging);
  if (!d) return 'You are not dragging anything.';
  const value = offeringValue(sim, d);
  if (value <= 0) return 'The altar refuses old bones.';
  const forbidden = (d.kind === 'corpse' && d.corpse?.species === 'human') || d.kind === 'human';
  const name = d.name ?? d.corpse?.species ?? d.kind;
  sim.dragging = -1;
  if (d.kind === 'monster') {
    kill(sim, d, { amount: 999, type: 'fire', sourceId: sim.championId, sourceKind: 'human', deathType: 'burned' });
    const c = sim.champion();
    if (c) gainXp(sim, c, 50);
    sim.log(`${name} burns alive on the altar of the Most High! (+${value} favor)`, 3, 'core', 'offering');
  } else {
    sim.remove(d);
    sim.log(`The body of ${name} is burned on the altar. (+${value} favor)`, 2, 'core', 'offering');
  }
  offerFavor(sim, 'human', value, 'village', d.kind === 'monster' ? 'monster' : d.corpse?.species ?? d.kind);
  sim.stats.humanSacrifices++;
  altarBurn(sim, value, 'human');
  if (forbidden) condemn(sim, value);
  return null;
}

export function offerVillager(sim: Sim, id: number): string | null {
  if (!nearAltar(sim)) return 'You must stand at the altar.';
  const v = sim.ents.get(id);
  if (!v || v.kind !== 'human' || v.id === sim.championId) return 'No such villager.';
  const value = Math.round(sim.maxHp(v));
  const name = v.name!;
  const A = sim.layout.villageAltar;
  v.x = A.x + 0.5;
  v.z = A.z + 0.5;
  v.hidden = false;
  kill(sim, v, { amount: 999, type: 'fire', sourceId: sim.championId, sourceKind: 'human', deathType: 'burned' });
  offerFavor(sim, 'human', value, 'village', 'human');
  sim.stats.humanSacrifices++;
  altarBurn(sim, value, 'human');
  sim.log(`${name} is bound and burned on the altar by the champion's hand. (+${value} favor)`, 3, 'core', 'forbidden');
  condemn(sim, value);
  return null;
}

/** The forbidden offering: the elder condemns, and Dagon drinks the same blood (R22). */
function condemn(sim: Sim, value: number) {
  sim.favor.monster += value;
  const elder = sim.humans().find((h) => h.tags.includes('elder'));
  const who = elder ? firstName(elder) + ' the elder' : 'The elder';
  sim.log(`${who} tears ${elder?.human?.male === false ? 'her' : 'his'} robe: "You have fed the Pit with our own blood. Dagon laughs tonight." (+${value} to Dagon as well)`, 3, 'core', 'forbidden');
  sim.alert({ kind: 'forbidden', text: `${who} condemns you. Dagon gains ${value} favor too.` });
  for (const h of sim.humans()) if (!h.hidden && h.id !== sim.championId) sim.emote(h, '😠', 3);
}

export function setPrayer(sim: Sim, text: string) {
  sim.prayer = text.trim().slice(0, 200);
  if (sim.prayer) sim.log(`Your prayer rises: "${sim.prayer}"`, 1, 'core', 'prayer');
}

/** Domains the god may use for a creation made for `night` (variety rule; computed when the job starts, R23). */
export function allowedDomains(sim: Sim, god: Faction, night: number, scale: number, inFlight: string[] = []): string[] {
  const recent = new Set(sim.domainHistory[god].filter((d) => d.night >= night - 3 && d.night < night).map((d) => d.domain));
  for (const d of inFlight) recent.add(d);
  const out: string[] = DOMAINS.filter((d) => !recent.has(d));
  if (scale >= 4 && !recent.has('fundamental')) out.push('fundamental');
  return out.length ? out : [...DOMAINS];
}

export function judgment(sim: Sim) {
  const h = Math.round(sim.favor.human), m = Math.round(sim.favor.monster);
  const night = sim.nightIndex;
  if (h === m) {
    sim.log(`Midnight. Judgment: ${h} to ${m}. Both gods rest.`, 3, 'core', 'judgment');
    sim.alert({ kind: 'judgment', text: `Judgment: ${h} to ${m}. Both gods rest.` });
  } else {
    const god: Faction = h > m ? 'human' : 'monster';
    const favor = Math.max(h, m);
    const scale = scaleFor(favor);
    const text = `Midnight. Judgment: the Most High ${h}, Dagon ${m}. ${GOD_NAME[god]} prevails, and shapes the world (scale ${scale}).`;
    sim.log(text, 3, 'core', 'judgment');
    sim.alert({ kind: 'judgment', text });
    if (sim.judgmentEnabled) {
      sim.pendingCreations.push({ night, day: sim.day, god, favor, scale, allowedDomains: [], prayer: god === 'human' ? sim.prayer || null : null, tallies: { human: h, monster: m } });
      while (sim.pendingCreations.length > 3) {
        const r = sim.pendingCreations.shift()!;
        sim.log(`${GOD_NAME[r.god]} let the night of day ${r.day} pass without a creation.`, 1, 'core', 'judgment');
      }
    }
  }
  sim.favor = { human: 0, monster: 0 };
  sim.prayer = '';
}
