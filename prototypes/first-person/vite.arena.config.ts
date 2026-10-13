// The combat arena (src/arena/README.md): the game's code with src/arena/sandbox/ shadowing it. `npm run arena`.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { arenaShadow } from './dev/arena-shadow';
import { claudeCodePlugin } from './dev/claude-code-middleware';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_ARENA': JSON.stringify('1') },
  worker: { format: 'es', plugins: () => [arenaShadow(root)] },
  // the game's dev middleware too: ?shot= screenshots use its delay endpoint (the arena runs no god)
  plugins: [arenaShadow(root), claudeCodePlugin()],
  server: { port: 5202, strictPort: true },
  build: { rollupOptions: { input: path.join(root, 'arena.html') }, outDir: 'dist-arena' },
  test: { exclude: ['test/old/**', 'node_modules/**'] },
} as any);
