// Picks the platform at boot (§4). Phase 1 builds only the local platform.
import type { AiProvider } from './god/providers/ai-provider';
import { ClaudeCodeProvider } from './god/providers/claude-code';
import { ManualProvider } from './god/providers/manual';
import { LocalSaveStore } from './persist/local-store';
import type { SaveStore } from './persist/save-store';

export interface Platform {
  name: 'local' | 'run';
  store: SaveStore & { clear?: () => Promise<void> };
  provider: AiProvider;
  warning?: string;
}

export async function pickPlatform(params: URLSearchParams, askSource: (prompt: string) => Promise<string>, autoSource?: (prompt: string) => string | null): Promise<Platform> {
  const platform = import.meta.env.VITE_PLATFORM ?? 'local';
  if (platform === 'run') throw new Error('The Run platform is Phase 2 and not built yet. Use `npm run dev:local`.');
  const store = new LocalSaveStore(params.get('slot') ?? 'default');
  const manual = new ManualProvider(async (req) => {
    const prompt = req.messages.map((m) => m.content).join('\n');
    return autoSource?.(prompt) ?? askSource(req.messages[req.messages.length - 1].content);
  });
  const ai = params.get('ai');
  if (ai === 'manual') return { name: 'local', store, provider: manual };
  if (ai && ai !== 'claude-code') return { name: 'local', store, provider: manual, warning: `?ai=${ai} is a Phase 2 provider; using manual.` };
  const status = await ClaudeCodeProvider.available();
  if (!status.ok) return { name: 'local', store, provider: manual, warning: `Claude Code CLI unavailable (${status.error ?? 'not found'}); using the manual god.` };
  return { name: 'local', store, provider: new ClaudeCodeProvider() };
}
