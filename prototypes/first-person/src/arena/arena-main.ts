// The combat arena's page (arena.html, `npm run arena`; src/arena/README.md). It boots the game's own client
// (src/main.ts) with the arena wired in around it:
// - the game's URL switches: its own save slot, cleared on every load; no god; the map revealed
// - the worker's init message carries the arena's settings (arena-hooks.ts reads them)
// - the renderer draws the arena's rock (mesh.ts)
// - a settings panel while paused, a status plate while fighting, and a few hotkeys
import './arena.css';
import { SimClient } from '../sim-client';
import { Terrain } from '../render/terrain';
import type { SimToMain } from '../protocol';
import { buildArenaFeatures } from './mesh';
import { ArenaPanel } from './panel';
import { sanitize, type ArenaCommand, type ArenaConfig, type ArenaStatus } from './rules';

const STORE_KEY = 'humans-monsters/arena-config';

function loadConfig(): ArenaConfig {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'));
  } catch {
    return sanitize(null);
  }
}

function saveConfig(c: ArenaConfig) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(c));
  } catch {
    /* private window: settings last until reload */
  }
}

async function bootArena() {
  if (!import.meta.env.VITE_ARENA) {
    document.getElementById('ui')!.innerHTML = '<pre style="color:#fff;padding:20px;white-space:pre-wrap">The arena runs on its own dev server, which puts the sandbox in place:\n\n    npm run arena        (http://localhost:5202/arena.html)</pre>';
    return;
  }
  const { default: sandbox } = await import('virtual:arena-sandbox');
  const params = new URLSearchParams(location.search);
  params.set('slot', 'arena');
  params.set('fresh', '1');
  params.set('nogod', '1');
  params.set('reveal', '1');
  history.replaceState(null, '', `${location.pathname}?${params}`);
  document.title = 'Combat Arena · Island Humans and Monsters';
  document.body.classList.add('arena');

  const config = loadConfig();
  Terrain.featureBuilder = buildArenaFeatures;

  // every worker start (the first, a rebuild, a watchdog restart) gets a fresh arena with the current settings
  let lastInit: Parameters<SimClient['start']>[0] | null = null;
  let client: SimClient | null = null;
  const start = SimClient.prototype.start;
  SimClient.prototype.start = function (init) {
    client = this;
    lastInit = init;
    start.call(this, { ...init, save: null, modules: [], arena: structuredClone(config) } as typeof init);
  };
  let panel: ArenaPanel | null = null;
  const handle = (SimClient.prototype as unknown as { handle(m: SimToMain): void }).handle;
  (SimClient.prototype as unknown as { handle(m: SimToMain | ArenaStatus): void }).handle = function (m) {
    if (m.type === 'arenaStatus') panel?.status(m);
    else handle.call(this, m);
  };

  await import('../main');

  const send = (c: ArenaCommand) => client?.post(c as never);
  const resync = () => client?.post({ type: 'resync' });
  const playCard = () => document.querySelector<HTMLElement>('#ui .play');
  panel = new ArenaPanel(document.getElementById('ui')!, config, {
    rules(r) {
      config.rules = r;
      saveConfig(config);
      send({ type: 'arena', cmd: 'rules', rules: r });
    },
    rebuild(s) {
      config.shape = s;
      saveConfig(config);
      if (client && lastInit) client.start(lastInit);
    },
    reset() {
      send({ type: 'arena', cmd: 'reset' });
      resync();
    },
    spawn: (archetype, n) => send({ type: 'arena', cmd: 'spawn', archetype, n }),
    clear: () => send({ type: 'arena', cmd: 'clear' }),
    heal: () => send({ type: 'arena', cmd: 'heal' }),
    // the game's click-to-play card takes the pointer back (inside this click, so the browser allows it)
    resume: () => playCard()?.click(),
  }, sandbox);

  // the panel shows whenever the game is paused (its click-to-play card is up)
  setInterval(() => {
    const card = playCard();
    panel!.show(!!card && !card.classList.contains('hidden'));
  }, 150);

  window.addEventListener('keydown', (e) => {
    if (e.repeat || (e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
    const act: Record<string, () => void> = {
      F2: () => {
        send({ type: 'arena', cmd: 'reset' });
        resync();
      },
      F3: () => send({ type: 'arena', cmd: 'spawn', archetype: null, n: config.rules.waveSize }),
      F4: () => send({ type: 'arena', cmd: 'clear' }),
      F6: () => send({ type: 'arena', cmd: 'heal' }),
    };
    if (!act[e.code]) return;
    e.preventDefault();
    act[e.code]();
  });
}

bootArena().catch((err) => {
  console.error(err);
  document.getElementById('ui')!.innerHTML = `<pre style="color:#fff;padding:20px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
