import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { ModuleDef } from '../src/sim/module-runtime';

let n = 0;
/** Node stand-in for the worker's blob import: a data: URL (unique per load so define state never leaks). */
export async function nodeLoader(_id: string, source: string): Promise<ModuleDef> {
  const url = `data:text/javascript;base64,${Buffer.from(source + `\n//# n=${n++}`).toString('base64')}`;
  const m = await import(/* @vite-ignore */ url);
  return m.default;
}

export const now = () => performance.now();

export function refSource(name: 'fireflies' | 'wading'): string {
  return readFileSync(new URL(`../src/god/reference-modules/${name}.js`, import.meta.url), 'utf8');
}
