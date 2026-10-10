import { AiRateLimitError, type AiProvider, type AiRequest, type AiResponse } from './ai-provider';

function devToken(): string {
  try {
    const p = new URLSearchParams(location.search).get('token');
    if (p) localStorage.setItem('devAiToken', p);
    return localStorage.getItem('devAiToken') ?? '';
  } catch {
    return '';
  }
}

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
    const { onProgress, ...wire } = req;
    const r = await fetch('/dev-ai/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-ai-token': devToken() },
      body: JSON.stringify(wire),
    });
    if (!r.ok || !r.body) {
      const body = await r.json().catch(() => ({ error: `bad response (${r.status})` }));
      throw new Error(body.error ?? `claude-code call failed (${r.status})`);
    }
    // NDJSON: progress lines, then one result or error line (dev/claude-code-middleware.ts)
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let last: any = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.type === 'progress') onProgress?.(m);
        else last = m;
      }
      if (done) break;
    }
    if (!last) throw new Error('claude-code call ended without a result');
    if (last.type === 'error') {
      if (last.rateLimit) throw new AiRateLimitError(last.error ?? 'usage limit reached');
      throw new Error(last.error ?? 'claude-code call failed');
    }
    return { data: last.data, usage: last.usage, model: last.model, seconds: last.seconds };
  }
}
