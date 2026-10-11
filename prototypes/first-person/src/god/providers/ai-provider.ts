import type { JSONSchema } from '../schemas';

export type AiRole = 'propose' | 'implement' | 'repair';
/** stable id of one logical call, so a reconnecting page re-attaches instead of paying twice (R30) */

export interface AiRequest {
  role: AiRole;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema: JSONSchema;
  maxTokens: number;
  jobKey?: string;
  /** live progress while the call runs (providers that can stream call it; not sent over the wire) */
  onProgress?: (p: AiProgress) => void;
}

export type AiProgress = { kind: 'status'; text: string } | { kind: 'delta'; channel: 'thinking' | 'output'; text: string } | { kind: 'thinking'; tokens: number };

export interface AiResponse {
  data: unknown;
  usage: { input: number; output: number; cachedInput?: number };
  /** what the call cost, in US dollars, when the provider reports it */
  cost?: number;
  model?: string;
  seconds?: number;
}

export class AiRateLimitError extends Error {}

export interface AiProvider {
  readonly name: string;
  complete(req: AiRequest): Promise<AiResponse>;
}
