import type { Sim } from '../sim';
import type { Rng } from '../rng';
import type { Selector } from './types';
export function resolveSelector(sim: Sim, sel: Selector, rng: Rng): number[] {
  let candidates = [...sim.ents.values()].filter(
    (e) =>
      e.inhabitant &&
      e.hp > 0 &&
      (!sel.kind || e.kind === sel.kind) &&
      (!sel.faction || e.faction === sel.faction) &&
      (sel.includeChampion || e.id !== sim.championId) &&
      (sel.includeHidden || !e.hidden) &&
      (sel.includeIncapacitated ||
        (!['downed', 'bound', 'captive', 'carry', 'sacrifice', 'dead'].includes(
          e.state,
        ) &&
          e.carriedBy === undefined)) &&
      (!sel.jobs || (!!e.human && sel.jobs.includes(e.human.job))) &&
      (!sel.excludeJobs ||
        !e.human ||
        !sel.excludeJobs.includes(e.human.job)) &&
      (!sel.withTag || e.tags.includes(sel.withTag)) &&
      (!sel.withoutTag || !e.tags.includes(sel.withoutTag)),
  );
  if (sel.pick === 'strongest')
    candidates.sort(
      (a, b) => sim.maxHp(b) - sim.maxHp(a) || b.level - a.level || a.id - b.id,
    );
  if (sel.pick === 'random')
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
  let count = candidates.length;
  if (sel.count !== undefined)
    count = Array.isArray(sel.count) ? rng.int(...sel.count) : sel.count;
  if (sel.fraction !== undefined) {
    const f = Array.isArray(sel.fraction)
      ? sel.fraction[0] + rng.next() * (sel.fraction[1] - sel.fraction[0])
      : sel.fraction;
    count = Math.max(sel.min ?? 0, Math.floor(candidates.length * f));
  }
  return candidates.slice(0, Math.max(0, count)).map((e) => e.id);
}
