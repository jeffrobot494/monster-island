import { champThrow, setSpears, stepSpear } from '../src/sim/spears';
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { EVENTS } from '../src/sim/events/defs';
import { HOUR_MS, nextHour } from '../src/sim/clock';
import { serializeCore, deserializeCore } from '../src/sim/serialize';
import { applyDamage, gainXp, levelUp } from '../src/sim/combat';
import { monsterWindows, stepMonster } from '../src/sim/monster-ai';
import { foodTick, nearestThreat, stepHuman } from '../src/sim/village';
import { convert } from '../src/sim/events/turncoat';
import { stepUnit, stealFood } from '../src/sim/events/units';
import { resolveAway } from '../src/sim/offline';
import { hostile } from '../src/sim/team';
import { START } from './helpers';
function make() {
  const s = new Sim(31);
  s.generate(START, 180);
  s.judgmentEnabled = false;
  return s;
}
function dawn(s: Sim) {
  s.advanceClock(nextHour(s.clockMs, 6) - s.clockMs);
}
describe('night event effects', () => {
  it('champion spears hit turncoats and guards fight jackals', () => {
    const s = make(),
      c = s.champion()!;
    const t = s.humans().find((h) => h.id !== c.id)!;
    convert(s, t, 'event:test');
    t.x = c.x;
    t.z = c.z + 1;
    t.hidden = false;
    const before = t.hp;
    setSpears(c, 1);
    expect(
      champThrow(s, c, { yaw: 0, pitch: 0, targetId: t.id, zone: 'torso' }),
    ).toBeNull();
    const spear = [...s.ents.values()].find((e) => e.spear?.st === 'flying')!;
    for (let i = 0; i < 30 && spear.spear?.st === 'flying'; i++) {
      s.tick++;
      stepSpear(s, spear);
    }
    expect(t.hp).toBeLessThan(before);
    s.director.fire('jackals');
    const jackal = [...s.ents.values()].find((e) => e.unit)!;
    const guard = s
      .humans()
      .find((e) => e.faction === 'human' && e.human!.job === 'guard')!;
    guard.x = s.layout.village.x;
    guard.z = s.layout.village.z;
    guard.hidden = false;
    jackal.x = guard.x;
    jackal.z = guard.z + 0.05;
    guard.human!.attackReadyAt = 0;
    const hp = jackal.hp;
    stepHuman(s, guard);
    expect(jackal.hp).toBeLessThan(hp);
  });
  it('Frenzy recovers into stalking and expires at dawn', () => {
    const s = make();
    const m = s.monsters()[0];
    s.director.fire('frenzy');
    m.state = 'downed';
    m.monster!.downedAt = 0;
    s.tick = 1201;
    stepMonster(s, m);
    expect(m.state).toBe('stalk');
    expect(m.monster!.prey).toBeGreaterThan(0);
    dawn(s);
    expect(m.tags).not.toContain('no-retreat');
  });

  it('validates all five definitions and rejects bad parameters', () => {
    const s = make();
    for (const d of EVENTS) s.director.validate(d);
    expect(() =>
      s.director.validate({
        ...EVENTS[0],
        effects: [{ type: 'clockRate', from: 16, to: 6, rate: 0 }],
      }),
    ).toThrow();
  });
  it('Frenzy stacks without losing tags or stats when removed in either order', () => {
    for (const reverse of [false, true]) {
      const s = make(),
        m = s.monsters()[0],
        speed = s.stat(m, 'speed');
      s.director.defs = EVENTS.map((d) =>
        d.id === 'frenzy' ? { ...d, stacking: 'stack' } : d,
      );
      const a = s.director.fire('frenzy'),
        b = s.director.fire('frenzy');
      expect(s.stat(m, 'speed')).toBeCloseTo(speed * 2.25);
      s.director.end(reverse ? b : a);
      expect(m.tags).toContain('no-retreat');
      expect(s.stat(m, 'speed')).toBeCloseTo(speed * 1.5);
      s.director.end(reverse ? a : b);
      expect(m.tags).not.toContain('no-retreat');
      expect(s.stat(m, 'speed')).toBe(speed);
      expect(m.fx).toEqual([]);
    }
  });
  it('Ascension grows the strongest, survives level-up and reload, then chooses another', () => {
    const s = make(),
      strong = s
        .monsters()
        .sort(
          (a, b) => s.maxHp(b) - s.maxHp(a) || b.level - a.level || a.id - b.id,
        )[0];
    const hp = s.maxHp(strong),
      scale = strong.scale;
    s.director.fire('ascension');
    expect(s.maxHp(strong)).toBe(hp * 10);
    expect(strong.hp).toBe(hp * 10);
    expect(strong.scale).toBeCloseTo(scale * 1.4);
    expect(strong.name).toContain('the Ascended');
    levelUp(s, strong);
    expect(strong.scale).toBeCloseTo(scale * 1.4 * 1.05);
    expect(strong.zones!.torso!.max).toBeCloseTo(s.maxHp(strong) * 0.4);
    const restored = deserializeCore(serializeCore(s));
    expect(restored.maxHp(restored.ents.get(strong.id)!)).toBe(s.maxHp(strong));
    restored.director.fire('ascension');
    expect(
      restored.monsters().filter((m) => m.tags.includes('ascended')),
    ).toHaveLength(2);
  });
  it('Long Night darkens, slows the clock, widens late-game windows and ends cleanly', () => {
    const s = make();
    s.director.fire('long-night');
    s.advanceClock(9 * HOUR_MS);
    expect(s.computeLight()).toBeCloseTo(0.05);
    expect(s.night.clockRate).toBe(0.6);
    const before = s.clockMs;
    s.step();
    expect(s.clockMs - before).toBeCloseTo(s.msPerTick * 0.6);
    expect(s.director.realMsUntil(nextHour(s.clockMs, 0))).toBeCloseTo(
      (nextHour(s.clockMs, 0) - s.clockMs) / s.timescale / 0.6,
    );
    const saved = deserializeCore(serializeCore(s));
    expect(saved.night.clockRate).toBe(0.6);
    s.createdClock -= 20 * 24 * HOUR_MS;
    const m = s.monsters()[0];
    m.monster!.hours = 'night';
    expect(monsterWindows(s, m)).toEqual([[0, 0]]);
    s.advanceClock(nextHour(s.clockMs, 9) - s.clockMs);
    expect(s.night.clockRate).toBe(1);
    expect(s.night.darkness).toBe(0);
  });
  it('food production and consumption per clock hour do not change under dilation', () => {
    const a = make(),
      b = make();
    a.food = b.food = 200;
    b.night.clockRate = 0.6;
    b.dtMs = b.msPerTick * 0.6;
    for (let i = 0; i < 60; i++) foodTick(a);
    for (let i = 0; i < 100; i++) foodTick(b);
    expect(a.food).toBeCloseTo(b.food, 8);
  });
  it('jackals share a theft cap, die without downing or XP, and scatter when the leader dies', () => {
    const s = make();
    s.director.fire('jackals');
    const units = [...s.ents.values()].filter((e) => e.unit);
    expect(units.length).toBeGreaterThanOrEqual(12);
    expect(units.length).toBeLessThanOrEqual(24);
    const u = units[0],
      iid = u.unit!.iid;
    s.food = 500;
    for (let i = 0; i < 100; i++) stealFood(s, iid, 8);
    expect(s.food).toBe(350);
    gainXp(s, u, 1000);
    expect(u.level).toBe(1);
    applyDamage(s, u, 17, { type: 'hunger' });
    expect(u.state).not.toBe('downed');
    applyDamage(s, u, 3, { type: 'hunger' });
    expect(s.ents.has(u.id)).toBe(false);
    const other = units[1];
    s.remove(s.ents.get(other.unit!.leader)!);
    stepUnit(s, other);
    expect(other.unit!.mode).toBe('scatter');
    s.tick += 51;
    stepUnit(s, other);
    expect(s.ents.has(other.id)).toBe(false);
    const loaded = deserializeCore(serializeCore(s));
    expect([...loaded.ents.values()].filter((e) => e.unit).length).toBe(
      units.length - 2,
    );
    dawn(s);
    for (const e of [...s.ents.values()])
      if (e.unit) {
        s.tick += 51;
        stepUnit(s, e);
      }
    expect([...s.ents.values()].some((e) => e.unit)).toBe(false);
  });
  it('turncoats retain villager bodies, become hostile, surrender on nonlethal damage and revert at dawn', () => {
    const s = make();
    const id = s.director.fire('turncoats');
    const turned = s.humans().filter((h) => h.tags.includes('turncoat'));
    expect(turned.length).toBeGreaterThanOrEqual(2);
    expect(turned.length).toBeLessThanOrEqual(3);
    expect(turned.some((e) => e.id === s.championId)).toBe(false);
    const t = turned[0],
      c = s.champion()!;
    expect(hostile(c, t)).toBe(true);
    expect(t.hidden).toBe(false);
    applyDamage(s, t, s.maxHp(t) * 0.81, { type: 'hunger', sourceId: c.id });
    expect(t.faction).toBe('human');
    expect(t.state).toBe('idle');
    expect(t.tags).not.toContain('hittable');
    const lethal = turned[1];
    applyDamage(s, lethal, 1e6, { type: 'hunger', sourceId: c.id });
    expect(s.ents.has(lethal.id)).toBe(false);
    s.director.end(id);
    expect(s.humans().some((e) => e.faction === 'monster')).toBe(false);
  });
  it('turncoats fight villagers and stay villagers for game-over; guards detect hostile bodies', () => {
    const s = make(),
      c = s.champion()!,
      t = s.humans().find((h) => h.id !== c.id)!;
    convert(s, t, 'event:test');
    t.x = c.x;
    t.z = c.z + 0.01;
    t.human!.attackReadyAt = 0;
    const before = c.hp;
    s.behaviors[0].act(t);
    expect(c.hp).toBeLessThan(before);
    expect(nearestThreat(s, c, 2)?.id).toBe(t.id);
    for (const h of s.humans()) if (h.id !== c.id && h !== t) s.remove(h);
    s.checkGameOver();
    expect(s.gameOver).toBeNull();
  });
  it('offline dawn removes packs and reverts turncoats', () => {
    const s = make();
    s.director.fire('jackals');
    s.director.fire('turncoats');
    resolveAway(s, 23 * HOUR_MS, 60_000);
    expect([...s.ents.values()].some((e) => e.unit)).toBe(false);
    expect(s.humans().some((e) => e.faction === 'monster')).toBe(false);
  });
});
