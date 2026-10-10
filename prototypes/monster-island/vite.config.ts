import { defineConfig } from 'vite';
import { claudeCodePlugin } from './dev/claude-code-middleware';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [claudeCodePlugin()],
});
