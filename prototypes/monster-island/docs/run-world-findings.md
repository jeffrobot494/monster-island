# RUN.world findings (2026-10-10)

What we learned while checking whether Monster Island's in-game LLM agent can run on RUN.world.
SDK `@series-inc/rundot-game-sdk` 5.29.1, `rundot` CLI 7.16.0 → 7.17.0. Docs: https://series-1.gitbook.io/rundot-docs/

## Summary

- **The core design ports.** Generated code loaded through `blob:` URLs, in workers and on the main thread, works inside the RUN.world host. The host's own (not yet enforced) security policy explicitly allows `blob:` for scripts and workers.
- **The agent backend has to change.** Today the Vite dev server spawns the `claude` CLI (`dev/claude-code-middleware.ts`), and a deployed build has neither. RUN.world's hosted `RundotGameAPI.textGen` replaces it. A working end-to-end test exists in `prototypes/run-llm-test`.
- **Saves will probably have to change.** Browser storage works today, but the host's planned sandbox would block it. Plan to move `LocalSaveStore` to `RundotGameAPI.deviceCache` or `appStorage`.
- **Deploys:** normal Vite builds hang at "Processing game file". Two workarounds deploy today (see the Deploy bug section below).

## How Monster Island uses the agent today

- `src/platform.ts` picks the AI provider. The `'run'` platform is stubbed as "Phase 2, not built yet".
- `src/god/providers/claude-code.ts` POSTs to `/dev-ai/claude-code`. That is a dev-only Vite middleware that runs `claude -p` on the developer's machine with structured output and a 15-minute timeout.
- Generated modules are **not** applied through Vite hot reload. They are turned into `blob:` URLs and loaded with `import()` inside module workers (`src/sim/island.ts:24`, `src/workers/harden.ts:9`), and stored in the save file. This runtime-loading path does not depend on Vite.
- Workers are created as `new Worker(new URL('./workers/*.worker.ts', import.meta.url), { type: 'module' })` (`src/sim-client.ts:24`, `src/god/validation-host.ts:9`).
- `import.meta.env.DEV` (`devMode` in `main.ts`) is `false` in a deployed build. Anything gated on it disappears there.

## Host capability probe

The probe was a throwaway unlisted game, "Monster Island Host Probe" (id `0z7FxkUadKSq3bK2p9PW`), loaded in a signed-in browser. The game runs in a cross-origin iframe at `https://<gameid>.h5-apps.getreel.com`.

| Check | Result |
|---|---|
| `import()` of a `blob:` URL, main thread | ok |
| `import()` of a `data:` URL, main thread | ok, but reported as a violation |
| `new Function` | ok, but reported as a violation (eval) |
| Module worker from a `blob:` URL | ok |
| `import()` of a `blob:` URL inside a worker | ok |
| `import()` of a `data:` URL inside a worker | ok |
| `localStorage` | ok |
| `indexedDB` | ok |

### Content-Security-Policy (report-only)

The host sends `Content-Security-Policy-Report-Only`. Violations are logged but **nothing is blocked yet**. It is probably the policy they intend to enforce:

```
default-src 'self';
script-src 'self' https://venus-static-01293ak.web.app 'wasm-unsafe-eval' blob:;
worker-src 'self' blob:;
connect-src 'self' https://venus-static-01293ak.web.app https://storage.googleapis.com https://res.cloudinary.com
            https://*.h5-apps.getreel.com https://h5-apps.getreel.com https://api.run.world https://api.run.game wss://ws.run.game;
img-src / media-src: 'self' data: blob: + RUN CDNs;   style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
sandbox allow-scripts allow-forms allow-pointer-lock;
```

What changes if they enforce it:

| What | Enforced outcome | Monster Island impact |
|---|---|---|
| `blob:` scripts and workers | allowed | none, this is our mechanism |
| `data:` script imports | blocked | only used by Vitest under Node |
| `eval` / `new Function` | blocked | none, `ast-check.ts` already rejects them |
| Inline `<script>` | blocked (no `'unsafe-inline'`) | breaks single-file builds (deploy workaround 1) |
| Sandbox without `allow-same-origin` (opaque origin) | localStorage/IndexedDB likely throw | `LocalSaveStore` must move to the SDK's storage |
| Same sandbox | workers loaded from a file URL *may* fail (untested) | consider `?worker&inline` (blob workers) |
| `connect-src` | only RUN domains | `textGen` uses `api.run.world`, fine; no third-party fetches |

`rundot game preflight` agrees: *"Browser storage APIs are blocked in game iframes. Use RundotGameAPI.deviceCache for local storage or RundotGameAPI.appStorage for cloud storage."*

## textGen (hosted LLM)

- Call: `RundotGameAPI.textGen.requestChatCompletionAsync({ modelClass, system, messages, responseFormat })`. Results come back OpenAI-shaped: the text is at `choices[0].message.content` and the model that actually ran is in `res.model`. (`RundotGameAPI.ai` is deprecated; it is the same thing.)
- `modelClass`: `'quick'` (the default), `'standard'` or `'power'`. Exact model ids are optional and fall back to the class. Anthropic, OpenAI, Gemini and DeepSeek models sit behind it.
- Structured output: `responseFormat: { type: 'json_schema', schema }` is enforced by the server. On Anthropic models it retries once on a schema failure, then returns HTTP 422.
- Streaming, tool calling, prompt caching and reasoning effort are supported. Rate limits are set per creator.
- **Cost:** billed in credits. With no config file the platform's default caps apply (about $500 per game per day, about $10 per user per day). **The first `rundot deploy` that detects textGen writes a permissive `{}` config that removes the caps.** Commit your own `rundot/textGen.config.json` (`maxOutputTokens`, `dailyCreditCap`, `perUserDailyCreditCap`, `allowedModels`). Note: the policy is read from the game's *public* release.
- Measured in `run-llm-test` (Playground): `modelClass: 'standard'` resolved to `gpt-5.6-terra`, and a full rewrite of a roughly 30-line module took 4–6 s.
- Not yet checked: whether a single call can run as long as our current 15-minute agent calls.

## Deploy bug: builds hang at "Processing game file"

Symptom: `rundot deploy` uploads, sits at "Processing game file", and after about 6 minutes (once 10) fails with
`InvalidOperationException: SSE stream ended without a result event.` A version entry is created, but no release points to it, so there is no share link. CLI 7.16 and 7.17 behave the same.

All of these went to the same throwaway game, with the same CLI, on the same day:

| Build | Result |
|---|---|
| `index.html` + thumbnail only, no JS | ✅ seconds |
| Everything inline in one `index.html` (probe; run-llm-test single-file build) | ✅ |
| `side-scroller/dist` copied unchanged (many `.js` files, SDK vendored as `vendor/rundot-sdk/rundot-game-api/index.js`) | ✅ 13 s |
| One trivial external `.js` (`assets/` or `js/`; classic, `defer` or `type="module"` tag) | ❌ hang |
| Plain Vite build with no SDK | ❌ hang |
| Full probe (Vite, workers, blob imports), with or without `new Function` | ❌ hang |
| The trivial `.js` **+ the vendored SDK files and script tag from side-scroller** | ✅ 5 s |
| Same, SDK folder renamed to `lib/x/api/` | ✅ 5 s, so detection is not path-based |
| run-llm-test standard build (`rundotGameLibrariesPlugin` + `rundotGamePlaygroundPlugin`, SDK bundled into `assets/index-*.js`, plus the plugin's external `_rundot_bootstrap.*.js`), minified | ❌ hang |
| Same, unminified (`initializeTextGen` present in the bundle) | ❌ hang (10 min) |

**Conclusion:** processing only completes when a build containing JS also ships the SDK as a standalone entry module (the unbundled `rundot-game-api/index.js` plus its chunks). The documented Vite-plugin setup hangs. This looks like a platform bug. It has not been reported to RUN.world yet; the docs MCP has a `sendFeedback` tool for that.

**Confirmed 2026-10-10:** `prototypes/first-person` (normal Vite build with Three.js, two module workers and a `.glb`, plus the SDK vendored by `scripts/vendor-rundot.mjs`) deployed in 13 s as game `9Fj1bofR40DUGCYtatbu`.

**Workarounds:**
1. **Single-file build.** Use `vite-plugin-singlefile` and inline the SDK's bootstrap script after the build (`prototypes/run-llm-test/inline-bootstrap.mjs`). It deploys, but it depends on inline scripts, which the pending CSP would block.
2. **Vendor the SDK the way side-scroller does.** Its `build.mjs` copies the SDK into `dist/vendor/rundot-sdk/` and adds `<script type="module" src="./vendor/rundot-sdk/rundot-game-api/index.js">`. This keeps real `.js` files and is the better long-term bet for Monster Island.

### Other deploy gotchas

- A thumbnail is required: `dist/thumbnail.jpg`, a **512×512** JPEG under 1 MB. The preflight message says 1280×720, but the server rejects that size.
- Preflight warns when the viewport meta lacks `user-scalable=no` / `viewport-fit=cover`.
- `rundot init` writes `game.config.prod.json`. Deploys are unlisted by default, and private share links only load for a signed-in RUN.world user (signed-out headless Chrome gets "Game Not Found").

## Testing setup that worked

- **Playground** (local Vite dev server with RUN.world plugins, SDK calls go to the playground backend): `npm run dev`. `rundot playground grant-access --expires-in-days 14` writes a `pk_` key to `.env.local` for headless sign-in. Revoke it with `rundot playground revoke-access`. Optional dev dependencies: `firebase@^12.12.1`, `@revenuecat/purchases-js@^1.39.1`.
- **Headless browser from WSL:** start Windows Chrome with `--headless=new --remote-debugging-port=9333`, then drive it over CDP with Windows Node 22 (`C:\Program Files\nodejs\node.exe`, which has a global `WebSocket`). WSL cannot reach the port, but Windows Node can. Scripts: `%TEMP%\cdp-probe.mjs` (console from all frames, plus a screenshot) and `%TEMP%\cdp-drive.mjs` (types into the chat and screenshots).

## Artifacts

| What | Where |
|---|---|
| LLM code-rewrite test app ("Shape Rewriter", game `H5twfen7soEA8k1fZDSh`) | `prototypes/run-llm-test` (not committed); deployed: https://w.run/u/H5twfen7soEA8k1fZDSh/private?k=fbd56219764f63e3119e60c8f4815eca |
| Capability probe game | `0z7FxkUadKSq3bK2p9PW`: https://w.run/u/0z7FxkUadKSq3bK2p9PW/private?k=4ec05d3fd76a46505725cb092708f0a6 (latest version is a deploy-bisect build, not the probe) |
| Throwaway bisect games | "MI Probe B" `8KlgGZAW6h8Nlv9YYoJZ`, "MI Probe C" `nfnPgyXrG3qyD30goZG9` (never deployed successfully) |
| CLI backup | `~/.local/bin/rundot.bak` (7.16.0) |

## Suggested next steps

1. Report the deploy hang to RUN.world, using the table above.
2. Move Monster Island's build to the vendored-SDK layout (workaround 2) and confirm it deploys.
3. Build `RunTextGenProvider` behind the existing `AiProvider` interface, and wire the `'run'` platform in `src/platform.ts`.
4. Replace `LocalSaveStore` with SDK storage. Consider inline (blob) workers so the code survives an enforced sandbox.
5. Check the `textGen` timeout and cost for our large propose/implement/repair prompts.
