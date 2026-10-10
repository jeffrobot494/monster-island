export interface SaveStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

// Run appStorage limits (§9), enforced locally so a save that would fail on Run fails here too.
export const RUN_LIMITS = { maxKeys: 128, comfortableValueBytes: 256 * 1024, maxValueBytes: 1024 * 1024, bucketBytes: 10 * 1024 * 1024 };

export const KEYS = {
  world: 'hm:world',
  chronicle: 'hm:chronicle',
  pending: 'hm:pending',
  mod: (id: string) => `hm:mod:${id}`,
};

export function byteLength(s: string) {
  return new TextEncoder().encode(s).length;
}
