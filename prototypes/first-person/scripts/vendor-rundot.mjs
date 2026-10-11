// Post-build step for RUN.world deploys (npm run build:run).
//
// Copies the RUN.world SDK's `api` entry, plus every chunk it imports, unbundled from node_modules into
// dist/vendor/rundot-sdk/, and adds it to dist/index.html as its own module script after the game's.
// Importing it initialises the SDK and reports ready to the host, which otherwise fails the load after about
// a minute. A separate script, so an SDK failure cannot stop the game starting.
//
// Why not let Vite bundle it: as of 2026-10-10, RUN.world deploys of builds with the SDK bundled into the game's
// JS hang at "Processing game file" and fail; builds that ship this standalone entry module deploy
// (prototypes/monster-island/docs/run-world-findings.md).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'vendor/rundot-sdk');
const ENTRY = 'rundot-game-api/index.js';
// the package exports only its entries, so find dist/ from the api entry's own path
const SRC = dirname(dirname(createRequire(import.meta.url).resolve('@series-inc/rundot-game-sdk/api')));
const PKG = dirname(SRC);
const TAG = `<script type="module" src="./vendor/rundot-sdk/${ENTRY}"></script>`;

if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing: run vite build first');

// follow the entry's relative imports (static and dynamic); a bare import would need the bundler, so fail on it
const files = new Set([ENTRY]);
const queue = [ENTRY];
while (queue.length) {
  const rel = queue.pop();
  // without comments: JSDoc examples contain `import … from '@series-inc/rundot-game-sdk'`
  const code = readFileSync(join(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // specifier-shaped strings only: the minified chunks also have prose like `… from "SDK has a live subscriber"`
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([\w@./-]+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) throw new Error(`${rel} imports bare specifier "${spec}"; vendoring cannot ship it`);
    const dep = posix.normalize(posix.join(posix.dirname(rel), spec));
    if (!files.has(dep)) {
      files.add(dep);
      queue.push(dep);
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
for (const rel of files) {
  mkdirSync(dirname(join(OUT, rel)), { recursive: true });
  // drop the sourceMappingURL comment: the .map files are not shipped
  writeFileSync(join(OUT, rel), readFileSync(join(SRC, rel), 'utf8').replace(/\n?\/\/# sourceMappingURL=.*$/m, ''));
}
copyFileSync(join(PKG, 'LICENSE.md'), join(OUT, 'LICENSE.md'));

const htmlPath = join(DIST, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
if (!html.includes(TAG)) {
  if (!html.includes('</body>')) throw new Error('dist/index.html has no </body>');
  html = html.replace('</body>', `  ${TAG}\n</body>`);
  writeFileSync(htmlPath, html);
}
const version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
console.log(`vendored RUN.world SDK ${version}: ${files.size} files -> dist/vendor/rundot-sdk/`);
