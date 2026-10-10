import { RUN_LIMITS, byteLength, type SaveStore } from './save-store';

/** localStorage, namespaced by save slot (?slot=name). */
export class LocalSaveStore implements SaveStore {
  private prefix: string;
  constructor(slot = 'default') {
    this.prefix = `humans-monsters/${slot}/`;
  }
  async get(key: string) {
    return localStorage.getItem(this.prefix + key);
  }
  async set(key: string, value: string) {
    const size = byteLength(value);
    if (size > RUN_LIMITS.maxValueBytes) throw new Error(`save value '${key}' is ${Math.round(size / 1024)} KB, over the ${RUN_LIMITS.maxValueBytes / 1024} KB limit`);
    if (size > RUN_LIMITS.comfortableValueBytes) console.warn(`[save] '${key}' is ${Math.round(size / 1024)} KB (Run is comfortable up to 256 KB)`);
    const keys = await this.keys();
    if (!keys.includes(key) && keys.length >= RUN_LIMITS.maxKeys) throw new Error(`save would exceed ${RUN_LIMITS.maxKeys} keys`);
    localStorage.setItem(this.prefix + key, value);
    let total = 0;
    for (const k of await this.keys()) total += (localStorage.getItem(this.prefix + k)?.length ?? 0) * 2;
    if (total > 4 * 1024 * 1024) console.warn(`[save] slot uses ~${Math.round(total / 1024 / 1024)} MB of localStorage (≈5 MB per origin)`);
  }
  async remove(key: string) {
    localStorage.removeItem(this.prefix + key);
  }
  async keys() {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }
  async clear() {
    for (const k of await this.keys()) localStorage.removeItem(this.prefix + k);
  }
}
