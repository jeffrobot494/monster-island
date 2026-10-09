# Monster Island

A small blocky island where a god (Claude) writes new **JavaScript gameplay modules** that change how the island works.
Design docs: [`docs/monster-island-mvp-spec.md`](docs/monster-island-mvp-spec.md) (scope) and
[`docs/monster-island-technical-brief.md`](docs/monster-island-technical-brief.md) (vision).

This is **Phase 1** (the local proof of concept): everything runs locally, and the god uses your Claude subscription through the
Claude Code CLI. There's no Run SDK, API key, or credits.

## Run it

```bash
npm install
npm run dev:local        # http://localhost:5173
```

Requirements: Node 20+, and the `claude` CLI installed and logged in. The dev server spawns `claude -p` for each god call
(see `dev/claude-code-middleware.ts`). It strips `ANTHROPIC_API_KEY` from the child's environment so the subscription is used.
Optional model overrides go in `.env.local`: `CLAUDE_CODE_PROPOSE_MODEL=sonnet`, `CLAUDE_CODE_IMPLEMENT_MODEL=opus`.

### URL parameters

| Param | Effect |
|---|---|
| `?slot=name` | separate save slot (several test islands side by side) |
| `?fresh=1` | wipe the slot and start a new island |
| `?seed=123` | island seed for a new island |
| `?ai=manual` | manual god: canned omens, and you paste module source (exercises validation directly) |
| `?debug=1` | mirror console logs onto the page |

Dev-only (for headless testing): `?nogod=1`, `?skip=N` (fast-forward ticks at boot), `?speed=2`, `?cam=x,z,dist`,
`?auto=1` (auto-pick the first omen), `?manualsrc=fireflies|wading|hang|thrower` (auto-answer the manual god),
`?devinstall=name` (install a reference/broken module directly), `?godlog=1` (open the god panel at boot), `?shot=ms` (hold the load event for screenshots).

## How it works

- `src/sim/`: pure-TS deterministic simulation (no DOM). It runs in the sim worker, the validator worker, and Vitest.
  - `sim.ts`: needs, food, utility behaviors, A* with a repath budget, births and deaths.
  - `module-runtime.ts`: the host API that generated modules call (§5). Per-module attribution, caps, frozen views, faults, quarantine.
  - `ast-check.ts`: acorn-based source rules. `validator.ts`: static checks → install → dawn clone → 2-day soak → tests → visibility → save round-trip.
- `src/workers/`: `harden.ts` stubs `Math.random`, `Date`, timers, and network before generated code loads. Generated code is imported from blob URLs.
- `src/god/`: observation, prompts, schemas, the pipeline state machine, and providers.
- `src/render/`: three.js terrain chunks, composite shapes, particles, emote sprites, and the day/night sky.
- `src/persist/`: `SaveStore` (localStorage locally, enforcing Run's key and size limits).

## Tests

```bash
npm test     # sim determinism, 50-seed sweep, births, AST rules, module runtime, validator vs. broken modules
```

## Dev tools

- `dev/probe-claude.mjs`: the milestone-1 probe of `claude -p` flags. Results are in `docs/probe-results.md`.
- `dev/serve.sh`: (re)start the dev server on :5199. `dev/winshot.sh <url> <out.png>`: headless screenshot via Windows Chrome
  (WSL's Chromium lacks system libraries). Add `&debug=1&shot=ms` to the URL.
