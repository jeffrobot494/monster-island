import type { SavedWorld } from '../sim/island';
import type { ChronicleEvent } from '../sim/types';
import { TICKS_PER_DAY } from '../sim/time';

export interface PlayerHistory {
  picked: { title: string; day: number; chosenBy: 'player' | 'god' }[];
  ignored: string[]; // omen titles shown but not picked (most recent last)
  abandoned: string[];
  whisper: string | null;
}

export function emptyHistory(): PlayerHistory {
  return { picked: [], ignored: [], abandoned: [], whisper: null };
}

/** The ~2 KB summary the god reads (§8.1), computed by the host so the model never reads raw state. */
export function observe(world: SavedWorld, chronicle: ChronicleEvent[], history: PlayerHistory) {
  const core = world.core;
  const ents = core.ents;
  const inh = ents.filter((e) => e.inhabitant);
  const pop = (f: string) => inh.filter((e) => e.faction === f);
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
  const days = [...core.history.slice(-2), core.dayStats];
  const last3 = days.slice(-3);
  const ticks: Record<string, number> = {};
  for (const d of days) for (const [k, v] of Object.entries(d.behaviorTicks)) ticks[k] = (ticks[k] ?? 0) + v;
  const totalTicks = Object.values(ticks).reduce((s, x) => s + x, 0) || 1;
  const behaviorShare = Object.fromEntries(Object.entries(ticks).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${Math.round((v / totalTicks) * 100)}%`]));
  const tiles: Record<string, number> = {};
  for (const [t, n] of core.tiles) tiles[t] = (tiles[t] ?? 0) + n;
  const kinds: Record<string, number> = {};
  for (const e of ents) if (!e.inhabitant) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const berries = ents.filter((e) => e.kind === 'berry-bush').reduce((s, e) => s + (e.berries ?? 0), 0);
  const notes: string[] = [];
  const wander = (ticks.wander ?? 0) / totalTicks;
  if (wander > 0.6) notes.push(`inhabitants spend ${Math.round(wander * 100)}% of their time aimlessly wandering — the island is dull`);
  const size = JSON.stringify(world).length;
  if (size > 200 * 1024) notes.push('the island is heavy (large save); prefer changes that keep little state');
  return {
    day: Math.floor(core.tick / TICKS_PER_DAY),
    population: { monsters: pop('monster').length, humans: pop('human').length },
    last3Days: { births: last3.reduce((s, d) => s + d.births, 0), deaths: last3.reduce((s, d) => s + d.deaths, 0) },
    avgHunger: { monsters: avg(pop('monster').map((e) => e.hunger)), humans: avg(pop('human').map((e) => e.hunger)) },
    food: { berriesOnBushes: berries, mushrooms: kinds.mushroom ?? 0 },
    behaviorShare,
    tiles,
    otherEntities: kinds,
    recentEvents: chronicle.slice(-15).map((e) => `day ${e.day}: ${e.text}`),
    installedWorks: world.manifest.map((m) => {
      const mod = world.modules.mods[m.id];
      const dataKeys = new Set<string>();
      for (const e of ents) for (const k of Object.keys(e.data[m.id] ?? {})) dataKeys.add(k);
      return { id: m.id, title: m.title, description: m.description, status: m.status, dayInstalled: m.dayInstalled, stateKeys: Object.keys(mod?.state ?? {}), entityDataKeys: [...dataKeys] };
    }),
    petitioner: {
      recentPicks: history.picked.slice(-5).map((p) => `${p.title} (${p.chosenBy === 'god' ? 'left to the god' : 'chosen'})`),
      recentlyPassedOver: history.ignored.slice(-6),
      crumbledAttempts: history.abandoned.slice(-3),
      whisper: history.whisper,
    },
    notes,
  };
}
