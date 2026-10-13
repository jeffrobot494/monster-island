import { defineConfig } from 'vite';
import { claudeCodePlugin } from './dev/claude-code-middleware';
import { terrainPlugin } from './dev/terrain-middleware';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [claudeCodePlugin(), terrainPlugin()],
  // not arena.html: it imports the arena config's virtual:arena-sandbox, which this server can't resolve
  optimizeDeps: { entries: ['index.html', 'terraformer.html'] },
  test: { exclude: ['test/old/**', 'node_modules/**'] },
} as any);
