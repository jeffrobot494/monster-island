// Sim + module runtime + save format, shared by the sim worker, the validator worker, and Vitest.
import { Sim } from './sim';
import { ModuleRuntime, type ModuleDef, type RuntimeOptions, type SavedModules } from './module-runtime';
import { deserializeCore, serializeCore, type SavedCore } from './serialize';

export interface ManifestEntry {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'quarantined';
  dayInstalled: number;
  requires: string[];
}

export interface SavedWorld {
  core: SavedCore;
  modules: SavedModules;
  manifest: ManifestEntry[];
}

/** Turns module source into its default export (blob import in workers, data: URL in Node). */
export type ModuleLoader = (id: string, source: string) => Promise<ModuleDef>;

export async function importDefault(url: string): Promise<ModuleDef> {
  const m = await import(/* @vite-ignore */ url);
  if (!m || typeof m.default !== 'object' || m.default === null) throw new Error('module has no default export object');
  return m.default as ModuleDef;
}

export class Island {
  manifest: ManifestEntry[] = [];
  runtime: ModuleRuntime;

  constructor(public sim: Sim, opts: RuntimeOptions) {
    this.runtime = new ModuleRuntime(sim, opts);
  }

  static create(seed: number, opts: RuntimeOptions): Island {
    const sim = new Sim(seed);
    sim.generate();
    return new Island(sim, opts);
  }

  /**
   * Load a saved world. Each manifest module is re-imported from source and its define re-run (never init).
   * Missing sources are skipped with a chronicle note. `quarantine` lists ids to load quarantined (watchdog restart).
   */
  static async load(world: SavedWorld, sources: Record<string, string>, loader: ModuleLoader, opts: RuntimeOptions, quarantine: string[] = []): Promise<Island> {
    const sim = deserializeCore(world.core);
    const island = new Island(sim, opts);
    island.runtime.restore(world.modules);
    for (const m of world.manifest) {
      const src = sources[m.id];
      if (src === undefined) {
        sim.log(`The work "${m.title}" was lost.`, 2, 'core');
        continue;
      }
      let def: ModuleDef;
      try {
        def = await loader(m.id, src);
      } catch (err) {
        sim.log(`The work "${m.title}" could not be recalled (${(err as Error).message}).`, 2, 'core');
        island.manifest.push({ ...m, status: 'quarantined' });
        continue;
      }
      const rec = island.runtime.install(m.id, def, false, m.status);
      if (quarantine.includes(m.id) && rec.status === 'active') island.runtime.quarantine(rec, 'it froze the island');
      island.manifest.push({ ...m, status: rec.status });
    }
    return island;
  }

  /** First install of a new module (define + init). Throws on failure, leaving the island unchanged. */
  install(id: string, def: ModuleDef) {
    this.runtime.install(id, def, true);
    this.manifest.push({
      id, title: def.title, description: def.description ?? '', status: 'active',
      dayInstalled: this.sim.time.day, requires: [...(def.requires ?? [])],
    });
  }

  syncManifest() {
    for (const m of this.manifest) {
      const r = this.runtime.byId.get(m.id);
      if (r) m.status = r.status;
    }
  }

  serialize(): SavedWorld {
    this.syncManifest();
    return { core: serializeCore(this.sim), modules: this.runtime.serialize(), manifest: this.manifest.map((m) => ({ ...m })) };
  }

  step() {
    this.sim.step();
  }
}
