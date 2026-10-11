import { defineConfig } from 'vite';
import { claudeCodePlugin } from './dev/claude-code-middleware';
import { terrainPlugin } from './dev/terrain-middleware';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [claudeCodePlugin(), terrainPlugin()],
  test: { exclude: ['test/old/**', 'node_modules/**'] },
} as any);
