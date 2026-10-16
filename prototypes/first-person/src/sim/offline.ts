// Away-time resolver (§9 + R1, R4, R5, R7): abstract hour-by-hour resolution of long gaps.
import type { Sim } from './sim';
import type { Entity } from './types';
import { DAY_MS, HOUR_MS } from './clock';
import { SIZE } from './world';
import { PRODUCTION, doorOf, onShift, pickSite } from './village';
import { boldness, isEnraged, raiding } from './monster-ai';
import { applyDamage, firstName, gainXp, heal, isWounded, kill } from './combat';
import { offerFavor, GOD_NAME } from './favor';
import { leaveHouse } from './village';
import { clearClimb, cs } from './champion';

export interface AwaySummary {
  hours: number;
  deaths: string[];
  judgments: string[];
  favor: { human: number; monster: number };
  foodBefore: number;
  foodAfter: number;
  events: string[];
}

export function resolveAway(sim: Sim, gapClockMs: number, realGapMs: number): AwaySummary {
  const sum: AwaySummary = { hours: gapClockMs / HOUR_MS, deaths: [], judgments: [], favor: { human: 0, monster: 0 }, foodBefore: Math.round(sim.food), foodAfter: 0, events: [] };
  const evStart = sim.out.events.length;
  const A = sim.layout.highAltar;
  const V = sim.layout.village;
  const champ = sim.champion();
  const longAway = realGapMs >= 30 * 60_000;

  // 1. snap in-progress state
  for (const m of sim.monsters()) {
    const M = m.monster!;
    if ((m.state === 'carry' || m.state === 'sacrifice') && m.carrying !== undefined) {
      const v = sim.ents.get(m.carrying);
      m.carrying = undefined;
      if (v) {
        v.carriedBy = undefined;
        sacrificeOffline(sim, m, v, sum);
      }
    }
    if (m.state === 'downed') {
      m.roll = 0;
      m.hp = Math.max(m.hp, sim.maxHp(m) * 0.3);
    }
    if (m.state === 'bound') {
      if (longAway || sim.dragging !== m.id) {
        const p = sim.nearestWalkable(m, sim.layout.villageAltar.x + 1.5, sim.layout.villageAltar.z + 0.5, 3);
        if (p) { m.x = p.x + 0.5; m.z = p.z + 0.5; }
        m.stateUntil = 0;
        if (longAway && sim.dragging === m.id) sim.dragging = -1;
        sum.events.push(`The villagers kept ${firstName(m)} chained beside the altar.`);
      }
      continue;
    }
    m.state = 'rest';
    m.target = -1;
    M.respondTo = null;
    M.windup = -1;
    M.prey = -1;
    delete M.besiegeUntil;
    delete M.besiegeSince;
  }
  for (const e of sim.ents.values()) {
    if (e.burnUntil !== undefined) {
      e.burnUntil = undefined;
      sim.detach(e, 'fire');
    }
    if (e.kind === 'human' && (e.state === 'downed' || e.state === 'captive')) {
      e.state = 'idle';
      e.roll = 0;
      e.lift = 0;
      e.carriedBy = undefined;
    }
    e.stateUntil = 0;
    sim.stop(e);
  }
  sim.alarmUntil = 0;
  if (champ && longAway) {
    sim.order = null;
    if (sim.dragging >= 0 && sim.ents.get(sim.dragging)?.kind !== 'monster') sim.dragging = -1;
    champ.x = V.x + 0.5;
    champ.z = V.z + 1.5;
    clearClimb(champ);
    heal(sim, champ, 9999);
  }
  sim.repathQueue.length = 0;

  // 2. hour by hour
  let left = gapClockMs;
  while (left > 0 && !sim.gameOver) {
    const toHour = HOUR_MS - (((sim.clockMs % HOUR_MS) + HOUR_MS) % HOUR_MS);
    const step = Math.min(left, toHour);
    const f = step / HOUR_MS;
    const end = sim.clockMs + step;
    // workers on shift need a site (they would have walked to one)
    for (const h of sim.humans()) if (h.id !== sim.championId && onShift(sim, h) && (h.human!.site < 0 || sim.stock[h.human!.site] < 0.34)) h.human!.site = pickSite(sim, h);
    // hunts due in this slice
    for (const m of sim.monsters()) {
      const M = m.monster!;
      while (M.huntAt.length && M.huntAt[0] <= end && sim.ents.has(m.id)) {
        M.huntAt.shift();
        resolveHunt(sim, m, sum);
      }
      if (Math.hypot(m.x - M.lairX, m.z - M.lairZ) < 3 && isWounded(sim, m)) heal(sim, m, sim.maxHp(m) * 0.1 * f);
    }
    // food
    let eaters = 0;
    for (const h of sim.humans()) {
      if (h.id === sim.championId) continue;
      eaters++;
      if (h.faction === 'human' && onShift(sim, h)) sim.food += PRODUCTION[h.human!.job] * f * 0.85;
    }
    sim.food = Math.min(sim.foodCap, sim.food - (eaters * 10 * step) / DAY_MS);
    if (sim.food <= 0) {
      sim.food = 0;
      for (const h of sim.humans()) if (h.id !== sim.championId) applyDamage(sim, h, 4 * f, { type: 'hunger' });
    }
    const raidBefore = sim.raidUntil;
    sim.director.resolveAway(f, sum);
    sim.advanceClock(step);
    for (const e of [...sim.ents.values()]) if(e.unit?.mode === 'scatter') sim.remove(e);
    left -= step;
    // a raid began while you were away: every monster comes for the village once
    if (raiding(sim) && sim.raidUntil !== raidBefore) {
      sum.events.push('In the night, every monster on the island raided the village.');
      for (const m of sim.monsters()) if (m.state !== 'bound') resolveHunt(sim, m, sum);
    }
    sim.checkGameOver();
  }

  // 3. re-place everyone for the current hour
  for (const h of sim.humans()) {
    if (h.id === sim.championId) continue;
    const H = h.human!;
    if (onShift(sim, h) && H.site >= 0) {
      h.hidden = false;
      h.x = (H.site % SIZE) + 0.5;
      h.z = ((H.site / SIZE) | 0) + 0.5;
      h.state = 'work';
    } else {
      const home = sim.ents.get(H.homeId);
      h.hidden = !onShift(sim, h);
      if (home) {
        const d = h.hidden ? home : doorOf(sim, home);
        h.x = d.x;
        h.z = d.z;
      }
      h.state = h.hidden ? 'sleep' : 'idle';
    }
  }
  for (const m of sim.monsters()) {
    if (m.state === 'bound') continue;
    m.x = m.monster!.lairX;
    m.z = m.monster!.lairZ + 1;
    m.state = 'rest';
  }

  for (const h of sim.humans()) if(h.tags.includes('turncoat')) {leaveHouse(sim,h);h.state='idle';}
  sum.foodAfter = Math.round(sim.food);
  for (const e of sim.out.events.slice(evStart)) {
    if (e.kind === 'judgment') sum.judgments.push(e.text);
    else if (e.kind === 'omen' || e.kind === 'growth' || e.kind === 'champion' || e.kind === 'gameover') sum.events.push(e.text);
  }
  cs(sim).epoch++; // the resolver may have moved the champion: stale client poses are dropped (F6)
  cs(sim).trail = [];
  return sum;
}

function siteXZ(h: Entity) {
  const s = h.human!.site;
  return s >= 0 ? { x: (s % SIZE) + 0.5, z: ((s / SIZE) | 0) + 0.5 } : { x: h.x, z: h.z };
}

function resolveHunt(sim: Sim, m: Entity, sum: AwaySummary) {
  const M = m.monster!;
  const V = sim.layout.village;
  const roam = Math.min(90, 30 + 4 * boldness(sim));
  const raid = isEnraged(sim, m) || raiding(sim);
  const champ = sim.champion();
  const cands: { h: Entity; w: number; near: boolean }[] = [];
  for (const h of sim.humans()) {
    if (h.id === sim.championId || h.faction !== 'human') continue;
    const p = siteXZ(h);
    const near = Math.hypot(p.x - V.x, p.z - V.z) < 12 + sim.layout.wallRadius;
    if (!raid) {
      if (!onShift(sim, h) || h.human!.site < 0) continue;
      if (Math.hypot(p.x - M.lairX, p.z - M.lairZ) > roam) continue;
    }
    cands.push({ h, w: h.level + 1, near });
  }
  if (!cands.length) {
    const a = [...sim.ents.values()].find((x) => x.kind === 'animal' && Math.hypot(x.x - M.lairX, x.z - M.lairZ) < roam);
    if (a) sacrificeOffline(sim, m, a, sum);
    return;
  }
  let total = 0;
  for (const c of cands) total += c.w;
  let r = sim.rng.next() * total;
  let pick = cands[0];
  for (const c of cands) if ((r -= c.w) <= 0) { pick = c; break; }
  const p = raid ? 0.35 : pick.near ? 0.2 : 0.35;
  if (raid && champ) {
    applyDamage(sim, m, Math.max(0, Math.min(sim.maxHp(m) * 0.25, m.hp - sim.maxHp(m) * 0.3)), { type: 'slash', sourceId: champ.id });
    sum.events.push(`${firstName(m)} raided the village; your champion wounded it.`);
  }
  if (sim.rng.chance(p)) {
    for (const l of sim.listeners) l.onCapture?.(m, pick.h);
    sacrificeOffline(sim, m, pick.h, sum);
  } else if (sim.rng.chance(0.3)) {
    const dmg = Math.max(0, Math.min(sim.maxHp(m) * 0.15, m.hp - sim.maxHp(m) * 0.3));
    if (dmg > 0) applyDamage(sim, m, dmg, { type: 'pierce' });
  }
}

function sacrificeOffline(sim: Sim, m: Entity, v: Entity, sum: AwaySummary) {
  const A = sim.layout.highAltar;
  const value = Math.round(sim.maxHp(v) * (v.kind === 'animal' ? 0.25 : 1));
  const name = v.name ?? v.animal?.species ?? v.kind;
  v.x = A.x + 0.5;
  v.z = A.z + 1.2;
  v.hidden = false;
  kill(sim, v, { amount: 999, type: 'pierce', sourceId: m.id, sourceKind: 'monster', deathType: 'impaled' });
  offerFavor(sim, 'monster', value, 'high', v.kind === 'human' ? 'human' : v.animal?.species ?? v.kind);
  gainXp(sim, m, 75);
  sim.stats.monsterSacrifices++;
  sum.favor.monster += value;
  if (v.kind === 'human') {
    const t = `While you were away, ${name} was dragged to the High Place by ${m.name} and sacrificed to ${GOD_NAME.monster}.`;
    sum.deaths.push(t);
    sim.log(t, 2, 'core', 'away');
  }
}
