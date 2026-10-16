import { spawnUnit, scatterUnit, stealFood } from './units';
import { convert, revert } from './turncoat';
import type { Entity, Stat } from '../types';
import { rescaleZones } from '../combat';
import { ARCH } from '../monsters-gen';
import { hourOf, inWindow } from '../clock';
import { rollHunts } from '../monster-ai';
import { addTag, removeTag, scaleMul } from './entity-effects';
import type { Sim } from '../sim';
import type { Rng } from '../rng';
import type { NightMods } from '../night';
import type { AwaySummary } from '../offline';
import type { EffectSpec, EventInstance } from './types';
export interface Ctx {
  sim: Sim;
  inst: EventInstance;
  i: number;
  key: string;
  rng: Rng;
}
export interface Primitive {
  parse(spec: EffectSpec): void;
  apply?(ctx: Ctx, spec: EffectSpec, ids: number[]): void;
  tick?(ctx: Ctx, spec: EffectSpec, ids: number[]): void;
  remove?(ctx: Ctx, spec: EffectSpec, ids: number[]): void;
  global?(ctx: Ctx, spec: EffectSpec, g: NightMods): void;
  away?(ctx: Ctx, spec: EffectSpec, hours: number, sum: AwaySummary): void;
}
export const primitives: Record<string, Primitive> = {};

function number(p: EffectSpec, k: string, fallback?: number): number {
  const n = p[k] ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new Error(`Invalid ${p.type}.${k}`);
  return n;
}
function text(p: EffectSpec, k: string): string {
  if (typeof p[k] !== 'string' || !p[k])
    throw new Error(`Invalid ${p.type}.${k}`);
  return p[k];
}
function each(c: Ctx, ids: number[], fn: (e: Entity) => void) {
  for (const id of ids) {
    const e = c.sim.ents.get(id);
    if (e?.inhabitant && e.hp > 0) fn(e);
  }
}
function statChange(c: Ctx, p: EffectSpec, ids: number[], remove = false) {
  each(c, ids, (e) => {
    const stat = p.stat as Stat;
    const before = c.sim.maxHp(e);
    const mods = (e.mods[stat] ??= {});
    if (remove) delete mods[c.key];
    else mods[c.key] = { mul: number(p, 'mul', 1), add: number(p, 'add', 0) };
    if (stat === 'maxHp') {
      e.hp = Math.min(c.sim.maxHp(e), (e.hp * c.sim.maxHp(e)) / before);
      rescaleZones(c.sim, e);
    }
  });
}
primitives.statMod = {
  parse(p) {
    if (!['maxHp', 'speed', 'strength', 'sight'].includes(text(p, 'stat')))
      throw new Error('Invalid stat');
    if (number(p, 'mul', 1) <= 0) throw new Error('Invalid multiplier');
    number(p, 'add', 0);
  },
  apply: statChange,
  remove: (c, p, ids) => statChange(c, p, ids, true),
};
primitives.tag = {
  parse(p) {
    text(p, 'tag');
  },
  apply(c, p, ids) {
    each(c, ids, (e) => addTag(e, text(p, 'tag'), c.key));
  },
  remove(c, p, ids) {
    each(c, ids, (e) => removeTag(e, text(p, 'tag'), c.key));
  },
};
primitives.fx = {
  parse(p) {
    if (!['frenzy', 'ascended', 'turncoat'].includes(text(p, 'fx')))
      throw new Error('Invalid fx');
  },
  apply(c, p, ids) {
    each(c, ids, (e) => (e.fx ??= []).push({ id: text(p, 'fx'), key: c.key }));
  },
  remove(c, p, ids) {
    each(c, ids, (e) => {
      e.fx = e.fx?.filter((f) => f.key !== c.key);
    });
  },
};
primitives.scale = {
  parse(p) {
    if (number(p, 'mul') <= 0) throw new Error('Invalid scale');
  },
  apply(c, p, ids) {
    each(c, ids, (e) => {
      (e.scaleMods ??= {})[c.key] = number(p, 'mul');
      e.scale =
        ARCH[e.monster!.archetype].scale *
        Math.pow(1.05, e.level - 1) *
        scaleMul(e);
    });
  },
  remove(c, p, ids) {
    each(c, ids, (e) => {
      delete e.scaleMods?.[c.key];
      e.scale =
        ARCH[e.monster!.archetype].scale *
        Math.pow(1.05, e.level - 1) *
        scaleMul(e);
    });
  },
};
primitives.rename = {
  parse(p) {
    text(p, 'pattern');
  },
  apply(c, p, ids) {
    each(c, ids, (e) => {
      e.name = text(p, 'pattern').replace('{name}', e.name ?? e.kind);
    });
  },
};
primitives.healFull = {
  parse() {},
  apply(c, p, ids) {
    each(c, ids, (e) => {
      e.hp = c.sim.maxHp(e);
      for (const z of Object.values(e.zones ?? {})) {
        z.state = 'ok';
        z.hp = z.max;
      }
    });
  },
};
primitives.darkness = {
  parse(p) {
    if (
      !Array.isArray(p.ramp) ||
      p.ramp.length < 2 ||
      p.ramp.some(
        (v) =>
          !Array.isArray(v) ||
          v.length !== 2 ||
          !v.every(Number.isFinite) ||
          v[0] < 0 ||
          v[0] >= 24 ||
          v[1] < 0 ||
          v[1] > 1,
      )
    )
      throw new Error('Invalid darkness ramp');
  },
  global(c, p, g) {
    const ramp = [...(p.ramp as [number, number][])].sort(
        (a, b) => a[0] - b[0],
      ),
      h = hourOf(c.sim.clockMs);
    for (let i = 0; i < ramp.length; i++) {
      const a = ramp[i],
        b = ramp[(i + 1) % ramp.length];
      const span = (b[0] - a[0] + 24) % 24,
        dt = (h - a[0] + 24) % 24;
      if (dt <= span) {
        g.darkness = Math.max(g.darkness, a[1] + ((b[1] - a[1]) * dt) / span);
        break;
      }
    }
  },
};
primitives.clockRate = {
  parse(p) {
    for (const k of ['from', 'to'])
      if (number(p, k) < 0 || number(p, k) >= 24)
        throw new Error('Invalid clock window');
    if (number(p, 'rate') <= 0 || number(p, 'rate') > 1)
      throw new Error('Invalid clock rate');
  },
  global(c, p, g) {
    if (inWindow(hourOf(c.sim.clockMs), number(p, 'from'), number(p, 'to')))
      g.clockRate = Math.min(g.clockRate, number(p, 'rate'));
  },
};
primitives.atmosphere = {
  parse(p) {
    if (p.fogDensity !== undefined && number(p, 'fogDensity') < 0)
      throw new Error('Invalid fog');
    if (p.fogColor !== undefined) text(p, 'fogColor');
    if (
      p.weather !== undefined &&
      !['none', 'rain', 'fog', 'ash'].includes(text(p, 'weather'))
    )
      throw new Error('Invalid weather');
  },
  global(c, p, g) {
    if (p.fogDensity !== undefined)
      g.atmosphere.fogDensity = Math.max(
        g.atmosphere.fogDensity ?? 0,
        number(p, 'fogDensity'),
      );
    if (p.fogColor !== undefined) g.atmosphere.fogColor = text(p, 'fogColor');
    if (p.weather !== undefined)
      g.atmosphere.weather = p.weather as 'none' | 'rain' | 'fog' | 'ash';
  },
};
primitives.windowBonus = {
  parse(p) {
    if (number(p, 'hours') < 0) throw new Error('Invalid bonus');
  },
  apply(c, p) {
    if (p.reroll) {
      c.sim.director.restore();
      for (const m of c.sim.monsters()) rollHunts(c.sim, m);
    }
  },
  global(c, p, g) {
    g.windowBonus = Math.max(g.windowBonus, number(p, 'hours'));
  },
};

primitives.spawnEscort = {
  parse(p) {
    if (p.unit !== 'jackal') throw new Error('Unknown unit');
    const count = p.count;
    if (
      !Array.isArray(count) ||
      count.length !== 2 ||
      count.some((n) => !Number.isInteger(n) || n < 0) ||
      count[0] > count[1]
    )
      throw new Error('Invalid escort count');
    if (number(p, 'maxFood') < 0 || number(p, 'awayFoodPerHour', 0) < 0)
      throw new Error('Invalid theft');
  },
  apply(c, p, ids) {
    const units: number[] = [];
    each(c, ids, (leader) => {
      const count = c.rng.int(...(p.count as [number, number]));
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const e = spawnUnit(
          c.sim,
          'jackal',
          leader.x + Math.sin(angle),
          leader.z + Math.cos(angle),
          leader.id,
          c.inst.iid,
        );
        if (c.sim.ents.has(e.id)) units.push(e.id);
      }
    });
    c.inst.state[c.i].units = units;
    c.inst.state[c.i].stolen = 0;
  },
  remove(c) {
    for (const id of (c.inst.state[c.i].units as number[]) ?? []) {
      const e = c.sim.ents.get(id);
      if (e) scatterUnit(c.sim, e);
    }
  },
  away(c, p, hours) {
    const ids = (c.inst.state[c.i].units as number[]) ?? [];
    let alive = false;
    for (const id of ids) {
      const e = c.sim.ents.get(id);
      if (!e?.unit) continue;
      if (!c.sim.ents.get(e.unit.leader)?.monster) {
        c.sim.remove(e);
        continue;
      }
      alive = true;
    }
    if (alive)
      stealFood(c.sim, c.inst.iid, number(p, 'awayFoodPerHour', 0) * hours);
  },
};
primitives.convert = {
  parse(p) {
    if (p.to !== 'monster' || p.brain !== 'turncoat' || p.fx !== 'turncoat')
      throw new Error('Unsupported conversion');
  },
  apply(c, p, ids) {
    each(c, ids, (e) => convert(c.sim, e, c.key));
  },
  remove(c, p, ids) {
    each(c, ids, (e) => {
      if (e.eventTagOwners?.turncoat?.includes(c.key)) revert(c.sim, e, c.key);
    });
  },
};
