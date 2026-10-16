import { performance } from 'node:perf_hooks';
export const now = () => performance.now();
export const START = Date.UTC(2026, 9, 10, 8, 0);
