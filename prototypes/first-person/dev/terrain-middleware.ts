// Dev-only Vite middleware for the terraformer (terraformer.html): GET /__terrain returns the settings the game uses
// for new islands (src/terrain/saved-terrain.json, null when none), POST saves new ones, DELETE goes back to
// procedural islands (writes null). The file is part of the game's source, so it ships in builds and can be committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { allowed } from './dev-middleware';
import { checkSettings } from '../src/sim/terrain-import';

const FILE = fileURLToPath(new URL('../src/terrain/saved-terrain.json', import.meta.url));
const MAX_BODY = 16 * 1024;

export function terrainPlugin(): Plugin {
  return {
    name: 'humans-monsters-terrain',
    apply: 'serve',
    // Saving must not reload open pages: the terraformer would lose its view mid-click, and an old game tab would
    // restart. The module is still invalidated, so the next load of the game reads the new file.
    handleHotUpdate(ctx) {
      if (ctx.file === FILE) return [];
    },
    configureServer(server) {
      server.middlewares.use('/__terrain', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (!allowed(req)) return send(403, { error: 'localhost only (or the LAN token)' });
        if (req.method === 'GET') return send(200, JSON.parse(readFileSync(FILE, 'utf8')));
        if (req.method === 'DELETE') {
          writeFileSync(FILE, 'null\n');
          return send(200, null);
        }
        if (req.method !== 'POST') return send(405, { error: 'GET, POST or DELETE' });
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c;
          if (body.length > MAX_BODY) req.destroy();
        });
        req.on('end', () => {
          try {
            const settings = checkSettings(JSON.parse(body));
            writeFileSync(FILE, JSON.stringify(settings, null, 2) + '\n');
            server.config.logger.info(`[terrain] saved island "${settings.seed}" to src/terrain/saved-terrain.json`);
            send(200, settings);
          } catch (err) {
            send(400, { error: (err as Error).message });
          }
        });
      });
    },
  };
}
