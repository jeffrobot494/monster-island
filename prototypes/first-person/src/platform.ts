// Picks the platform at boot (§4): local (dev server) or run (RUN.world builds, `npm run build:run`).
import type { AiProvider } from './god/providers/ai-provider';
import { ClaudeCodeProvider } from './god/providers/claude-code';
import { ManualProvider } from './god/providers/manual';
import { RunTextGenProvider } from './god/providers/run-textgen';
import { LocalSaveStore } from './persist/local-store';
import type { SaveStore } from './persist/save-store';

export interface Platform {
  name: 'local' | 'run';
  store: SaveStore & { clear?: () => Promise<void> };
  provider: AiProvider;
  warning?: string;
}

export async function pickPlatform(params: URLSearchParams, askSource: (prompt: string) => Promise<string>, autoSource?: (prompt: string) => string | null): Promise<Platform> {
  const platform = import.meta.env.VITE_RUNDOT ? 'run' : (import.meta.env.VITE_PLATFORM ?? 'local');
  if (platform === 'run' && !import.meta.env.VITE_RUNDOT) throw new Error('The Run platform needs the RUN.world build: `npm run build:run`.');
  // TODO(run): the host may later block localStorage in its sandbox; move to RundotGameAPI.deviceCache / appStorage
  const store = new LocalSaveStore(params.get('slot') ?? 'default');
  const manual = new ManualProvider(async (req) => {
    const prompt = req.messages.map((m) => m.content).join('\n');
    return autoSource?.(prompt) ?? askSource(req.messages[req.messages.length - 1].content);
  });
  const ai = params.get('ai');
  if (platform === 'run') {
    if (ai === 'manual') return { name: 'run', store, provider: manual };
    const run = await RunTextGenProvider.create();
    if (!run) return { name: 'run', store, provider: manual, warning: 'RUN.world SDK unavailable; using the manual god.' };
    return { name: 'run', store, provider: run };
  }
  if (ai === 'manual') return { name: 'local', store, provider: manual };
  if (ai && ai !== 'claude-code') return { name: 'local', store, provider: manual, warning: `?ai=${ai} is a Phase 2 provider; using manual.` };
  const status = await ClaudeCodeProvider.available();
  if (!status.ok) return { name: 'local', store, provider: manual, warning: `Claude Code CLI unavailable (${status.error ?? 'not found'}); using the manual god.` };
  return { name: 'local', store, provider: new ClaudeCodeProvider() };
}
