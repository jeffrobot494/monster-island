import type { Sim, BehaviorEntry } from '../sim';
import type { Entity } from '../types';
import { hostile } from '../team';
import { leaveHouse, meleeFight } from '../village';
import { addTag, removeTag } from './entity-effects';
export function convert(sim: Sim, e: Entity, key: string) {
  e.faction = 'monster';
  addTag(e, 'turncoat', key);
  addTag(e, 'hittable', key);
  (e.fx ??= []).push({ id: 'turncoat', key });
  leaveHouse(sim, e);
  e.state = 'idle';
  e.target = -1;
  sim.stop(e);
  sim.log(`${e.name} answers Dagon's whisper.`, 2, 'core', 'omen');
}
export function revert(sim: Sim, e: Entity, key: string) {
  if (!e.inhabitant || e.hp <= 0) return;
  removeTag(e, 'turncoat', key);
  removeTag(e, 'hittable', key);
  e.fx = e.fx?.filter((f) => f.key !== key);
  if (e.tags.includes('turncoat')) return;
  e.faction = 'human';
  e.state = 'idle';
  e.target = -1;
  sim.stop(e);
  sim.emote(e, '🙏', 2);
}
export function surrender(sim: Sim, e: Entity) {
  for (const key of [...(e.eventTagOwners?.turncoat ?? [])])
    revert(sim, e, key);
  sim.log(
    `${e.name} throws down their tools and begs forgiveness.`,
    2,
    'core',
    'omen',
  );
}
export function turncoatBehavior(sim: Sim): BehaviorEntry {
  return {
    id: 'turncoat',
    owner: 'core',
    score: () => 100,
    appliesTo: (e) => e.tags.includes('turncoat') && e.faction === 'monster',
    act(e) {
      leaveHouse(sim, e);
      const target = [...sim.ents.values()]
        .filter(
          (t) =>
            hostile(e, t) &&
            !t.hidden &&
            !['downed', 'bound', 'captive'].includes(t.state) &&
            sim.dist(e, t) < 8,
        )
        .sort((a, b) => sim.dist(e, a) - sim.dist(e, b))[0];
      if (target) {
        e.target = target.id;
        e.state = 'fight';
        meleeFight(sim, e, target);
        return;
      }
      e.target = -1;
      const leader = sim
        .monsters()
        .sort((a, b) => sim.dist(e, a) - sim.dist(e, b))[0];
      const dest =
        leader && sim.dist(e, leader) < 30
          ? leader
          : leader?.monster
            ? { x: leader.monster.lairX, z: leader.monster.lairZ }
            : sim.layout.highAltar;
      if (sim.dist(e, dest) > 3) {
        if (!sim.moving(e) || sim.tick % 30 === e.id % 30)
          sim.goTo(e, dest.x, dest.z);
        sim.advancePath(e, sim.stat(e, 'speed'));
      } else sim.stop(e);
    },
  };
}
