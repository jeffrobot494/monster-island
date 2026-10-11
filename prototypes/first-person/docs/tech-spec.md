# Island Humans and Monsters (First-Person Desktop) — MVP Tech Spec

Source design: [`design-doc.md`](design-doc.md) (Oct 9, 2026), with one platform change requested by the
producer: **the game is for desktop, and the player sees the world in first person** instead of on a phone in
top-down view.

Base: this repo is seeded from `~/humans-and-monsters`, the finished top-down build of the same design (itself built
on the tech of the `monster-island` prototype). Its spec is kept as [`base-spec.md`](base-spec.md).

**Inheritance rule.** Every rule in `base-spec.md` (including its §19 revisions, which override its earlier
sections) **still applies unless this document changes it**. This spec covers what changes for first person and
desktop: units, input, the champion controller, combat, rendering, audio, the HUD, and the sim and API changes those
need. Where the design is silent, this spec picks the **simplest thing that plays**, tagged **[gap]**.

---

## 0. Summary of the big decisions

| Topic | Decision |
|---|---|
| Codebase | New repo `~/humans-and-monsters-fp`, a copy of `humans-and-monsters`. Kept: the deterministic sim in a hardened worker, clock and away-time resolver, village, monsters, favor, Judgment, the god pipeline, module runtime, validator, and the dev middleware. Rewritten: renderer (first-person camera, terrain, rigs), input, champion control, combat resolution, HUD. Dev server on **:5201**. |
| Platform | Desktop browsers (Chrome, Edge, Firefox), keyboard and mouse, pointer lock, at least 1280 × 720. Phones and touch are **not supported**: a notice is shown instead. |
| Units | The sim keeps its 128 × 128 grid of 8 m tiles, with positions in tile units. The renderer works in **meters** (1 tile = 8 m). Shape units stay "1 unit ≈ a human's height" and render as **1.8 m**. Every physical constant that a person can see up close (reach, rings, dash, bind range, drag spacing) is re-specified in meters (§2). |
| Champion movement | **Client-authoritative.** The main thread moves the champion at frame rate (WASD, mouse look, collision with unwalkable tiles) and sends its pose to the sim 20 times a second. The sim validates the pose and uses it. Whenever the player can't act (downed, carried, dead, autopilot), the sim takes control and the camera follows the sim. |
| Combat **[gap]** | Melee with the mouse: **left click swings** the bronze sword along a 100° arc in front of you. **The height you aim at picks the hit zone** (head, torso, arm, leg, signature limb). **Right mouse raises the shield** (−75 % frontal damage, costs stamina). **C dodges** (Space jumps) (a 3.5 m dash with 0.3 s of invulnerability). Monster attacks keep the 0.8 s wind-up, now shown by the monster's wind-up pose, a growl from its position, and the red ground ring. Stamina gates sprinting, swinging, dodging and blocking. |
| Capture | Look at a downed monster and press **E** to bind it, then walk it home: it follows on a rope 1.5 m behind you. **F** finishes it. **E** at the altar opens the altar. |
| Torch | **T** swaps the shield for a torch. At night the torch lights about 18 m and widens your sight, but you can't block while you hold it. |
| Exploration | The 3D world is always fully drawn: there is no black fog, and darkness and distance fog do the hiding. The world **map** (M) keeps the fog of war, and lairs are "found" (marked on the map, chronicled) within 5 tiles, as before. |
| Navigation | A **compass strip** at the top of the screen shows the village, the altar, the High Place, found lairs, a pulsing marker toward screams, and the newest creation. |
| Audio | New: WebAudio with **positional** sound (HRTF), so screams, roars and growls come from where they happen. Sounds are CC0 recordings from Freesound in `public/audio` (credits in `public/audio/credits.md`). |
| Creations | Unchanged pipeline and module API. Visibility at eye level is now part of the prompt. The base game's "camera flies to the creation" becomes a compass marker plus a Genesis card. |

---

## 1. Repository and build

```
humans-and-monsters-fp/
  docs/         design-doc.md, base-spec.md (top-down spec, inherited), tech-spec.md (this file)
  dev/          claude-code-middleware.ts, serve.sh (:5201), winshot.sh
  src/
    main.ts           boot, wiring
    protocol.ts       main ⇄ worker messages (input messages added, ENT_STRIDE 15)
    input/            controls.ts (keyboard, mouse, pointer lock, bindings), controller.ts (champion controller)
    sim/              as before, plus ground.ts (shared height function), steer.ts (separation, path smoothing)
    render/           renderer.ts (FP camera), terrain.ts (heightmap mesh), decor.ts, village.ts (static
                      structures), rigs.ts (procedural creature rigs), viewmodel.ts, shapes.ts (module shapes),
                      particles.ts, sky.ts, rings.ts, water.ts
    audio/            audio.ts (sample playback + positional voices)
    ui/               hud.ts (crosshair, compass, bars, prompts), map.ts (2D map canvas), journal.ts (tabs),
                      altar.ts, style.css
  test/
```

`npm run dev`, `npm test` and `dev/serve.sh` (:5201) work as in the base. `?token=` LAN access is kept but only
matters for a second desktop on the LAN.

---

## 2. Units and scale

- Sim positions stay in **tiles** (1 tile = 8 m). The renderer converts with `M = 8` (meters per tile).
- **Ground height** is a pure function `groundY(grid, x, z)` in `src/sim/ground.ts` (meters). It is shared by the
  sim, the champion controller and the renderer, so the camera, the creatures and the terrain mesh agree. It is a
  bilinear interpolation of per-tile heights sampled at tile centers, `tileHeight = (def.height + elev) × 8`, plus a
  deterministic detail term `≤ 0.35 m` from a hash of the integer coordinates (value noise, period 1 tile). Water
  tiles report their bed height. Unwalkable structure tiles (`wall`, `house`) report the height of the neighboring
  walkable ground (min of 4-neighbors) so that structures sit flush.
- **Body sizes:** shape units × 1.8 m × entity `scale`. A villager at scale 1 is 1.8 m tall. Monster visual scales
  are re-tuned for first person (the base scales were exaggerated for top-down readability, and giants have to read
  as giants up close):

| archetype | base scale | FP scale | height | body radius `r` | reach (m) |
|---|---|---|---|---|---|
| nephil | 2.2 | 3.2 | 5.8 m | 1.1 m | 3.6 |
| saraph | 1.3 | 1.6 | 2.9 m (hovering) | 0.7 m | 2.6 |
| seir | 1.5 | 1.5 | 2.7 m | 0.6 m | 2.4 |
| lilit | 1.25 | 1.3 | 2.3 m | 0.45 m | 2.4 |
| rahab | 1.8 | 2.0 | 1.8 m (long, low) | 1.2 m | 3.0 |
| anak | 1.9 | 2.0 | 3.6 m | 0.8 m | 2.8 |
| reem | 1.7 | 1.8 | 2.4 m (quadruped) | 1.1 m | 2.8 |
| tannin | 1.6 | 1.8 | 1.5 m (coiled) | 1.0 m | 2.8 |

  `r` and reach grow by `1.05^(level − 1)` like scale (base R13). In the sim, `bodyR(e)` and `reachT(e)` return
  tiles (meters / 8). Humans have `r = 0.3 m`.
- **Re-specified constants** (all other base distances, which are ranges for sight, fleeing, roars, roaming and so
  on, stay in tiles as written in the base spec):

| constant | base (tiles) | FP (meters → tiles) |
|---|---|---|
| champion sword reach | 1.3 + 0.25·scale | 2.4 m + target `r` |
| monster hit radius / telegraph ring | reach × levelScale × 1.25 | reach (m) + 0.3 m, measured from the monster's center |
| dash dodge | 1.2 tiles | 3.5 m over 0.2 s |
| bind / pick up / finish range | 1.5 tiles | 3.0 m from the target's nearest body point |
| altar range (panel, auto-notice) | 2.5 tiles | 4.0 m |
| dragged body spacing | 1.0 tile behind | 1.5 m + body `r` behind |
| guard spear reach | 1.4 tiles | 2.6 m + target `r` |
| villager/monster grab reach | monster reach | reach (m) + 0.3 m |
| help-drag "nearby" (speed bonus) | 3 tiles | 6 m |
| separation radius (§5.4) | — | `rA + rB` |

- **Speeds** stay as in the base: the champion's sprint is 1.1 tiles/s = 8.8 m/s (the design's "1 km in about 2
  minutes"). Walking is 0.56 tiles/s = 4.5 m/s. Villagers walk 0.8 tiles/s = 6.4 m/s. That is fast, but game-time
  pressure matters more than realism here **[gap]**. Monster speeds are unchanged.

---

## 3. Input and controls

### 3.1 Bindings (rebindable in Settings; stored in `localStorage`)

| Input | Action |
|---|---|
| Mouse | Look (pointer lock). Pitch is clamped to ±85°. |
| W A S D | Move (relative to the camera's yaw) |
| Shift (hold) | Sprint |
| Space | Jump (client-only: a ~0.85 m hop, 8 stamina, momentum kept in the air; not while dragging, downed or mid-dodge; the sim never sees height) |
| C | Dodge (a dash in the direction you are moving, or backwards if you are standing still). Was Space until jump was added; saved bindings migrate |
| Left mouse | Swing the sword (hold to keep swinging when the cooldown allows) |
| Right mouse (hold) | Raise the shield |
| E | Interact with what the crosshair targets (§3.3) |
| F | Finish a targeted downed monster |
| T | Torch on/off (it takes the shield hand) |
| Q | Inspect the target: a card with bio, wounds, hours, and lair info |
| M | World map (toggle) |
| Tab or Esc | Journal (Village, Monsters, Book, Chronicle, Gods, Settings). It releases the pointer. |
| Enter | When a banner or card is showing, dismiss it |

- Clicking the canvas (or the "Click to play" overlay) requests pointer lock. Losing the lock (Esc, alt-tab) shows
  the journal. **The world never pauses**: it runs on real time (design) **[gap: there is no pause]**.
- Settings: mouse sensitivity, invert Y, FOV 60–100° (default 75°), master and effects volume, shadow quality
  (off/low/high), and key bindings.

### 3.2 Look target
Every frame the renderer raycasts from the camera center against entity bounding capsules (not individual meshes),
up to 40 m, and also against the terrain. The nearest hit entity is the **look target**. Within 3 m (plus its `r`),
a downed monster, corpse, part or the village altar also counts as targeted when it lies within 25° of the view
direction (things on the ground are hard to point at).

### 3.3 Interact (E), in priority order
1. **Dragging** something and the target is not the altar → **drop** it.
2. Targeting the **village altar** within 4 m → open the **altar panel** (§8). This is the only way to offer a
   dragged body.
3. Targeting a **downed** monster within 3 m → **bind** it, and start dragging it.
4. Targeting a **bound** monster or a **corpse** within 3 m → start **dragging** it.
5. Targeting a **villager** → show a speech line from their bio for 3 s (flavor) **[gap]**.
6. Otherwise nothing happens.

The HUD always shows the action E would take (§10.2).

---

## 4. The champion controller (main thread)

### 4.1 Authority
- **Player mode** (`ctrl = 'player'`): the controller owns the champion's position and yaw. The sim follows the
  poses it receives (§4.3).
- **Sim mode** (`ctrl = 'sim'`): the sim moves the champion (downed, captive or carried, dead, autopilot, an
  interregnum with no champion). The controller copies the sim position each frame, and the camera keeps mouse look.
- The sim publishes `ctrl` in every frame payload. On a switch from sim to player, the controller snaps to the sim
  position.

### 4.2 Movement
- The input vector from WASD is rotated by the camera yaw. Walk 4.5 m/s, sprint 8.8 m/s, both ×`speedMul`, which
  the sim sends in the HUD every 5 ticks: `stat speed / 1.1 × legFactor × drag factor × terrain`. The terrain
  factor is `1 / sqrt(moveCost)` of the tile underfoot.
- Acceleration is 30 m/s² and friction 12 /s. There is **no jumping** **[gap]**.
- **Collision:** the champion is a circle of 0.35 m. It slides along unwalkable tiles (per-axis resolution against
  the walk mask, §4.4) and is pushed out of the body circles of living, non-downed monsters, the village altar
  (1.2 m) and the High Place altar (1.4 m). Villagers, animals, corpses and module entities don't collide **[gap]**.
- Eye height is `groundY + 1.65 m`, with view bob (±4 cm at 2 Hz while walking, double while sprinting). When
  downed, the eye drops to 0.45 m and rolls 20°. While carried as a captive, it follows the captive's `lift`.
- **Dodge:** costs 25 stamina, cooldown 0.5 s. It moves 3.5 m over 0.2 s along the move direction (or backwards if
  there is no input), with collision. It sends `dodge` to the sim (§5.3).

### 4.3 Pose messages
- Every 50 ms in player mode the controller sends `{ type: 'pose', x, z, yaw, pitch, moving, sprinting }` (tiles
  and radians).
- **Sim validation** (applied at the next tick): the new position must be walkable for the champion (the same mask)
  and within `1.6 × maxSpeed × elapsed + 0.2 tiles` of the last accepted pose. Otherwise the pose is rejected, the
  champion stays put, and the sim sends `correction { x, z }`. The controller snaps to it. This guards against
  desync after a stat change, not against cheating.
- Poses are ignored in sim mode and while the champion does not exist.

### 4.4 Walk mask
The worker computes `champWalk: Uint8Array(SIZE²)` (1 = the champion may stand there), using the champion's
effective walkability, including `rules.moveCost` from modules. It is sent with `fullState`, and as a full update
after any tile change batch and after every module install or status change. Tiles that are currently unwalkable but
hold the champion's current position are reported as walkable, so a new chasm never traps you inside a wall.

### 4.5 Stamina (main thread)
- Max 100. Sprinting costs 12/s. A swing costs 12, a dodge 25, and blocking costs 0.5 × the damage it prevents
  (reported by the sim, §5.4). Regeneration is 25/s once nothing has been spent for 0.8 s.
- At 0 the champion is **winded** until stamina is back to 25: no sprint, no dodge, no swing, and the shield drops.
- Stamina is kept on the main thread only. It is not saved and is full after a reload **[gap]**.

### 4.6 Autopilot (base R19, adapted)
If there has been no player input for **5 real minutes**, or the page is hidden, the sim switches to `ctrl='sim'`
and runs the base idle behavior: walk home, and defend the walls against monsters within 10 tiles of the village.
The next key or mouse input (with pointer lock) returns control. The away resolver is unchanged.

---

## 5. Combat

### 5.1 Swing (left mouse)
- The client checks the cooldown (0.6 s), stamina (12), that the shield is down, and that the champion is not
  winded. It plays the view-model swing (0.35 s; contact at 0.12 s) and sends `{ type: 'swing', yaw, pitch }` at
  the swing's start. If the champion is dragging something, the first click **lets go** instead of swinging.
- **Sim resolution** on receipt, using the latest accepted pose and the message's yaw and pitch:
  1. Candidates: monsters within `2.4 m + r` of the champion, measured center to center on the ground, that are
     **not downed and not bound** (a swing passes over bodies lying on the ground; use F to finish them). Also
     module entities with the tag `hittable`.
  2. The candidate must lie within ±50° of the swing's yaw, measured to the nearest point of its body circle.
  3. Choose the candidate whose bearing is closest to the swing's yaw. A swing hits **one** target **[gap]**.
  4. **Hit zone by aim** (§5.2) → `applyDamage(target, dmg, { type, zone })`. Damage is
     `12 × (1 + 0.1 × (level − 1)) × strength × armFactor × weapon.mul`, ×1.5 on the head, and ×2 on a resting
     monster (the base "caught in its lair" ambush, first hit only).
  5. The sim emits a `hit { id, zone, x, y, z, severed?, killed? }` event for feedback: a blood burst at the impact
     point, a hit sound and a 50 ms hit-stop on the client. A miss emits `whiff`.
- Humans and animals are never hit by the champion **[gap: no friendly fire, no hunting goats]**.

### 5.2 Hit zone by aim
- The **aim point** is the point on the look ray (from the eye along yaw and pitch) closest to the target's
  vertical axis, clamped to the body. It is expressed as `h` (height above the target's ground divided by the
  target's height, clamped to 0..1), `s` (sideways offset divided by `r`; negative means the target's left) and
  `f` (forward offset along the target's facing divided by its half-length; quadrupeds and serpents only).
- Zone maps per **body plan** (first match wins; a severed zone falls through to the next match, and then to
  `torso`):

| plan | archetypes | rules |
|---|---|---|
| biped | nephil, lilit, anak, seir; humans | `h > 0.82` → head; `h < 0.45` → legL if s < 0 else legR; `\|s\| > 0.55` → armL/armR; else torso |
| quadruped | reem, rahab | `f > 0.55` → head; `h < 0.4` → legs by front/back and side (front legs = armL/armR, back legs = legL/legR); else torso |
| serpent | saraph, tannin | `f > 0.6` → head; `f < −0.5` → tail = legL/legR (one "tail" zone shared by both); else torso; saraph wings: `h > 0.6` and `\|s\| > 0.5` → armL/armR |

  Signature limb (`sig`) overrides, checked first: nephil club arm = `armR`'s region (a hit there damages `sig`
  instead), seir and reem horns = head region with `h > 0.9` (or `f > 0.8`), lilit talons = arm regions below
  `h < 0.6`, rahab jaws = head, anak grasping hands = arm regions, saraph wings = the wing regions, tannin coils =
  torso with `h > 0.5`.
- The base crippling, severing and destruction rules are unchanged (R18). Aiming lets the player choose: legs to
  slow a monster down, the club arm to blunt its blows, the head for damage.

### 5.3 Monster attacks
- The base wind-up loop is unchanged (8 ticks of wind-up, release, 15 ticks of cooldown).
- At release against the champion, the attack hits if the champion's center is within `reach + 0.3 m` of the
  monster's center **and** within ±70° of the monster's facing at release, and the champion is not in i-frames.
  Monsters turn toward their target at up to 180°/s during the wind-up and **freeze their facing for the last 2
  ticks**, which makes dodging sideways or behind a skill.
- Against villagers and guards, the base rules apply with the meter reaches.
- **Dodge i-frames:** a `dodge` message makes the champion immune to monster attack releases and grabs for 3 ticks
  from its arrival.
- **Telegraph:** the pack flag `TELEGRAPH` makes the renderer play the archetype's wind-up pose (rear back, raise the
  club, coil) and draw the red ground ring at the hit radius. The audio plays a positional growl at wind-up start.
- **Grab** of the champion is allowed only while he is downed (base R10).

### 5.4 Block (right mouse, hold)
- The client sends `block { on }` on press and release, and forces it off when the champion is winded, swinging,
  holding the torch, or dragging.
- While blocking, a monster attack release whose source lies within ±60° of the champion's yaw deals **25 %**
  damage, with no burn and no crippling roll. The sim sends `blocked { prevented }`, and the client pays
  `0.5 × prevented` stamina. Blocking caps movement at walking speed.

### 5.5 Finish (F) and downed monsters
- F on a targeted downed monster within 3 m kills it: a beheading (`dismember` death on the head, the head part
  flies off). This keeps base R17 (finishing is never automatic).
- Downed, bound and dragged rules are as in the base, with the meter distances of §2. The dragged body is
  positioned by the sim each tick at the champion's pose minus 1.5 m + `r` along the champion's facing. If that
  spot is unwalkable for the body, it stays at its last walkable spot and the rope (rendered) stretches; beyond
  6 m the drag breaks ("The rope slips.").

### 5.6 Champion downed, captured, killed
- Base rules apply (downed at ≤ 20 % HP for 300 ticks, grab allowed, succession).
- First-person presentation: downed means a low camera, a red vignette and the text "You are down. Get up in Ns." A
  carried champion's camera follows the carrier's grip. Death fades the screen out, plays the chronicle line, then
  shows a **spectator camera** slowly orbiting the village altar at a height of 20 m until a successor is crowned.
  The new champion then takes control where they stand.

### 5.7 Separation and path smoothing (sim)
- **Separation:** every 2 ticks, inhabitants that are walking (not hidden, captive, downed or bound) push apart
  pairs closer than `rA + rB` using a 2-tile spatial hash, moving each by half the overlap (max 0.05 tiles per
  tick), but never onto an unwalkable tile. The champion is never pushed by the sim; the controller handles his
  collisions (§4.2).
- **Path smoothing:** after A*, a path is string-pulled (skip waypoints while the straight segment crosses only
  walkable tiles, checked at 0.25-tile steps). The final waypoint gets a deterministic random offset of up to ±0.35
  tiles inside its tile, so workers on the same tile don't stand in one spot.
- **Close pursuit:** a monster within 2 tiles of its target, with a walkable straight line to it, steers directly
  toward the target and stops at `reach × 0.8`, instead of following tile paths.

---

## 6. Sight, exploration and what gets rendered

- Sight radii, `explored`, `seenHours`, lair discovery (5 tiles), screams and missing alerts are as in the base.
  Torch: while lit at `light < 0.5`, the champion's sight is +3 tiles.
- `explored` only drives the **map**. The 3D view draws every tile.
- **Entities sent per frame:** all structures and entities within 80 tiles (640 m) of the champion (or the spectator
  point), except monsters. A monster is sent when it is within `1.25 × championSight` **or** (`light > 0.5` and
  within 80 tiles). So at night, monsters out of your sight are not drawn at all, and a monster at the edge of your
  sight fades in (the renderer fades in over 0.5 s).
- Scene fog: `far = lerp(championSight × 8 × 1.15, 900 m, light)`, with the fog color matching the sky. Weather
  `fog` from modules multiplies `far` by 0.35.

---

## 7. Rendering

### 7.1 Camera and frame
- `PerspectiveCamera(fov, aspect, 0.1, 1500)`. The renderer runs `requestAnimationFrame` at the display rate and
  draws entities **interpolated** between the last two sim frames (100 ms apart), as the base does. The champion
  himself is not drawn in first person. His body is drawn only in spectator or downed views, as a rig.
- Target: 60 fps at 1920 × 1080 on integrated-plus GPUs, with a cap of 1.5 device pixel ratio. Shadows come from
  the sun or moon only, with a 2048 map covering 80 m around the player.

### 7.2 Terrain
- One heightmap mesh with a vertex every 4 m (257 × 257 = 66 k vertices), heights from `groundY`. Vertex colors come
  from the tile color, blended across tile edges (bilinear on the four nearest tile centers), with ±6 % brightness
  noise. `MeshLambertMaterial` with vertex colors.
- **Tile changes** (from modules) recolor and re-height the affected 3 × 3 vertex blocks in place.
- **Water:** one plane at −1.8 m (deep) whose color depends on the depth under it via a small shader (shallow =
  lighter), with gentle vertex-free shimmer through scrolling noise in the fragment shader.

### 7.3 Decoration (instanced, visual only, no collision [gap])
Per tile type, with deterministic positions jittered inside the tile from a hash, in 16 × 16-tile chunks, each an
`InstancedMesh` set per decoration type with frustum culling. A chunk is drawn only within 400 m.

| tile | decoration (per tile) |
|---|---|
| cedar | 2–3 cedars, 12–18 m (stacked dark cones on a trunk) |
| olive | 3–4 olive trees, 4–5 m (gnarled trunk + gray-green lumps) |
| vineyard | 2 rows of vine stakes with green blobs, 1.4 m |
| wheat | 6 golden tufts, 1 m |
| grass | 0–3 grass tufts and the odd flower |
| scrub | 2–3 dry bushes and a rock |
| rock | 1–2 boulders, 1–4 m |
| salt | a salt pillar in 1 tile out of 6 (2–5 m, white) |
| marsh | 4 reed clumps, 1.6 m |
| ruin-floor | fallen dressed blocks; a broken column in 1 tile out of 5 |
| wadi | pebbles |

### 7.4 Static structures (merged geometry, built once from `layout`)
- **New core tile types:** `house` (unwalkable; a 6 × 6 × 3.4 m mudbrick house with a flat roof, a dark doorway on
  the side facing the street, and a parapet) and `gate` (walkable; a stone gateway with a wooden lintel). Island
  generation stamps them from the existing house and gate positions. Houses keep their `structure` entities for
  roles; those render nothing.
- **Wall tiles:** a 4 m stone and mudbrick rampart filling the tile, with a 2 m walkway texture and crenellations.
- **Village altar:** a 2 × 2 × 1.1 m dressed-stone altar with four horns, a permanent fire (one point light), and
  smoke.
- **Sheepfold:** a low stone pen (1 tile). It shows `fold` lambs as small woolly rigs.
- **Granary:** a round mudbrick silo, 5 m.
- **High Place:** a stone table with horns on the summit, standing stones around it, and the sacred grove.
- **Lairs** (6–10 m landmarks, always present, §6): a giant cedar (30 m) with a cave mouth between its roots, a
  wine-press cave in a terrace wall, a sunken cistern (a stone ring with dark water and steps), a cliff tomb (a rock
  face with a square door), a ruined giant's hall (three 12 m columns and a broken lintel), and the catacomb stair
  beside the High Place altar. A lair's mouth glows faintly when its monster is home and **known**. These are pure
  visuals: monsters "enter" the lair by standing at it.
- **Guard posts:** a brazier on a pole (an emissive flame sprite, not a light) that is lit at night.

### 7.5 Creature rigs (`rigs.ts`)
Procedural rigs built from primitives with pivoted limbs (three.js `Group` hierarchy), one material per rig,
low-poly with flat shading:
- **Human:** a tunic box tinted by job (champion red), head with hair or headscarf, arms and legs on hip and
  shoulder pivots, and a held tool by job (staff, sickle, axe, net, spear; the champion's sword and shield).
- **Biped monster:** proportions per archetype (nephil: massive torso and club; lilit: thin, long arms, talons, owl
  face; anak: hunched, long grasping hands; seir: goat legs and horns).
- **Quadruped:** reem (an ox body with long horns), rahab (a crocodilian body with short legs).
- **Serpent:** chained segments that follow a sine. Tannin is coiled when idle. Saraph has wings that flap, and it
  hovers 1.2 m above the ground.

Animation comes from the pack's `anim` enum and speed: `idle` (breathing), `walk`/`run` (limb swing with phase from
distance travelled), `work` (a job-tool loop), `windup` and `strike`, `flee`, `downed` (on the ground, twitching),
`bound` (on the ground, ropes drawn), `carried` (limp), `sleep` (hidden), and `dead`. For `dead`, the pack's `roll`
and `squash` give the pose, and the death type picks the corpse variant.
- **Severed zones** come from the pack's `zoneMask` bits (§9.1). The rig hides that limb and shows a red stump disc.
  **Crippled** zones drag or limp: a crippled leg halves its swing and tilts the body.
- **Level scale:** monsters grow by `1.05^(level − 1)`, as in the base.
- Module entity shapes (`ShapeDef`) keep rendering through the base `ShapeRenderer`, scaled to 1.8 m per unit.

### 7.6 View model (`viewmodel.ts`)
A separate scene drawn on top with its own camera (FOV 60) after a depth clear. It shows the champion's right arm
with a bronze sickle-sword (khopesh) and either a round bronze-rimmed shield or a torch in the left hand. Animations:
idle sway, walk bob, swing (a right-to-left arc, 0.35 s), block (the shield raised to center), dodge (a dip), and
drop/drag (the sword hand pulls a rope back over the shoulder).

### 7.7 Effects
- Particles (base system, now in meters): blood bursts at the hit point, dust on dodges, fire, smoke, light pillars
  at the altar, and green mist. Rain and ash emitters follow the camera (a 40 m box) when `atmosphere.weather` asks
  for them.
- **Telegraph ring:** a red ground ring at the hit radius during wind-up, filling from the rim inward over the 8
  ticks.
- **Blood pools:** flat discs on the ground, as in the base.
- **Rope:** a catenary line from the view model's hand (or the champion's position) to the dragged body.
- **Night:** sky dome gradient, stars, the moon, ambient light down to 0.08, and the torch (a point light of range
  18 m, warm, with flicker). At most 4 point lights at once: the torch, the village altar fire, and the two nearest
  lit lair or High Place fires. Everything else that glows uses emissive materials or sprites.
- **Hit feedback:** a camera shake of 0.15 s and a red edge flash when the champion is hit. Blocked hits flash the
  shield and play a clang.

---

## 8. HUD and UI (DOM overlay, desktop)

### 8.1 Always on
- **Crosshair** at the center. It turns red over a monster within reach, and yellow over a downed one.
- **Target frame** under the crosshair (the look target within 40 m): name and title, HP bar (only for monsters seen
  before or within sight), and state ("resting", "downed", "bound", "hunting").
- **Prompt line** under the target frame: what E and F would do ("[E] Bind Gaash the Hill-Breaker · [F] Finish
  him").
- **Compass strip** (top center, ±90° visible, 520 px wide): N/E/S/W ticks and markers with their distance: ⌂
  village gate, 🔥 village altar (shown in amber while you drag something), ▲ High Place, lair icons for found lairs
  (crossed out when the monster is dead), **! scream** (red, pulsing, while a captive is within 19 tiles; the marker
  follows the carrier), and ✦ newest creation (for 10 minutes after its card).
- **Top-left:** day, time with ☀/☾, the favor bar (☀ Most High vs ☾ Dagon, today's tally), and "Judgment in 3h 12m".
- **Top-right:** 👥 villagers, monsters (6 icons, slain crossed out), food bar, and fold 🐑 count.
- **Bottom-left:** HP bar, stamina bar, level and XP bar, and a state line ("Dragging Gaash — 2 helpers", "Torch
  lit", "Winded").
- **Toasts** (top center, under the compass) and **banners** (shofar, Judgment, champion events). Their text is the
  base's text.

### 8.2 Screens (they release pointer lock; the world keeps running)
- **Journal** (Tab or Esc): tabs **Village** (job changes as in the base), **Monsters**, **Book of Creation**,
  **Chronicle**, **Gods**, and **Settings** (controls, video, audio, new island, dev buttons). Its contents are the
  base panels restyled for a wide screen.
- **Map** (M): a full-screen canvas map of the island, drawn from tile colors and the explored mask. It shows the
  champion's position and facing arrow, the village, altars, found lairs, screams, guards, villagers (dots, within
  sight), and visible monsters. The mouse wheel zooms and dragging pans. Press M or Esc to close.
- **Altar panel** (E at the altar): the base §8.2 options (lamb, offer the dragged body, offer a villager, pray).
- **Inspect card** (Q): the base inspect info.
- **While you were away**, the **Genesis card** (with base R31's "wait until safe" rule; when shown, it adds the ✦
  compass marker), and **Game over**: as in the base, with a desktop layout.
- A **Click to play** overlay shows whenever pointer lock is lost and no screen is open.
- **Mobile notice:** on touch-only devices (`pointer: coarse` and no fine pointer), a full-screen note says that
  this version needs a mouse and keyboard.

Visual direction: the base's parchment and bronze palette and Cinzel headings. The HUD uses thin dark plates and
stays at the screen edges so the view stays clear.

---

## 9. Sim and protocol changes

### 9.1 Entity pack (`ENT_STRIDE = 15`)
`id, shapeIdx, x, y, z, yaw, tint, scale, flags, lift, roll, squash, ring, anim, zoneMask`

- `y` is now `groundY` in **meters** (plus a hover offset for fliers). x and z stay in tiles.
- `anim`: 0 idle, 1 walk, 2 run, 3 work, 4 windup, 5 strike, 6 flee, 7 downed, 8 bound, 9 carried, 10 dead, 11
  sleep.
- `zoneMask`: bits 0–6 are crippled zones (head, torso, armL, armR, legL, legR, sig), and bits 8–14 are severed
  zones.
- `ring` = the hit radius in meters, while telegraphing.
- New flag `F_HITTABLE = 256`. The flag `F_CHAMPION` is still set; the renderer skips the champion in first person.

### 9.2 New and changed messages
- Main → sim: `pose`, `swing`, `dodge`, `block`, `interact { id }`, `finish { id }`, `torch { on }`, `altarOpen`
  (only allowed within 4 m), plus the base `action` (offerLamb, offerDragged, offerVillager, pray, setJob). The id
  in `interact` and `finish` is the client's look target. The sim re-checks range, state and kind, and returns
  `actionResult` with an error string on refusal.
- `order` is removed from the protocol; the base `Order` type survives internally for autopilot.
- Sim → main: `frame` adds `ctrl: 'player' | 'sim'` and `spectate?: { x, z }`. New messages are
  `correction { x, z }`, `walkMask { mask: Uint8Array }`, `combat { events: (hit | whiff | blocked | hurt |
  windup)[] }` (sent every tick that has any), and `sounds { events: { kind, x, z }[] }` (roars, screams, shofar,
  growls, burns; positional except the shofar).
- HUD additions: `champion.speedMul`, `champion.blocking`, `champion.iframes`, `champion.torch`, `judgmentInMs`, and
  `lookups` (names and states for entities the client may target; it already gets these from `inspect`).

### 9.3 Sim behavior changes
- `champion.ts`: the order loop is used only by **autopilot**. Player mode reads the latest pose, swing, dodge,
  block and interact. It keeps regeneration, succession, the dragging follow (at meter spacing) and the altar
  notice.
- `combat.ts`: `applyDamage` takes an optional `zone` (aimed). Without one, the base weighted zone roll applies, as
  it does for monster and guard attacks and module damage. New: the block and i-frame checks on monster releases
  against the champion, and the facing-arc check.
- `monster-ai.ts`: meter reach and hit radius; the wind-up facing freeze; close pursuit (§5.7).
- `village.ts`: meter reaches for guards and grabs.
- `island-gen.ts`: stamps `house` and `gate` tiles (wall gaps become `gate`). Village reachability is checked after
  stamping.
- `sim.ts`: separation and path smoothing (§5.7), the frame filter (§6), the walk mask, and the ctrl state.
- **Determinism:** pose, swing, dodge, block and interact messages are applied at the start of the next tick in
  arrival order. Tests feed the same messages tick-stamped through a test driver, so two runs with the same inputs
  produce the same hash.

### 9.4 Unchanged (inherited from the base)
Clock and away time (§2, §9, R1–R5), the village sim (§5, R12, R24), monsters (§6, R6–R14), favor and Judgment
(§8, R22–R23), XP (§10), the creation pipeline and module API (§11, R25–R29, except as noted in §11 below), save
format (§15; the schema version is bumped to 3 because the `house` and `gate` tiles change the grid), and win and
loss (§16, R20–R21).

---

## 10. Audio (`audio.ts`, new)

- One `AudioContext`, created on the first click (browser autoplay rules). The listener follows the camera.
  Positional voices use `PannerNode` (HRTF, `inverse` distance model, refDistance 4 m, maxDistance 300 m).
- **Recorded** sounds: CC0 files from Freesound in `public/audio`, decoded once on start (credits in
  `public/audio/credits.md`). One-shots get a small random pitch scatter.

| sound | file | positional |
|---|---|---|
| sword swing / whiff | `swing`, `whiff` | no |
| hit flesh | `hit` | at the hit |
| hurt | `hurt` (a pain grunt) | no |
| shield block | `block` (a sword clash) | no |
| footsteps | `step`; `step-soft` on sand, marsh and salt | no |
| monster growl (wind-up) | `growl`, pitched down for larger scale | yes |
| roar | `roar`, pitched down for larger scale | yes, heard to 400 m |
| screech | `screech` (a hawk cry) | yes, heard to 400 m |
| scream | `scream` | yes, heard to 150 m (19 tiles) |
| shofar | `shofar` | no |
| fire | `fire` loop at the village altar | yes |
| ambience | `wind` loop by day; `surf` loop near the shore | no |
| Judgment | `judgment` (a deep metallic boom) | no |
| burn / offer, bind | `burn`, `bind` | at the event |

- Volume settings are master and effects. Sounds for events beyond their hearing range are dropped in the worker,
  using the champion position.

---

## 11. Creations (changes to the base §11)

- The module API is unchanged. Shapes stay in human-height units (1 unit = 1.8 m), positions in tiles. Existing
  reference modules (war-hounds, poison-fog) need no change except that they must still look right at eye level;
  the hound shape is re-checked in first person.
- **Implement prompt additions:** "The player sees the world **in first person, at eye level, on a desktop**. A
  creation must be visible from the ground: give creatures readable silhouettes 0.3–3 units tall, use weather and
  atmosphere, tile colors and emitters at eye level. Nothing is seen from above. 1 tile = 8 m; a human is 1 unit
  (1.8 m) tall at scale 1." The decree prompt's `visible` field asks for what the player sees "standing in the
  world".
- `api.vis` camera cues (`focus`/fly-to) are no-ops; the host uses the first `visible` hint position as the ✦
  compass marker instead. Emitter and particle sizes are in tile units as in the base, and the renderer converts.
- `atmosphere.weather` `rain | fog | ash` maps to camera-following particle boxes and fog density. `darkness` and
  `light` drive the ambient and sky as in the base.
- The validator is unchanged (it doesn't render).

---

## 12. Dev and test hooks

- All base URL parameters, plus:
  - `?pose=x,z,yaw,pitch`: start the champion there and look that way (degrees). Useful for headless screenshots.
  - `?nolock=1`: mouse look by dragging, without pointer lock (headless and devtools).
  - `?autoplay=walk|fight|drag`: a scripted client-side input driver for screenshots (it walks forward, attacks the
    nearest monster with swings and dodges, or drags a bound monster).
  - `?spectate=1`: start in the spectator camera.
- `window.__hm` adds `controller` and `audio`.
- `dev/winshot.sh` takes 1600 × 900 desktop shots (WebGL works in headless Windows Chrome).

**Tests (vitest)**, in addition to the base suites (adapted to the new tiles and protocol):
1. `groundY` is continuous across tile borders and identical in sim and render code (same function).
2. Pose validation accepts legal moves, rejects walls and teleports, and sends a correction.
3. Swing resolution: arc, reach, nearest-bearing choice, downed and bound skipped, one target.
4. Zone by aim: for each body plan, a table of aim points gives the expected zone; severed zones fall through.
5. Monster release: front-arc check, i-frames from dodge, block reduction and the `blocked` amount.
6. Close pursuit stops at `reach × 0.8`; separation never pushes into walls.
7. Village generation: houses and gates are stamped, and every house door and both gates reach the altar.
8. The capture loop from the base, driven with pose, swing, interact and altar messages instead of orders.
9. Determinism with tick-stamped input messages.

---

## 13. Build milestones

1. Fork, units and `groundY`, heightmap terrain, water, sky, FP camera, controls, pointer lock, controller with
   collision and walk mask, and pose messages.
2. Static structures (house and gate tiles, walls, altar, fold, granary, High Place, lairs) and instanced
   decoration.
3. Creature rigs and animation from `anim` and `zoneMask`, the interpolation, and module shapes at meter scale.
4. Combat: swing and aim zones, block, dodge and i-frames, stamina, monster facing and telegraph, view model, hit
   feedback, finish, bind, drag and rope, interact and prompts.
5. HUD: crosshair, target frame, compass, bars, toasts; Journal, Map, Altar, Inspect; settings.
6. Audio.
7. Sight and fog, night and torch, weather effects; spectator, downed and carried views; succession.
8. Tests, a balance check with the base headless harness, desktop screenshots, and a README.

---

## 14. Revisions after the adversarial review (these OVERRIDE earlier sections)

A fresh-context reviewer attacked v1 of this spec against the code and returned 38 findings. Each accepted fix is
listed with its finding number (F#).

**Units and scale**
- F1: **1 shape unit = 2.25 m** (`SHAPE_M`), so the code's 0.8-unit humans are 1.8 m. Every "1.8 m per unit" above
  becomes 2.25 m. The implement prompt says "1 tile = 8 m ≈ 3.5 shape units; a human is 0.8 units (1.8 m)". The
  reference modules are re-checked at that scale.
- F14: `ARCH.scale` and `e.scale` are **unchanged** in the sim (they drive torn-in-two, level growth and lift). The
  "FP scale" column of §2 is dropped: monsters render at base scale × 2.25 m (nephil ≈ 5 m). The body radius and
  reach columns stay and are looked up per archetype × levelScale.
- F12: long creatures (rahab, reem, saraph, tannin) use a **capsule**, which is a segment between a front point and a
  back point (± half-length along facing: rahab 2.4 m, reem 1.3 m, tannin 1.6 m, saraph 1.0 m) with radius `r`.
  Collision, swing targeting and separation use the distance to the segment. Monster attacks are measured from the
  front point.
- F13: `lift` is in **meters**. `sim.burst` takes an optional anchor (`'feet' | 'center' | 'head'`) on an entity,
  which the renderer resolves against the rig. Fling vectors in `spawnCorpse`/`spawnSevered`/`stepCorpse` are scaled
  by 0.25 (limbs fly about 3 m, not 12 m).
- F26: `groundY` is the **mesh's own height**. The ground computes vertex heights on the 4 m grid (smoothed tile
  heights plus detail noise sampled at vertices), and `y(x, z)` is the barycentric height within the same triangle
  split the mesh uses. Feet, corpses and blood therefore sit exactly on the rendered surface.
- F30: a flier's height is `max(groundY, structure top) + hover`.

**Movement, authority and input**
- F6: `fullState`, `correction` and every switch from sim to player carry an **epoch**, which `pose` echoes. The sim
  drops poses from an old epoch, and the client snaps on a new one. `elapsed` in pose validation is clamped to
  0.25 s.
- F8: the dragged body follows a **breadcrumb trail** of accepted champion poses, sitting at the point 1.5 m + r back
  along it. It never uses the look yaw. The trail is walkable by construction, so "the rope slips" is removed.
- F9: autopilot uses `lastInputTick`, which only real input updates (pose messages with `input: true` when keys or the
  mouse moved, plus swing, dodge, block and interact). The "page hidden" clause is dropped because the worker pauses.
- F10: **losing pointer lock switches to `ctrl='sim'` at once** ("hold"): the champion stands, faces and swings at
  any monster attacking him within reach (base auto-attack), but does not travel. Re-locking returns control. This
  also covers the altar panel, the map and the journal.
- F19: `champWalk` becomes `champCost: Uint8Array` (0 = blocked, otherwise `round(cost × 20)`). The sim's
  `advancePath` and the client use the same factor, `1 / clamp(cost, 0.6, 3)`.
- F31: while downed, the player can **crawl** at 0.8 m/s (it is still `ctrl='player'`, but nothing else works). The
  spectator camera is a free fly-cam (WASD, mouse) instead of an orbit.
- F37: game keys are ignored while a text field has focus. Tab is preventDefault-ed. Closing any screen shows "Click
  to play". The re-lock rate limit is respected.
- F36: the champion's radius is 0.3 m, like every human. Body parts are not interactable. **Dropping uses E only**;
  left click while dragging does nothing except show the hint "E to let go".

**Combat**
- F2 + F7: **the client picks the target and the zone.** At blade contact (0.12 s into the swing), the client
  raycasts the interpolated rigs' oriented boxes along the look ray (with a 0.25 m fattening), takes the entry point,
  normalizes it to the box to get h, s and f (§5.2 tables), and sends `swing { targetId, zone }`. If the ray hits
  nothing, it falls back to the nearest candidate in the ±50° arc (zone by height only) or a whiff.
  - The sim validates: the target is a living, non-downed, non-bound monster within `2.4 m + r + 1.0 m` slack and
    ±70° of the champion's yaw. Otherwise the swing whiffs.
  - The client plays the hit sound and blood immediately on its own hit. The sim's `hit` event only confirms it
    (severed limbs, kills).
- F7: a monster release against the champion uses the **most favorable** pose received in the last 150 ms, both for
  range and for the arc. The telegraph ring and the HUD wind-up arc complete 0.2 s **before** the sim release.
- F29: a monster's attack arc is ±50° (not ±70°). The i-frames remain the safety net.
- F3: fight thresholds are in meters, measured from the monster's front point to the target's center:
  - wind-up starts at `d ≤ hitR − 0.4 m`;
  - the chase stops at `max(rM + rT + 0.1 m, reach × 0.8)`;
  - close pursuit is a direct steer within 2 tiles.
  - `hunt()`'s grab starts at `reach + 0.5 m`.
  - `carry()` and every other AI range stays in tiles, as in the base.
- F4: a **grab latches**: once a grab starts, the prey is pinned (it can't move) for the 10-tick grab, so fleeing
  villagers still get caught. The base "monster loop" test must pass.
- F5: help-drag helpers stand 1.5 m beside the rope, and the speed bonus counts helpers within 4 m.
- F20: a **HUD wind-up arc** at the screen edge points toward every monster winding up on the champion and fills with
  the wind-up. Monsters within 30 m play a positional footfall or breathing cue every 0.6–1.2 s.

**Rendering and HUD**
- F11: lair landmarks are ordinary-sized (a normal cedar over a cave, about 5 m columns). The cave mouth, bone pile
  and glow are drawn only within 15 tiles or once the lair is found. A monster in `rest` is **not sent** unless the
  champion is within 5 tiles: it is "inside" its lair.
- F15: an inhabitant whose `shape` is not its core shape (a module changed it with `api.vis.setShape`) renders its
  ShapeDef instead of the rig. Tint changes rebuild the rig with the new tint, and `scale` scales the rig.
- F16: core emitters are re-authored in meters. Module emitter sizes are converted at 2.25 m per unit, clamped to
  0.05–2 m. Point size is computed from the FOV and viewport height (max 256 px), and the particle shader applies
  scene fog.
- F17: draw-call budget ≤ 800:
  - rigs beyond 150 m are hidden;
  - only rigs within 40 m cast shadows;
  - module entities beyond 150 m are hidden;
  - decoration and walls are instanced;
  - static structures are merged per material.
- F18: the client keeps a 4-snapshot buffer stamped by sim tick and renders at `latestTick − 1.5 ticks` with a
  smoothed clock, so bursty frame arrival doesn't stutter.
- F21: eyes and flames use separate emissive materials. At night, house windows glow (per house, from a deterministic
  hash) **[gap]**.
- F22:
  - The pack gains `hpFrac`, `seen` and `windup` (progress 0..1), so ENT_STRIDE is 18.
  - A `names` message (`id → { name, title }`) is sent when an entity first becomes visible and on change.
  - The frame gains `screams: { id, x, z }[]` (captives within 19 tiles, even when not otherwise sent) and
    `ctrlReason: 'player' | 'hold' | 'autopilot' | 'downed' | 'captive' | 'dead'`.
- F23: champion emotes become HUD toasts. World emotes are drawn as sprites only within 40 m. Captive screams use audio
  plus the compass, not text over the head.
- F24: `layout.doors[i]` is the walkable tile in front of each house's door, facing the street. `leaveHouse` and
  `crown()` place a person there.
- F25: `TileTypeDef` gains an optional `decor?: { kind: 'tree' | 'bush' | 'rock' | 'reed' | 'tuft' | 'pillar'; color?:
  string; density?: number; size?: number }`, built with the same instancing. Decoration is rebuilt (debounced 1 s)
  after tile changes.
- F27: paths keep their raw A* tiles for invalidation (`path.raw`) next to the smoothed waypoints. Smoothing uses a
  supercover line test and only skips waypoints when every tile on the shortcut costs no more than the tiles it
  replaces.
- F32: day fog is 450 m. Cedar trunks, boulders over 1 m, salt pillars and ruin columns get client-only collision
  circles (a grid lookup).
- F33: exactly 4 point lights always exist; unused ones have intensity 0.
- F34: `api.world.setTile` refuses `house`, `gate` and `wall` tiles and the tiles next to them, and modules can't
  place those types.
- F28: **onboarding**: a controls card the first time you play, plus one-time hints ("Space: dodge · Right mouse:
  block" on the first wind-up, "E bind · F finish" on the first downed monster, "T: torch" at the first nightfall,
  "E at the altar to offer it" on the first drag), with "seen" flags kept in localStorage.
- F38: villagers keep their sim speed (0.8 tiles/s). Their walk cycle uses a long stride so it reads as a brisk walk.
  You cannot outrun most monsters; dodge and block are the answer **[gap, accepted]**.
- F35: tests add:
  - an FP bot (pose, swing with target and zone, dodge, block) that downs, binds and drags a monster to the altar;
  - pose epochs after a resolver run;
  - dragging through a gate;
  - helper counting;
  - fight thresholds per archetype;
  - the base monster loop with meter reaches.
