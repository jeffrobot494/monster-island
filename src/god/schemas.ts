// JSON schemas for god calls. Kept to types/enums/required (no length or count constraints) so every
// structured-output backend accepts them; lengths are enforced after parsing.
export type JSONSchema = Record<string, unknown>;

export const TONES = ['cozy', 'eerie', 'chaotic', 'social', 'wild'] as const;
export const SUSPENDS = ['eat', 'sleep', 'faction-survival'] as const;

export interface Omen {
  title: string;
  omen: string;
  change: string;
  visible: string;
  builds_on: string[];
  tone: (typeof TONES)[number];
  suspends: (typeof SUSPENDS)[number][];
}

export const PROPOSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    omens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          omen: { type: 'string' },
          change: { type: 'string' },
          visible: { type: 'string' },
          builds_on: { type: 'array', items: { type: 'string' } },
          tone: { type: 'string', enum: [...TONES] },
          suspends: { type: 'array', items: { type: 'string', enum: [...SUSPENDS] } },
        },
        required: ['title', 'omen', 'change', 'visible', 'builds_on', 'tone', 'suspends'],
        additionalProperties: false,
      },
    },
  },
  required: ['omens'],
  additionalProperties: false,
};

export const IMPLEMENT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['source', 'notes'],
  additionalProperties: false,
};

/** Minimal structural check for the schemas above (types, enums, required, additionalProperties). */
export function checkAgainstSchema(value: unknown, schema: JSONSchema, path = '$'): string | null {
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    const props = (schema.properties ?? {}) as Record<string, JSONSchema>;
    for (const r of (schema.required as string[]) ?? []) if (!(r in (value as object))) return `${path}.${r} is missing`;
    for (const [k, v] of Object.entries(value as object)) {
      if (!props[k]) {
        if (schema.additionalProperties === false) return `${path}.${k} is not allowed`;
        continue;
      }
      const e = checkAgainstSchema(v, props[k], `${path}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    for (let i = 0; i < value.length; i++) {
      const e = checkAgainstSchema(value[i], schema.items as JSONSchema, `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    if (schema.enum && !(schema.enum as string[]).includes(value)) return `${path} must be one of ${(schema.enum as string[]).join(', ')}`;
    return null;
  }
  if (t === 'number') return typeof value === 'number' ? null : `${path} must be a number`;
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function normalizeOmens(data: unknown): Omen[] {
  const err = checkAgainstSchema(data, PROPOSE_SCHEMA);
  if (err) throw new Error(`proposal did not match the schema: ${err}`);
  const omens = (data as { omens: Omen[] }).omens.slice(0, 3);
  if (omens.length < 3) throw new Error(`expected 3 omens, got ${omens.length}`);
  return omens.map((o) => ({
    title: clip(o.title, 40),
    omen: clip(o.omen, 100),
    change: clip(o.change, 300),
    visible: clip(o.visible, 160),
    builds_on: o.builds_on.slice(0, 2),
    tone: o.tone,
    suspends: [...new Set(o.suspends)],
  }));
}
