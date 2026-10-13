# The combat arena

A big bowl to fight in over and over while tuning combat, monsters and followers. It runs the game's own code (the
same sim, AI, champion controller, renderer and HUD), on its own dev server, with its own save slot. Your changes
reach the game only when you promote them.

```bash
npm run arena          # http://localhost:5202/  (the game's dev server stays on :5201)
```

## Playing

- **Esc** pauses and opens the **arena panel**. Settings apply live and are remembered in this browser. Click
  **▶ Fight** (or anywhere on the pause card) to go back in.
- **F2** resets the round: the floor is cleared, the racks refilled, and the champion and guards are back at the spawn.
  **F3** spawns a wave now. **F4** clears the monsters. **F6** heals the champion.
- The plate at the top left shows the round's time, kills, deaths, guards, the next wave, and every live monster's HP.
- The game's dev keys work too (**F9** fly mode). Invincibility is the panel's, not `?god`.

| Panel section | What it sets |
|---|---|
| Monsters | Which archetypes spawn (+1 spawns one now), how many alive at once, how often, how many per wave, their level, and a round limit. Archetype stats are the base ones from `sim/monsters-gen.ts`, not the game's ±15 % rolls, so fights are comparable. |
| Guards (followers) | How many guards, their level, their spear, how soon a fallen one is replaced, and whether they **follow you** or hold posts by the spawn. |
| Champion | Level, spears and respawn delay (they take effect at the next spawn: F2), invincibility. |
| World | A fixed hour of day (light and monster sight follow it), or the normal clock; how long bodies lie before they're cleared. |
| Arena | Radius (default 22 tiles: about 350 m across), the bowl's wall height (default 60 m, so flyers have room), obstacle density, and a layout seed. These rebuild the arena (**Rebuild arena**). |

**What's in the bowl:** rock pillars (10–30 m), arches to walk under and stand on, towers with overhanging caps, walls,
runs of hop blocks (each a jump higher than the last), a plateau up a ramp, low hills, and spear racks (one at the
spawn). All rock can be climbed. Ground monsters can't follow you onto rock, so they wait at its foot as they do at a
cliff in the game. Flyers come up after you.

**How the monsters behave:** the arena runs the game's own **raid** behavior with the whole floor as the "village".
Monsters roam the floor and attack the nearest person in sight (the game's 13-tile raid sight, favoring guards over the
champion). They flee when badly hurt and come back. The arena adds no AI of its own. To change how they fight,
change the game's code, in the sandbox.

## The sandbox: changing combat without changing the game

`src/arena/sandbox/` mirrors `src/`. A file at `src/arena/sandbox/sim/combat.ts` **stands in for** `src/sim/combat.ts`
everywhere in the arena: in the page, the sim worker, and `npm run arena:test`. The game's own dev server, build,
tests and deploy never look in the sandbox, so nothing there reaches the game until you promote it.

```bash
npm run arena:fork -- src/sim/combat.ts      # copy a game file into the sandbox; edit the copy, play the arena
npm run arena:status                         # each sandbox file: edited? has the game changed since the fork?
npm run arena:diff                           # exactly what promoting would change in the game
npm run arena:test                           # the whole test suite, against the sandbox
npm run arena:typecheck                      # the typecheck, with the sandbox in place
npm run arena:sync -- sim/combat.ts          # merge the game's own later changes into the sandbox copy
npm run arena:promote -- sim/combat.ts       # port it: merge into the game, typecheck + test, clear the sandbox copy
npm run arena:promote -- --all               # everything in the sandbox
npm run arena:drop -- sim/combat.ts --yes    # throw a sandbox copy away
```

- **Fork only what you're changing.** Everything else comes from the game as it is, so the arena keeps up with the game
  for free. Imports inside a sandbox copy resolve as if it sat in `src/`, so a copy works unchanged.
- **Forking records the fork point** (`src/arena/sandbox/.base/`). If the game file changes meanwhile, `diff` and
  `promote` do a three-way merge: your changes and the game's are both kept. When both touched the same lines,
  promote refuses; `arena:sync` puts conflict markers in the sandbox copy for you to resolve.
- **Promote is safe to try.** It writes the game files, runs `tsc` and the full `vitest` suite, and if either fails it
  puts the game files back and leaves the sandbox alone. On success the sandbox copies are deleted and the change
  sits in your working tree for review (`git diff`) and commit. It never commits.
- **Tests for sandbox work** go in `test/arena-sandbox.test.ts`, inside `describe.runIf(import.meta.env.VITE_ARENA)`,
  so they run under `npm run arena:test` and are skipped by the game's `npm test`. When you promote a file, move its
  tests into the game's own test files (without the `runIf`).
- **Porting checklist:** `arena:status` (nothing in conflict), then `arena:diff` (read it), then `arena:test`, then
  `arena:promote -- <file>`, then move that file's tests out of `arena-sandbox.test.ts`, then `git diff`, play the
  game, and commit.

### In the sandbox now

| File | Change | Why |
|---|---|---|
| `sim/monster-ai.ts` | Raiders with no house left to break into keep prowling instead of standing still. | A bug in the game too: `raid()` called `sim.stop()` every tick once no house had anyone in it, so raiders inside the walls stood almost still. The arena runs on raid behavior, so it needs the fix. |
| `sim/village.ts` | **Followers:** guards tagged `follower` follow the champion. They fight the nearest monster close to both of them (a spear thrown first), pick up spears lying close by, and fan out around the champion. | What the arena's "Follow me" setting uses. The game has nothing that tags a guard as a follower yet, so promoting this changes nothing in the game until something does. |

Tests for both are in `test/arena-sandbox.test.ts`.

## How it's wired

The arena changes almost nothing in the game's code. Everything arena-specific is in `src/arena/`, plus these:

| Where | What |
|---|---|
| `arena.html`, `vite.arena.config.ts` | The arena's page and dev server (:5202). |
| `dev/arena-shadow.ts` | The Vite plugin (arena config only): resolves sandbox copies in place of game files; points `src/sim-client.ts` at the arena's worker; lists the sandbox for the panel. |
| `tsconfig.arena.json` | The arena's typecheck (the game's `tsconfig.json` excludes the sandbox). |
| `scripts/arena.mjs` | The sandbox commands above. |
| `src/render/terrain.ts` | One hook, `Terrain.featureBuilder`, so the arena can supply its rock mesh. |

At runtime: `arena-main.ts` sets the game's URL switches (its own save slot `arena`, cleared each load; no god; map
revealed), installs the rock-mesh builder, adds the arena's settings to the worker's init message, then boots the
game's `main.ts`. In the worker, `arena-hooks.ts` loads before the game's worker and replaces `Island.create` with
`ArenaSim` (the game's `Sim` on the bowl, no game over, an optional fixed hour) plus `ArenaDirector` (spawning,
guards, respawn, bodies, status). The arena's own commands travel alongside the game's messages.

| File | Role |
|---|---|
| `geometry.ts` | The bowl and its rock, pure and seeded: ground heights, blocked tiles, rock triangles. |
| `arena-sim.ts` | `ArenaSim`: builds the arena world and fills in the game's island layout for it. |
| `director.ts` | `ArenaDirector`: waves, guards, champion respawn, body cleanup, status. |
| `rules.ts` | The settings (live rules and the rebuild-only shape), defaults, validation, message types. |
| `arena-hooks.ts`, `arena.worker.ts` | The worker side. |
| `arena-main.ts`, `panel.ts`, `mesh.ts`, `arena.css` | The page side. |

**Rock is tile-aligned on purpose.** The sim blocks whole 8 m tiles and won't let the champion stand at ground level on a
blocked tile unless climbing. So rock whose face stood inside a tile would stop you meters short of it, unable to start a
climb. Every block on the floor covers whole tiles, and the bowl's wall rises right at the edge of the last floor
tile. `test/arena.test.ts` checks this. (Terraformer spires in the game don't follow this rule, so the same
stopping-short can happen there.)

## Known limits

- The game's HUD still shows village things that mean nothing here (food, lambs, the journal's village tabs).
- Flyers stooping low pass through rock, as they do over terraformer spires in the game.
- With a fixed hour the clock still runs underneath (timers keep working), so the journal's day count advances.
