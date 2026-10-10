import type { SaveStore } from './save-store';

export class MemorySaveStore implements SaveStore {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async remove(key: string) {
    this.data.delete(key);
  }
  async keys() {
    return [...this.data.keys()];
  }
}
