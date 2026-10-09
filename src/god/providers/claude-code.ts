import { AiRateLimitError, type AiProvider, type AiRequest, type AiResponse } from './ai-provider';

/** Local platform default: the Vite dev server spawns `claude -p` (see dev/claude-code-middleware.ts). */
export class ClaudeCodeProvider implements AiProvider {
  readonly name = 'claude-code';

  static async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const r = await fetch('/dev-ai/status');
      if (!r.ok) return { ok: false, error: `status ${r.status}` };
      return await r.json();
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const r = await fetch('/dev-ai/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    const body = await r.json().catch(() => ({ error: `bad response (${r.status})` }));
    if (r.status === 429) throw new AiRateLimitError(body.error ?? 'usage limit reached');
    if (!r.ok) throw new Error(body.error ?? `claude-code call failed (${r.status})`);
    return body as AiResponse;
  }
}
