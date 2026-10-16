import { defineConfig } from 'vite';
import { devPlugin } from './dev/dev-middleware';
import { terrainPlugin } from './dev/terrain-middleware';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [devPlugin(), terrainPlugin()],
  // not arena.html: it imports the arena config's virtual:arena-sandbox, which this server can't resolve
  optimizeDeps: { entries: ['index.html', 'terraformer.html'] },
  test: { setupFiles: ['./test/setup.ts'], exclude: ['test/old/**', 'node_modules/**'] },
} as any);
