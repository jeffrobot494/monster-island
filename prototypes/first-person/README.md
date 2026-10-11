# Island Humans and Monsters — first person

A real-time, first-person sandbox for desktop, set on an Iron Age island. You are the village's champion: you hunt six
monsters in their hidden lairs while they hunt your people. Each midnight, the god whose followers sacrificed more
favor writes a new **gameplay module** that permanently changes the world. The god runs on Claude.

This is the desktop, first-person version of [`../top-down`](../top-down) (the top-down mobile build of the same design).

- Design: [`docs/design-doc.md`](docs/design-doc.md)
- Tech spec, including the adversarial-review revisions in §14: [`docs/tech-spec.md`](docs/tech-spec.md). It inherits every rule of
  [`docs/base-spec.md`](docs/base-spec.md) that it doesn't change.

## Run it

```bash
npm install
dev/serve.sh            # Vite on :5201; the log prints a LAN token for the AI middleware
# open http://localhost:5201/ in Chrome, Edge or Firefox on a desktop
```

The dev server spawns `claude -p` for each god call. If the CLI is missing, the game falls back to a manual god.

## Controls

| Input | Action |
|---|---|
| Mouse | look (click the game to capture the mouse) |
| W A S D | move |
| Shift | sprint (uses stamina) |
| Left click | swing the sword. **Where you aim picks the wound**: head (×1.5), arms, legs, or the monster's signature limb (club arm, horns, wings, jaws…) |
| Right mouse (hold) | raise the shield: blocks 75 % of a blow from the front, costs stamina |
| Space | jump (costs a little stamina; no jumping while dragging) |
| C | dodge: a quick dash with a moment of invulnerability |
| E | interact: bind a downed monster, drag a body, let go, open the altar, talk |
| F | finish a downed monster |
| R | throw a spear. Spears are real items: you carry up to 3, and a thrown one lies where it fell until someone picks it up (walk over it, or E). The village rack holds 6 more |
| T | torch on/off (it takes your shield hand) |
| Q | inspect what you're looking at |
| V | first / third person camera (also the button at the bottom right) |
| M | map |
| Tab | journal: Village (jobs), Monsters, Book of Creation, Chronicle, Gods, Settings (sensitivity, invert Y, FOV, shadows, volume, key bindings) |

A game day lasts 8 real minutes: 4 of daylight (06:00–18:00) and 4 of night. The world never pauses, even while the journal is open. Whenever you release the mouse, your
champion holds his ground and strikes back at anything attacking him.

## How to play

- **Find lairs.** They're hidden in the hills; walk within 40 m of one to mark it on your map and compass. A monster
  caught resting in its lair takes double damage from your first blow.
- **Fight.** A red ring on the ground (and a red arc at the screen edge) means a blow is coming in 0.8 s: dodge (C) out of
  it, step behind the beast, or take it on your shield. Cripple legs to slow a monster, cripple its signature limb to
  blunt its special.
- **Capture.** At 20 % HP a monster collapses (yellow ring). Press **E** to bind it and walk it home: it follows on a
  rope, and villagers who see you help pull. Press **E** at the altar to burn it alive for its full HP in favor, or
  **F** to finish it where it lies.
- **Defend.** A scream shows a red **!** on the compass toward the captive. Strike the carrier and it drops its
  prisoner. The shofar means a monster is at the walls.
- **Judgment** falls at midnight (every 8 minutes): the god with more favor today adds a creation to the world.
- You win when all six monsters are dead, and lose when every villager is.

## URL parameters (dev)

All of the base game's parameters (`?slot`, `?fresh=1`, `?seed`, `?timescale=N`, `?at=HH:MM`, `?reveal=1`, `?god=1`,
`?nogod=1`, `?ai=manual`, `?devinstall=…`, `?judge=human:300`, `?script=fight|downed|drag|carry`, `?debug=1`,
`?shot=ms`, `?panel=village|altar|map`) plus:

| Param | Effect |
|---|---|
| `?pose=x,z,yawDeg,pitchDeg` | start the champion at a tile, looking that way |
| `?pitch=deg`, `?yaw=deg` | hold the view (headless screenshots) |
| `?nolock=1` | drag-to-look without pointer lock |
| `?hideplay=1` | hide the click-to-play card |
| `?noshadow=1` | shadows off |
| `?third=1` | start in third person |
| `?fly=m` | start in fly mode, m meters above the sea (aerial screenshots) |
| `?terrain=off` | a new island ignores the terraformer's saved terrain (procedural) |

**Dev tools** (dev server only): Journal → Settings → Dev has **New champion now** (also the **F8** key, anywhere,
any time) to crown the next champion immediately instead of waiting for dawn, and **Kill the champion** to test
succession. **Fly mode** (also **F9**) lifts you off the ground: WASD flies where you look, Space up, C down, Shift
for 240 m/s; nothing can hurt you while flying, and F9 again drops you onto the nearest dry land. The other buttons
force a judgment, skip 8 hours, start a raid, install a reference module or toggle fog of war.

Headless screenshots on the Windows GPU: `ANGLE=d3d11 WIN=1600,900 dev/winshot.sh "<url>&shot=6000" out.png`.
(SwiftShader, the default, draws some lit terrain black. That's a software-renderer bug, not a game bug.)

## Terraformer islands

`npm run dev`, then open **http://localhost:5201/terraformer.html**: the Monster Island Terraformer (ported from
`Documents/monster-game/Monster Island Terraformer.html`). Shape the island, then:

- **Save to game** writes the settings to `src/terrain/saved-terrain.json` (`null` = none). Every new island after
  that takes its ground from them; a game already running keeps its island. The file is source: commit it, and RUN
  builds ship that terrain too.
- **Save & start a new island** saves, then opens the game on a new island (`?fresh=1`). Any other tab still running
  the old island stops saving, so it can't overwrite the new one.
- **Use procedural islands** sets the file back to `null`.
- **Height in the game** sets meters per terraformer unit vertically (one unit is one 8 m tile across), and the
  preview is drawn at that scale. At 8 the proportions are the terraformer's own, but cliffs get very tall.

How the game uses it:
- The ground is sampled from the terraformer's surface at every ground vertex (`src/sim/terrain-import.ts`).
- `src/sim/island-import.ts` then:
  - puts the village on the most level land near the usual south-west site and flattens it;
  - puts the High Place on a high, level spot near the center;
  - cuts graded roads, with ramps up cliffs and fords across canyon water, to it and to every lair;
  - joins every other sizeable area with a road;
  - marks the rest of the steep ground, and anything under standing rock, as `cliff` (unwalkable and protected).
- Spires, arches, floating isles and overhangs can't be heightmap ground. `src/render/feature-mesh.ts` draws them in
  the terraformer's palette from its own mesh, and their footprints are cliff.
- Saves keep the settings and the finished heights (about 100 KB), so a saved island never changes if the terraformer
  or its file changes.
- Known gaps: caves and caverns are only visible where they open at the surface. Distances in the sim are still flat
  2D, so monsters can see and strike across a cliff edge. The feature mesh is built on the main thread at load
  (about 1 s).

## Code map

- `src/sim/`: the deterministic simulation (no DOM), shared with the top-down build, plus:
  - `ground.ts`: the shared height function, exactly matching the terrain mesh;
  - `body.ts`: bodies in meters;
  - `aim.ts`: hit zones by aim;
  - `champion.ts`: poses, swings, dodge, block, interact, hold and autopilot, rope trail.
- `src/input/`:
  - `controls.ts`: keyboard, mouse, pointer lock and bindings;
  - `controller.ts`: client-side movement, collision and stamina.
- `src/render/`:
  - `renderer.ts`, `terrain.ts` (heightmap and instanced vegetation), `structures.ts` (village, altars, lairs);
  - `entities.ts`: interpolation buffer, rigs or module shapes, look-ray picking;
  - `rigs.ts` (procedural creature rigs), `viewmodel.ts` (sword arm and shield or torch), `sky.ts`, `particles.ts`.
- `src/audio/audio.ts`: positional sound, played from CC0 recordings in `public/audio` (credits in `public/audio/credits.md`).
- `src/ui/`: `hud.ts` (crosshair, compass, bars, prompts, hints), `map.ts`, `ui.ts` (journal, altar, cards).
- `src/god/`: the decree → implement → validate → install pipeline (prompts updated for first person).

## Tests

```bash
npm test                                      # all suites, including test/fp.test.ts (first-person rules)
TS=1 DAYS=1 npx vitest run test/smoke.test.ts # balance: a real-time day, no player
```

## Deploying to RUN.world

```bash
npm run deploy   # vite build, vendor the RUN.world SDK into dist/, rundot deploy (unlisted)
```

- Game `9Fj1bofR40DUGCYtatbu` (`game.config.prod.json`). Private share links only load for a signed-in RUN.world user.
- `npm run build:run` builds without deploying. `scripts/vendor-rundot.mjs` copies the SDK's `api` entry and its chunks
  unbundled into `dist/vendor/rundot-sdk/` and adds it as its own `<script type="module">`: it reports ready to the
  host, and builds with the SDK bundled into the game's JS hang at "Processing game file" (see
  `../monster-island/docs/run-world-findings.md`). The game code does not import the SDK.
- `public/thumbnail.jpg` must be a 512×512 JPEG. `rundot/textGen.config.json` caps hosted-LLM spend, in credits (1 credit = $0.001): $10/player and $50/game per day.
- Deployed builds have no dev server, so the god is the **manual** one (the Claude Code provider needs
  `dev/claude-code-middleware.ts`). A RUN.world `textGen` provider is the next step.
- Preflight's `sandbox-blocked-modals` check is skipped: all but two hits are `sim.alert(...)`. The real ones are the
  `confirm()` calls in `src/ui/ui.ts` (New island, burning a villager), which the host's sandbox may block.
