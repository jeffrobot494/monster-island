import type { SavedWorld } from '../sim/island';
import type { ChronicleEvent } from '../sim/types';
import { REGION_NAMES } from '../sim/island-gen';

/** The ~2 KB summary a god reads, computed by the host so the model never reads raw state. */
export function observe(world: SavedWorld, chronicle: ChronicleEvent[]) {
  const core = world.core;
  const ents = core.ents;
  const humans = ents.filter((e) => e.kind === 'human');
  const monsters = ents.filter((e) => e.kind === 'monster');
  const jobs: Record<string, number> = {};
  for (const h of humans) jobs[h.human!.job] = (jobs[h.human!.job] ?? 0) + 1;
  const kinds: Record<string, number> = {};
  for (const e of ents) if (e.owner) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const tiles: Record<string, number> = {};
  for (const [t, n] of core.tiles) tiles[t] = (tiles[t] ?? 0) + n;
  const champ = humans.find((h) => h.id === core.championId);
  return {
    day: chronicle.length ? chronicle[chronicle.length - 1].day : 1,
    village: {
      villagers: humans.length - (champ ? 1 : 0),
      champion: champ ? { name: champ.name, level: champ.level, hp: Math.round(champ.hp) } : 'none (a new champion rises at dawn)',
      jobs,
      avgLevel: humans.length ? Math.round((humans.reduce((s, h) => s + h.level, 0) / humans.length) * 10) / 10 : 0,
      food: `${Math.round(core.food)} / 500`,
      lambsInFold: core.fold,
    },
    monsters: monsters.map((m) => ({
      name: m.name, kind: m.monster!.archetype, level: m.level, hpPercent: Math.round((m.hp / Math.max(1, m.base.maxHp)) * 100),
      home: REGION_NAMES[m.monster!.region], enraged: m.monster!.enragedUntil > core.clockMs, flies: m.monster!.flies, swims: m.monster!.swims,
    })),
    monstersSlain: 6 - monsters.length,
    stats: core.stats,
    terrain: tiles,
    creationEntities: kinds,
    recentEvents: chronicle.slice(-15).map((e) => `day ${e.day}: ${e.text}`),
    bookOfCreation: core.creations.map((c) => `day ${c.day}, ${c.god === 'human' ? 'the Most High' : 'Dagon'} (${c.domain}, scale ${c.scale}): ${c.title}`),
    missingFundamentalSystems: core.missingSystems,
    installedModules: world.manifest.map((m) => {
      const mod = world.modules.mods[m.id];
      return { id: m.id, title: m.title, description: m.description, status: m.status, stateKeys: Object.keys(mod?.state ?? {}) };
    }),
  };
}
