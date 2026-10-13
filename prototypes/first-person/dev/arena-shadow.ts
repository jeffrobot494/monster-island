// The arena's shadow resolver (src/arena/README.md). Only the arena's Vite and Vitest configs use it; the game's
// never does, so nothing in src/arena/sandbox/ can reach the game without `npm run arena:promote`.
//
// - A file at src/arena/sandbox/<path> stands in for src/<path> wherever it is imported from.
// - Imports inside a sandbox file resolve as if it sat at src/<path>, so a forked copy works unchanged (and an
//   import of another forked file gets that file's sandbox copy too).
// - src/sim-client.ts starts the arena's worker (src/arena/arena.worker.ts) instead of the game's.
// - `virtual:arena-sandbox` lists the sandbox files, for the arena panel.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

export function arenaShadow(root: string): Plugin {
  const SRC = path.join(root, 'src');
  const SANDBOX = path.join(SRC, 'arena', 'sandbox');
  const inside = (dir: string, p: string) => p.startsWith(dir + path.sep);
  /** the sandbox copy of a src file, if there is one */
  const shadowOf = (abs: string): string | null => {
    if (!inside(SRC, abs) || inside(SANDBOX, abs)) return null;
    const cand = path.join(SANDBOX, path.relative(SRC, abs));
    return fs.existsSync(cand) ? cand : null;
  };
  /** where a sandbox file stands in the game's tree */
  const mirror = (abs: string) => (inside(SANDBOX, abs) ? path.join(SRC, path.relative(SANDBOX, abs)) : abs);
  const split = (id: string): [string, string] => {
    const k = id.indexOf('?');
    return k < 0 ? [id, ''] : [id.slice(0, k), id.slice(k)];
  };

  /** what's in the sandbox (paths under src/), for the arena panel: `import files from 'virtual:arena-sandbox'` */
  const listSandbox = (dir = SANDBOX): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === '.base' ? [] : listSandbox(p);
      return d.name.endsWith('.md') ? [] : [path.relative(SANDBOX, p).split(path.sep).join('/')];
    });
  };
  const VIRTUAL = 'virtual:arena-sandbox';

  return {
    name: 'arena-shadow',
    enforce: 'pre',
    load(id) {
      return id === '\0' + VIRTUAL ? `export default ${JSON.stringify(listSandbox().sort())};` : null;
    },
    async resolveId(source, importer, opts) {
      if (source === VIRTUAL) return '\0' + VIRTUAL;
      if (!importer || source.startsWith('\0')) return null;
      const [imp] = split(importer);
      const fromSandbox = inside(SANDBOX, imp);
      const r = await this.resolve(source, fromSandbox ? mirror(imp) : imp, { ...opts, skipSelf: true });
      if (!r || r.external) return r;
      const [id, q] = split(r.id);
      const sh = shadowOf(path.normalize(id));
      return sh ? sh + q : r;
    },
    transform(code, id) {
      if (path.normalize(split(id)[0]) !== path.join(SRC, 'sim-client.ts')) return null;
      const out = code.replace("'./workers/sim.worker.ts'", "'./arena/arena.worker.ts'");
      if (out === code) throw new Error('[arena-shadow] src/sim-client.ts no longer starts ./workers/sim.worker.ts: update dev/arena-shadow.ts');
      return out;
    },
    configureServer(server: ViteDevServer) {
      // a file forked into the sandbox or dropped from it changes how imports resolve: start over
      const changed = (f: string) => {
        if (!inside(SANDBOX, path.normalize(f))) return;
        server.config.logger.info(`[arena] sandbox changed (${path.relative(SANDBOX, f)}): restarting`, { timestamp: true });
        void server.restart();
      };
      // the arena is the only page here
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/' && !req.url?.startsWith('/?')) return next();
        res.statusCode = 302;
        res.setHeader('Location', `/arena.html${req.url.slice(1)}`);
        res.end();
      });
      server.watcher.add(SANDBOX);
      server.watcher.on('add', changed);
      server.watcher.on('unlink', changed);
    },
  };
}
