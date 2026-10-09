import type { JSONSchema } from '../schemas';

export type AiRole = 'propose' | 'implement' | 'repair';

export interface AiRequest {
  role: AiRole;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema: JSONSchema;
  maxTokens: number;
}

export interface AiResponse {
  data: unknown;
  usage: { input: number; output: number };
}

export class AiRateLimitError extends Error {}

export interface AiProvider {
  readonly name: string;
  complete(req: AiRequest): Promise<AiResponse>;
}
