import type { Sim } from '../sim';
import { HOUR_MS, nextHour, inWindow, hourOf } from '../clock';
import { noNightMods } from '../night';
import type { AwaySummary } from '../offline';
import { EVENTS } from './defs';
import type { EventDef, EventInstance } from './types';
import { resolveSelector } from './select';
import { primitives, type Primitive } from './primitives';
export class EventDirector {
  constructor(
    private sim: Sim,
    public defs: EventDef[] = EVENTS,
    public registry: Record<string, Primitive> = primitives,
  ) {}
  definition(id: string) {
    const def = this.defs.find((d) => d.id === id);
    if (!def) throw new Error(`Unknown event: ${id}`);
    return def;
  }
  validate(def: EventDef) {
    if (
      def.start !== 'now' &&
      (!Number.isFinite(def.start.atHour) ||
        def.start.atHour < 0 ||
        def.start.atHour >= 24)
    )
      throw new Error('Invalid start hour');
    if (def.duration !== 'permanent') {
      if (
        'hours' in def.duration &&
        (!Number.isFinite(def.duration.hours) || def.duration.hours <= 0)
      )
        throw new Error('Invalid duration');
      if (
        'untilHour' in def.duration &&
        (!Number.isFinite(def.duration.untilHour) ||
          def.duration.untilHour < 0 ||
          def.duration.untilHour >= 24)
      )
        throw new Error('Invalid end hour');
    }
    if (
      def.duration !== 'permanent' &&
      def.effects.some((e) => e.type === 'rename')
    )
      throw new Error('Rename requires a permanent event');
    for (const effect of def.effects) {
      const primitive = this.registry[effect.type];
      if (!primitive) throw new Error(`Unknown primitive: ${effect.type}`);
      if (effect.who && !def.targets?.[effect.who])
        throw new Error(`Unknown target set: ${effect.who}`);
      primitive.parse(effect);
    }
  }
  private context(inst: EventInstance, i: number) {
    return {
      sim: this.sim,
      inst,
      i,
      key: `event:${inst.iid}`,
      rng: this.sim.rng,
    };
  }
  private endAt(def: EventDef, start: number) {
    const d = def.duration;
    return d === 'permanent'
      ? null
      : 'hours' in d
        ? start + d.hours * HOUR_MS
        : nextHour(start, 'untilHour' in d ? d.untilHour : 6);
  }
  onVerdict(winner: 'human' | 'monster' | null) {
    if (winner !== 'monster') return;
    const { events: s, deck } = this.sim;
    if (!deck.order.length) {
      this.log('The night passes without an omen.');
      return;
    }
    if (!s.deckOrder.length) this.resetOrder();
    if (s.deckPos >= s.deckOrder.length) {
      if (deck.onExhausted === 'stop') {
        this.log('The omens are exhausted.');
        return;
      }
      if (deck.onExhausted === 'repeatLast') s.deckPos = s.deckOrder.length - 1;
      else this.resetOrder();
    }
    this.fire(s.deckOrder[s.deckPos++]);
  }
  private resetOrder() {
    const s = this.sim.events;
    s.deckPos = 0;
    s.deckOrder = [...this.sim.deck.order];
    if (this.sim.deck.mode === 'shuffle')
      for (let i = s.deckOrder.length - 1; i > 0; i--) {
        const j = this.sim.rng.int(0, i);
        [s.deckOrder[i], s.deckOrder[j]] = [s.deckOrder[j], s.deckOrder[i]];
      }
  }
  fire(id: string) {
    const def = this.definition(id);
    this.validate(def);
    const s = this.sim.events,
      now = this.sim.clockMs;
    const start = def.start === 'now' ? now : nextHour(now, def.start.atHour);
    const existing = s.active.find((a) => a.def === id);
    if (existing && def.stacking !== 'stack') {
      if (def.stacking === 'refresh') {
        if (existing.phase === 'armed')
          existing.startAt = Math.max(existing.startAt, start);
        else {
          const end = this.endAt(def, start);
          existing.endAt =
            existing.endAt === null || end === null
              ? null
              : Math.max(existing.endAt, end);
        }
      }
      return existing.iid;
    }
    const inst: EventInstance = {
      iid: s.nextIid++,
      def: id,
      phase: 'armed',
      startAt: start,
      endAt: null,
      targets: {},
      state: def.effects.map(() => ({})),
    };
    s.active.push(inst);
    s.history.push({ iid: inst.iid, def: id, day: this.sim.day });
    if (def.armText && start > now) this.announce(def.armText);
    this.update(false);
    return inst.iid;
  }
  end(iid: number) {
    const s = this.sim.events,
      inst = s.active.find((a) => a.iid === iid);
    if (!inst) return;
    const def = this.definition(inst.def);
    if (inst.phase === 'active')
      for (let i = def.effects.length - 1; i >= 0; i--) {
        const effect = def.effects[i];
        this.registry[effect.type].remove?.(
          this.context(inst, i),
          effect,
          inst.targets[effect.who ?? ''] ?? [],
        );
      }
    s.active = s.active.filter((a) => a.iid !== iid);
    const history = s.history.find((h) => h.iid === iid);
    if (history) history.endedDay = this.sim.day;
    if (def.endText) this.log(def.endText);
    this.restore();
  }
  update(live = true) {
    for (const inst of [...this.sim.events.active]) {
      const def = this.definition(inst.def);
      if (inst.phase === 'armed' && inst.startAt <= this.sim.clockMs) {
        for (const [name, sel] of Object.entries(def.targets ?? {}))
          inst.targets[name] = resolveSelector(this.sim, sel, this.sim.rng);
        if (
          def.effects.length > 0 &&
          def.effects.every((e) => !!e.who) &&
          Object.values(inst.targets).every((ids) => !ids.length)
        ) {
          this.log("Dagon's curse finds no one.");
          this.end(inst.iid);
          continue;
        }
        inst.phase = 'active';
        inst.endAt = this.endAt(def, inst.startAt);
        for (let i = 0; i < def.effects.length; i++) {
          const effect = def.effects[i];
          this.registry[effect.type].apply?.(
            this.context(inst, i),
            effect,
            inst.targets[effect.who ?? ''] ?? [],
          );
        }
        this.announce(def.announce);
      }
      if (inst.phase !== 'active') continue;
      if (inst.endAt !== null && inst.endAt <= this.sim.clockMs) {
        this.end(inst.iid);
        continue;
      }
      if (live)
        for (let i = 0; i < def.effects.length; i++) {
          const effect = def.effects[i];
          this.registry[effect.type].tick?.(
            this.context(inst, i),
            effect,
            inst.targets[effect.who ?? ''] ?? [],
          );
        }
    }
    this.restore();
  }
  restore() {
    const g = noNightMods();
    for (const inst of this.sim.events.active)
      if (inst.phase === 'active')
        this.definition(inst.def).effects.forEach((effect, i) =>
          this.registry[effect.type].global?.(this.context(inst, i), effect, g),
        );
    this.sim.night = g;
    const atmosphere = {
      ...g.atmosphere,
      darkness: Math.max(g.atmosphere.darkness ?? 0, g.darkness),
    };
    if (JSON.stringify(atmosphere) !== JSON.stringify(this.sim.atmosphere)) {
      this.sim.atmosphere = atmosphere;
      this.sim.out.atmosphereDirty = true;
    }
  }
  resolveAway(hours: number, sum: AwaySummary) {
    for (const inst of this.sim.events.active)
      if (inst.phase === 'active')
        this.definition(inst.def).effects.forEach((effect, i) =>
          this.registry[effect.type].away?.(
            this.context(inst, i),
            effect,
            hours,
            sum,
          ),
        );
  }
  realMsUntil(end: number) {
    const now = this.sim.clockMs,
      cuts = new Set([now, end]);
    const windows: {
      start: number;
      end: number;
      from: number;
      to: number;
      rate: number;
    }[] = [];
    for (const inst of this.sim.events.active) {
      const def = this.definition(inst.def),
        start = inst.startAt,
        stop = inst.phase === 'armed' ? this.endAt(def, start) : inst.endAt;
      for (const e of def.effects)
        if (e.type === 'clockRate') {
          windows.push({
            start,
            end: stop ?? Infinity,
            from: e.from as number,
            to: e.to as number,
            rate: e.rate as number,
          });
          if (start > now && start < end) cuts.add(start);
          if (stop !== null && stop > now && stop < end) cuts.add(stop);
          for (const hour of [e.from as number, e.to as number])
            for (let t = nextHour(now, hour); t < end; t += 24 * HOUR_MS)
              cuts.add(t);
        }
    }
    const points = [...cuts].sort((a, b) => a - b);
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const at = (points[i - 1] + points[i]) / 2;
      let rate = 1;
      for (const w of windows)
        if (at >= w.start && at < w.end && inWindow(hourOf(at), w.from, w.to))
          rate = Math.min(rate, w.rate);
      total += (points[i] - points[i - 1]) / rate;
    }
    return total / this.sim.timescale;
  }
  list() {
    return this.sim.events.active.map((inst) => ({
      iid: inst.iid,
      id: inst.def,
      title: this.definition(inst.def).title,
      phase: inst.phase,
      at: inst.phase === 'armed' ? inst.startAt : inst.endAt,
    }));
  }
  private log(text: string) {
    this.sim.log(text, 2, 'core', 'omen');
  }
  private announce(text: string) {
    this.log(text);
    this.sim.alert({ kind: 'omen', text });
  }
}
