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
| Mouse wheel | switch weapon (sword, spear), either way, as in Counter-Strike. With no spears it stays on the sword |
| W A S D | move |
| Shift | sprint (uses stamina) |
| Left click | swing the sword, or thrust the spear. **Where you aim picks the wound**: head (×1.5), arms, legs, or the monster's signature limb (club arm, horns, wings, jaws…) |
| Right mouse (hold) | raise the shield, with either weapon: blocks 75 % of a blow from the front, costs stamina |
| 1 / 2 | sword / spear. The spear's thrust reaches 3.4 m (the sword 2.4 m) on a narrower line, for 15 piercing every 0.8 s (the sword 12 every 0.6 s). The shield goes with either. The gods' blessings on the sword (`setWeapon`) don't carry to the spear |
| R | hold to draw the spear in hand back over your shoulder, let go to throw it (aimed where you look as you let go; a tap throws too). Spears are real items: you carry up to 3, a thrust keeps yours, and a thrown one lies where it fell until someone picks it up (walk over it, or E). The village rack holds 6 more. Out of spears, you're back to the sword |
| Space | jump (costs a little stamina; no jumping while dragging) |
| C | dodge: a quick dash with a moment of invulnerability |
| E | interact: bind a downed monster, drag a body, let go, open the altar, talk |
| F | finish a downed monster |
| T | torch on/off (it takes your shield hand) |
| Q | inspect what you're looking at |
| V | first / third person camera (also the button at the bottom right) |
| M | map |
| Z | minimap range: 60, 120 or 250 m (remembered). The minimap, top right, turns with you (your heading is up, N on its rim) and shows the ground around you with hillshading, the compass's landmarks (pinned to the rim when farther) and the monsters and villagers in sight |
| Tab | journal: Village (jobs), Monsters, Book of Creation, Chronicle, Gods, Settings (sensitivity, invert Y, FOV, shadows, volume, key bindings). Drag its header to move it (it stays there); double-click the header to center it again |
| Esc | pause; Esc again (or a click) resumes. In Chrome and Edge the game goes fullscreen when you click into it, which is what lets Esc resume: hold Esc to leave fullscreen (Journal → Settings → Fullscreen turns it off). Outside fullscreen the browser takes the mouse on Esc and only gives it back for a click, so there the pause card says to click |

A game day lasts 8 real minutes: 4 of daylight (06:00–18:00) and 4 of night.

**Pausing.** Esc pauses: the island stops (the sim, the picture and the sound) until you click back in.
- Losing the mouse any other way (alt-tab) pauses too, and so does loading: the island waits at the click-to-play card.
- The journal and map opened from the pause keep it paused. Closing them goes back into play.
- Opened during play (Tab, M), they don't pause: the world keeps running while you read, and your champion holds his
  ground and strikes back at anything attacking him.
- A paused game waits in a hidden tab too. Once you close it the island runs on: the next load catches up the time
  you were away, as before.

## How to play

- **Find lairs.** They're hidden in the hills; walk within 40 m of one to mark it on your map and compass. A monster
  caught resting in its lair takes double damage from your first blow.
- **Fight.** A red ring on the ground (and a red arc at the screen edge) means a blow is coming in 0.8 s: dodge (C) out of
  it, step behind the beast, or take it on your shield. Cripple legs to slow a monster, cripple its signature limb to
  blunt its special.
- **Spears.** Picking one up when you carry none puts it straight into your hand (thrown your last? walk over it and
  it's ready again). With others carried, what's in hand stays your choice.
- **Capture.** At 20 % HP a monster collapses (yellow ring). Press **E** to bind it and walk it home: it follows on a
  rope, and villagers who see you help pull. Press **E** at the altar to burn it alive for its full HP in favor, or
  **F** to finish it where it lies.
- **Defend.** A scream shows a red **!** on the compass toward the captive. Strike the carrier and it drops its
  prisoner. The shofar means a monster is at the walls.
- **Stamina** (the green bar) is for moving, not fighting: swings and thrusts are free.
  - **Costs:** a dodge costs 20, a jump 8, sprinting 10 a second, and a blow on your shield half the damage it stops.
  - **Coming back:** stamina returns at 30 a second, half a second after you last spent any.
  - **Last breath:** a dodge or a jump goes through with whatever is left, even below its cost.
  - **Winded:** at 0 you can't sprint or raise the shield until the bar is back to a quarter, but you can still swing,
    and dodge and jump again as soon as any stamina comes back.
- **Judgment** falls at midnight (every 8 minutes): the god with more favor today adds a creation to the world.
- You win when all six monsters are dead, and lose when every villager is.

### Climbing (terraformer islands)

Cliffs on terraformer islands can be climbed, and so can spires, arch legs, overhangs, the nephil, the ziz and the
saraph.
- **Design:** `docs/climbing-design.md`.
- **Build plans:** steps 1–4 of it are built, one plan each: `docs/climbing-phase1-plan.md` to
  `docs/climbing-phase4-plan.md`.
- **Start:** walk into a cliff face (steeper than 50°) and keep pushing forward for a moment. Or hold **Space** while
  you're in the air near one, which also catches the lip if you step off a cliff top holding Space.
- **On the wall:** W/S climb up and down (1.8 m/s), A/D traverse, Shift + a direction lunges 2 m. Space jumps off if
  you're looking away from the wall, otherwise it's a lunge up. C lets go. At the top you pull yourself over the lip
  automatically, if there's room to stand there.
- **Stamina** drains while you hang (6/s moving, 3/s still, ×1.5 in rain) and doesn't regenerate on the wall. At 0
  you fall. A hit knocks you off.
- **Falls** hurt: from about 4 m up your legs take damage, and falling from about 18 m kills. Water at least 1 m deep
  breaks any fall. Walking off a cliff edge drops you; steep faces can't be stood on, so you slide down them.
- **Monsters** can only hit you if you're within their vertical reach: a nephil reaches about 7 m up, a tannin 3 m.
  A ground monster that can't reach or follow you waits at the foot of the cliff, prowling and roaring, for 1.5 game
  hours, then gives up and leaves you alone for an hour (unless you hit it). Flyers come up to your height.
- **Rock** (spires, arches, overhangs) is solid: you can't walk through it, you can stand on top of it, and you can
  walk under an arch. Climbing a face that leans out past vertical drains stamina twice as fast. Undersides that face
  more than 45° down are ceilings: you can climb up to one but not along it.
- **The nephil and the flyers (ziz, saraph)** can be climbed. Getting on:
  - press **Space** beside a downed one;
  - jump at it with Space held in the 1.5 s after its blow lands;
  - or drop onto it from above, which grabs it wherever you land, with no fall damage.

  On its body, WASD moves over it at 1.8 m/s. W goes up a leg, or ahead along its shoulders when you're on top of
  them. Shift + a direction lunges.

  Your view turns with it, and takes 30 % of its sway. On its shoulders and other tops you stand, and stamina comes
  back; anywhere else it drains as on rock.

  C lets go, Space while looking away jumps off, and climbing down a leg puts you back on your feet. A hit from another
  monster knocks you off.
- **It fights back.**
  - **Shakes:** about every 3 s (5 s on a flyer) the body you're on shakes, and it shudders for 0.6 s first. Hold
    **right mouse** to hold on: it costs 15 stamina when the shake lands. Not holding on, you're thrown off and the
    fall hurts. Holding on also stops you moving.
  - **The nephil's grab:** it reaches for you with its free (left) arm when you're on its shoulders, head or arms, or
    on the front of its body or thighs. If you're still there when its hand closes, it tears you off and hurls you
    away. Climb round its back or down its shins, or sever that arm.
- **Strike from its body:** **left click** hits the part you're on (a leg, the body, an arm, a wing), at double
  damage. The head takes triple and staggers it for 2 s (no shakes, no grab). With the spear in hand (2) it's a thrust:
  the same doubling, and the spear stays in your hand. Right mouse is still holding on. Sever the limb you're on and
  you fall with it.
- **Flyers carry you off.**
  - **Where it goes:** a ziz or saraph you're on takes off. It climbs to the nearest floating isle and circles a few
    meters over its top: let go (C) to land on it. Get on one from up on an isle and it flies you home to its lair.
    With no isles on the island, it circles 25 m up.
  - **Riding it:** you sit astride, so anywhere on the upper half of its back or wings stamina comes back between its
    rolls.
  - **Bringing it down:** sever its wings (its signature limb) while you ride, and it crash-lands, downed.
  - **The isles:** floating isles can only be reached this way.
- You can't block, use E/F, or swing on a wall. On a monster you can swing or thrust, but not throw.

## URL parameters (dev)

All of the base game's parameters (`?slot`, `?fresh=1`, `?seed`, `?timescale=N`, `?at=HH:MM`, `?reveal=1`, `?god=1`,
`?nogod=1`, `?ai=manual`, `?devinstall=…`, `?judge=human:300`, `?debug=1`,
`?shot=ms`, `?panel=village|altar|map`) plus:

| Param | Effect |
|---|---|
| `?pose=x,z,yawDeg,pitchDeg` | start the champion at a tile, looking that way |
| `?pitch=deg`, `?yaw=deg` | hold the view (headless screenshots) |
| `?nolock=1` | drag-to-look without pointer lock; it doesn't pause on loading (Esc pauses, clicking the card resumes) |
| `?hideplay=1` | hide the click-to-play card, and never pause (headless screenshots) |
| `?noshadow=1` | shadows off |
| `?third=1` | start in third person |
| `?fly=m` | start in fly mode, m meters above the sea (aerial screenshots) |
| `?terrain=off` | a new island ignores the terraformer's saved terrain (procedural) |
| `?terrain=default` | a new island uses the terraformer's default settings, which have floating isles, whatever is saved |
| `?script=fight\|downed\|drag\|carry\|nephil\|ziz\|saraph` | a dev scenario, run once the world has loaded. `nephil`, `ziz` and `saraph` put the nearest one a tile ahead, landed, feeding and leaving you be; add `-downed` (`nephil-downed`) to put it there downed. Seed 1 has all three; seed 7 has no nephil |
| `?hold=forward:5000:9000,jump:…` | hold actions from/to ms after the world loads (headless climbing checks; use with `?nolock=1`). `action:from:to`, with colons. A one-shot action like jump is pressed again every 250 ms while held and not climbing. `grip` is the right mouse (block, or hold on to a body) and `attack` the left |
| `?climblog=1` | log the controller's mode, position, feet and stamina every second, plus the body being ridden and the nearest climbable monster. Also logs shudders, shakes, grabs, throws, blows from the body and snaps to the sim |
| `?mountany=1` | any way of getting onto a body works, so you can climb a standing nephil (headless checks) |
| `?autogrip=1` | hold on automatically through each shudder of the body you ride (headless rides) |

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
  - marks the rest of the steep ground, and anything under standing rock, as `cliff` (protected; not walkable, but
    the champion can climb it).
- Spires, arches, floating isles and overhangs can't be heightmap ground. `src/render/feature-mesh.ts` draws them in
  the terraformer's palette from its own mesh, and their footprints are cliff. The champion collides with that mesh
  (plus an undrawn skirt at spire bases, where the drawn mesh stops short of the ground).
- Saves keep the settings and the finished heights (about 100 KB), so a saved island never changes if the terraformer
  or its file changes.
- Known gaps: caves and caverns are only visible where they open at the surface. Monster strikes against the
  champion are 3D (climbing), but everything else in the sim is still flat 2D: monsters see across a cliff edge, and
  strike each other and villagers across one. The feature mesh is built on the main thread at load (about 1 s).
- Climbing's known 2D leftovers: blood from a hit on a climber bursts at ground level; the god-module API doesn't see
  the champion's height; a flyer stooping on a climber can clip into the rock face; there's no climbing animation in
  third person yet (on a monster, the champion's body just stands at the eye's spot).
- Monsters fighting back (phase 4) covers only the climbable three: the nephil, the ziz and the saraph. Anak,
  Se'ir, Lilit, Re'em, Rahab and the tannin have no climb volumes yet (phase 5). Flyers fly through rock, so a ridden
  one waits outside an isle's rim until it's above the top rather than through it.

## Code map

- `src/sim/`: the deterministic simulation (no DOM), shared with the top-down build, plus:
  - `ground.ts`: the shared height function, exactly matching the terrain mesh;
  - `body.ts`: bodies in meters;
  - `aim.ts`: hit zones by aim;
  - `champion.ts`: poses, swings, dodge, block, interact, hold and autopilot, rope trail;
  - `climb-body.ts`: climb volumes (capsules between named body points) and ride rules (shakes, the grab, flying),
    per climbable archetype; the ridden monster itself is in `monster-ai.ts` (`ridden`).
- `src/input/`:
  - `controls.ts`: keyboard, mouse, pointer lock and bindings;
  - `controller.ts`: client-side movement, collision, stamina and climbing (walk, air, wall, mantle and mount modes);
  - `climb-surface.ts`: face normals, slopes and face distances on the ground, for climbing;
  - `feature-surface.ts`: the feature mesh as climbing sees it (floors, rays, normals, the body test), hashed per tile.
- `src/render/`:
  - `renderer.ts`, `terrain.ts` (heightmap and instanced vegetation), `structures.ts` (village, altars, lairs);
  - `entities.ts`: interpolation buffer, rigs or module shapes, look-ray picking;
  - `rigs.ts` (procedural creature rigs), `viewmodel.ts` (sword arm and shield or torch), `sky.ts`, `particles.ts`;
  - `climb-rig.ts`: a monster's climb volumes on its current pose, a rider's place on them, and the rules for getting on.
- `src/audio/audio.ts`: positional sound, played from CC0 recordings in `public/audio` (credits in `public/audio/credits.md`).
- `src/ui/`: `hud.ts` (crosshair, compass, bars, prompts, hints), `map.ts`, `ui.ts` (journal, altar, cards).
- `src/god/`: the decree → implement → validate → install pipeline (prompts updated for first person).

## Tests

```bash
npm test                                      # all suites, including test/fp.test.ts (first-person rules)
                                              # and test/climb-*.test.ts (climbing: controller, sim, feature mesh, monsters)
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
