// JSON schemas for god calls. Kept to types/enums/required (no length or count constraints) so every
// structured-output backend accepts them; lengths are enforced after parsing.
export type JSONSchema = Record<string, unknown>;

export const ALL_DOMAINS = ['creatures', 'weather', 'sky', 'land', 'plants', 'bodies', 'laws', 'fundamental'] as const;

export interface Decree {
  title: string;
  domain: string;
  announcement: string;
  mechanic: string;
  visible: string;
  priestsPrayer: string;
}

export const DECREE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    domain: { type: 'string', enum: [...ALL_DOMAINS] },
    announcement: { type: 'string' },
    mechanic: { type: 'string' },
    visible: { type: 'string' },
    priestsPrayer: { type: 'string' },
  },
  required: ['title', 'domain', 'announcement', 'mechanic', 'visible', 'priestsPrayer'],
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

export function normalizeDecree(data: unknown): Decree {
  const err = checkAgainstSchema(data, DECREE_SCHEMA);
  if (err) throw new Error(`decree did not match the schema: ${err}`);
  const d = data as Decree;
  return {
    title: clip(d.title, 40), domain: d.domain, announcement: clip(d.announcement, 320), mechanic: clip(d.mechanic, 450),
    visible: clip(d.visible, 180), priestsPrayer: clip(d.priestsPrayer, 160),
  };
}
