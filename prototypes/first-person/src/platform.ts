import { LocalSaveStore } from './persist/local-store';
import type { SaveStore } from './persist/save-store';
export interface Platform {
  name: 'local' | 'run';
  store: SaveStore & { clear?: () => Promise<void> };
  warning?: string;
}
export async function pickPlatform(params: URLSearchParams): Promise<Platform> {
  return {
    name: import.meta.env.VITE_RUNDOT ? 'run' : 'local',
    store: new LocalSaveStore(params.get('slot') ?? 'default'),
  };
}
