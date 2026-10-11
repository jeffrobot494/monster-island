import { AiRateLimitError, type AiProvider, type AiRequest, type AiResponse } from './ai-provider';
import { loadRundot } from '../../rundot';

// Same split as the local Claude Code provider (sonnet decrees, opus code). Exact ids are best-effort on RUN.world:
// a retired or disallowed id falls back to the class instead of failing.
const MODELS = {
  propose: { model: 'claude-sonnet-4-6', modelClass: 'standard' },
  implement: { model: 'claude-opus-4-7', modelClass: 'power' },
} as const;
const TIMEOUT_S = 900; // the local provider allows 15 minutes for an implement call too

/** The slice of RundotGameAPI.textGen used here. */
interface TextGenApi {
  getAvailableCompletionModels(): Promise<string[]>;
  requestChatCompletionAsync(req: {
    model?: string;
    modelClass?: 'quick' | 'standard' | 'power';
    system?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    maxTokens?: number;
    responseFormat?: { type: 'json_schema'; schema: unknown };
    timeout?: number;
  }): Promise<{
    model: string;
    choices: { message: { content: string }; finish_reason: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
    cost?: { prompt_cost?: number; completion_cost?: number };
  }>;
}

/** RUN.world platform: RUN.world's hosted LLMs (RundotGameAPI.textGen), billed to the game's credits. */
export class RunTextGenProvider implements AiProvider {
  readonly name = 'run-textgen';

  static async create(): Promise<RunTextGenProvider | null> {
    const textGen: TextGenApi | undefined = (await loadRundot())?.textGen;
    if (!textGen) return null;
    // for the console: whether the exact ids above exist here (a missing one silently falls back to its class)
    textGen.getAvailableCompletionModels().then((m) => console.info('[god] RUN.world textGen models:', m.join(', ')), () => {});
    return new RunTextGenProvider(textGen);
  }

  private constructor(private textGen: TextGenApi) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    const pick = req.role === 'propose' ? MODELS.propose : MODELS.implement;
    req.onProgress?.({ kind: 'status', text: `waiting for ${pick.model} on RUN.world` });
    const t0 = performance.now();
    let res: Awaited<ReturnType<TextGenApi['requestChatCompletionAsync']>>;
    try {
      res = await this.textGen.requestChatCompletionAsync({
        ...pick,
        system: req.system,
        messages: req.messages,
        maxTokens: req.maxTokens,
        responseFormat: { type: 'json_schema', schema: req.schema },
        timeout: TIMEOUT_S,
      });
    } catch (err) {
      const e = err as Error & { code?: string; status?: number };
      const msg = e.message ?? String(err);
      if (e.code === 'CREDITS_EXHAUSTED' || e.status === 429 || /credit|rate.?limit|too many requests|quota|429/i.test(msg)) throw new AiRateLimitError(msg);
      throw new Error(`textGen: ${msg}${e.code ? ` (${e.code})` : ''}`);
    }
    // raw, so the units of `cost` can be checked against the token counts
    console.info('[god] textGen usage', res.model, JSON.stringify(res.usage), JSON.stringify(res.cost));
    const choice = res.choices?.[0];
    if (!choice) throw new Error('textGen returned no choices');
    if (choice.finish_reason === 'length') throw new Error(`the answer was cut off at ${req.maxTokens} tokens`);
    let data: unknown;
    try {
      data = typeof choice.message.content === 'string' ? JSON.parse(choice.message.content) : choice.message.content;
    } catch {
      throw new Error(`textGen answer was not JSON: ${String(choice.message.content).slice(0, 200)}`);
    }
    return {
      data,
      usage: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0, cachedInput: res.usage?.cache_read_tokens },
      cost: res.cost ? (res.cost.prompt_cost ?? 0) + (res.cost.completion_cost ?? 0) : undefined,
      model: res.model,
      seconds: (performance.now() - t0) / 1000,
    };
  }
}
