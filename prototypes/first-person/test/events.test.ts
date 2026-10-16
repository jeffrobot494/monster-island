import { EVENTS } from '../src/sim/events/defs';
import { primitives } from '../src/sim/events/primitives';
import { afterEach, describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { EventDirector } from '../src/sim/events/director';
import type { EventDef } from '../src/sim/events/types';
import { HOUR_MS, nextHour } from '../src/sim/clock';
import { serializeCore, deserializeCore } from '../src/sim/serialize';
import { resolveAway } from '../src/sim/offline';
import { START } from './helpers';
const mark = {
  parse() {},
  apply({ sim }: { sim: Sim }) {
    sim.timber++;
  },
  remove({ sim }: { sim: Sim }) {
    sim.timber--;
  },
};
const definition = (id = 'test'): EventDef => ({
  id,
  title: id,
  announce: id,
  start: { atHour: 14 },
  duration: { untilHour: 9 },
  stacking: 'skip',
  effects: [{ type: 'mark' }],
});
afterEach(() => {
  EVENTS.splice(
    EVENTS.findIndex((d) => d.id === 'test'),
    2,
  );
  delete primitives.mark;
});
function make() {
  EVENTS.push(definition(), definition('other'));
  primitives.mark = mark;
  const sim = new Sim(31);
  sim.generate(START, 180);
  sim.judgmentEnabled = false;
  sim.director = new EventDirector(sim, [definition(), definition('other')], {
    mark,
  });
  sim.deck = {
    order: ['test', 'other'],
    mode: 'sequential',
    onExhausted: 'loop',
  };
  return sim;
}
describe('night event lifecycle', () => {
  it('refresh extends without applying twice and retains selected targets', () => {
    const s = make();
    s.director.defs[0] = {
      ...s.director.defs[0],
      start: 'now',
      duration: { hours: 2 },
      stacking: 'refresh',
    };
    const id = s.director.fire('test');
    s.advanceClock(HOUR_MS);
    s.director.fire('test');
    expect(s.timber).toBe(1);
    expect(s.events.active).toHaveLength(1);
    expect(s.events.active[0].iid).toBe(id);
    expect(s.events.active[0].endAt).toBe(START + 3 * HOUR_MS);
    s.advanceClock(2 * HOUR_MS);
    expect(s.timber).toBe(0);
  });

  it('draws only on monster wins, skips still spend draws, and loops', () => {
    const s = make();
    s.director.onVerdict(null);
    s.director.onVerdict('human');
    expect(s.events.deckPos).toBe(0);
    s.director.onVerdict('monster');
    s.director.onVerdict('monster');
    s.director.onVerdict('monster');
    expect(s.events.deckPos).toBe(1);
    expect(s.events.active).toHaveLength(2);
    s.deck.order = [];
    s.director.onVerdict('monster');
    expect(s.events.active).toHaveLength(2);
  });
  it('starts and ends at hour boundaries including offline catch-up', () => {
    const s = make();
    s.director.fire('test');
    expect(s.timber).toBe(0);
    resolveAway(s, 6 * HOUR_MS, 0);
    expect(s.events.active[0].phase).toBe('active');
    expect(s.timber).toBe(1);
    s.advanceClock(19 * HOUR_MS);
    expect(s.events.active).toHaveLength(0);
    expect(s.timber).toBe(0);
  });
  it('saves armed and active state without reapplying effects', () => {
    const s = make();
    s.director.fire('test');
    const armed = deserializeCore(serializeCore(s));
    armed.director = new EventDirector(armed, s.director.defs, { mark });
    expect(armed.events).toEqual(s.events);
    armed.advanceClock(6 * HOUR_MS);
    const active = deserializeCore(serializeCore(armed));
    active.director = new EventDirector(active, s.director.defs, { mark });
    expect(active.timber).toBe(1);
    active.director.update();
    expect(active.timber).toBe(1);
    active.advanceClock(19 * HOUR_MS);
    expect(active.timber).toBe(0);
  });
  it('persists shuffled order and strictly-next fractional hours', () => {
    const s = make();
    s.deck.mode = 'shuffle';
    s.director.onVerdict('monster');
    expect(deserializeCore(serializeCore(s)).events.deckOrder).toEqual(
      s.events.deckOrder,
    );
    expect(nextHour(14 * HOUR_MS, 14)).toBe(38 * HOUR_MS);
    expect(nextHour(14 * HOUR_MS, 14.5)).toBe(14.5 * HOUR_MS);
  });
});
