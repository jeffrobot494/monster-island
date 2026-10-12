# Climbing, phase 1: implementation plan (revised after review)

Design: `docs/climbing-design.md` (Part 1). This plan covers build step 1 only: **climbing the heightmap ground**, with
falls, height in the sim, 3D monster reach against the champion, and monsters besieging a climber. Not in phase 1:
feature-mesh climbing (spires/arches/overhangs, phase 2), monster mounting (phases 3–4), lookouts, Se'ir climbing,
nephil rocks, viewmodel hands, the terraformer climb view (phase 5).

Written to be built from a fresh context. Every claim about the code was checked against the source, and the plan
was then attacked by a separate reviewer; its findings (11 blocking, 12 should-fix) are folded in below. The review
itself is not needed to build this.

## Ground rules

- **Climbing is inert on procedural islands.** Everything new triggers only on `'cliff'` tiles, which only terraformer
  islands have, or on a champion `alt > 0`, which only climbing produces. 3D reach is applied only to the champion
  and only on terraformer islands (`sim.grid.base !== null`). New code paths make **no rng calls**. So procedural
  islands, their tests and their determinism are untouched. Keep it that way.
- **The client owns climbing.** Like walking and jumping today, the controller decides where the champion is; the sim
  gets `alt` (feet above the ground, m) and a `climb` flag in poses and trusts them (single-player; clamp only).
  The sim owns damage (falls), monster reactions, and resets on hand-over.

## Facts about the current code this plan relies on (verified)

- **Units.** Positions are tiles (`M = 8` m per tile, `src/sim/ground.ts`), heights meters. `Ground.y(x, z)` is exactly
  the rendered heightmap triangle; vertices every 4 m (`RES = 2`, `NV = 257`). `Ground.slope(x, z)` = gradient (m/m).
  Terrain islands: vertex height = `grid.base` + blurred `(height − orig)·M` delta (ground.ts:44, 115–118).
- **Cliff tiles** (`src/sim/island-import.ts`): `markCliffs` (~143–149) makes a *walkable land* tile `'cliff'` if
  `solid[i]` (rock 1–2.5 m above the ground at 5 sample points: spire/arch-leg footprints) or `rise(x, z) > 4`.
  `rise()` (62–71) checks **only axis-aligned vertex edges**, so walkable tiles can still hold triangles up to
  ~54.7°. Laid road tiles and KEEP tiles (road, gate, shrine-floor, wall, house) are never marked whatever their slope.
  `finish()` raises/quantizes vertices after `markCliffs`; god tile edits move the ground without re-marking.
  `connectAll` also turns unreached pieces into cliff (~291, ~302): these are ordinary walkable-slope ground.
  Water tiles are never cliff, so **the foot of a sea or canyon cliff is often a water tile**.
  ⇒ Not every steep face is a cliff tile, and not every cliff tile is steep. Climbing is deliberately limited to
  cliff tiles; faces on other tiles stay as they are today (walk over them with the eye snap).
- **Under a spire the heightmap is flat ground.** The rock is only in the render-side feature mesh
  (`src/render/feature-mesh.ts`, built synchronously in `render/terrain.ts` `load()` from the terrain settings,
  ~850 ms). It keeps triangles whose top is above the dilated ground + margin.
- **Client movement** (`src/input/controller.ts`):
  - `update()` handles walking and the `air` jump physics.
  - `move()` sub-steps a move only when it is longer than `R·0.8` = 0.28 m (line ~314), with tile collision through
    `clear()` (9 sample points, all must be walkable) → `walkable()` → `this.walk`, plus circle solids.
  - The eye follows `Ground.y + EYE_H` with smoothing (12/s), and hard-snaps when more than 3 m off. **There is no
    falling off edges and no fall damage today.**
  - `air`, `feetY`, `vy` and stamina are client-only. Stamina regen at the top of `update()` is unconditional
    (line ~194).
  - When `ctrl !== 'player'`, the else branch sets `air = false` (~239–244) and the eye goes to the ground.
  - `snap()` (~113–119) resets `air`. `air` is assigned at about 6 sites.
  - `fly()` is the model for a separate mode function.
  - `tryJump` checks only `!air`; `tryDodge` checks `!air`.
- **main.ts**:
  - The frame loop consumes `controls.take('jump')` → `tryJump` (~791) and `take('dodge')` → `tryDodge`.
  - `onFrame` (~445–462) snaps the controller on an epoch change, on a correction, or on sim → player. When
    `ctrl === 'sim'` it copies x/z from `f.champ`.
  - Monster circles go into `controller.solids` (~843–854).
  - `onLand(impact)` only plays effects (~145).
- **The walk table** (`sim.champCost`, sim.ts:~770–778): champion move cost × 20, 0 = blocked. The champion's own
  tile is forced to 20 ("never trapped"), and the table is re-sent as the champion changes tile
  (sim.worker.ts:~220–225). So `walk[]` alone can't be trusted for cliff tiles: check the tile type first.
- **Poses** (`src/sim/champion.ts`):
  - `ChampInput` pose = `{x, z, yaw, pitch, epoch, input, fly?}`.
  - `applyPose` (~213–244) rejects the pose (→ `correct()`, epoch++, the client snaps) unless the tile is the same
    or `walkableFor`, and the move is within the speed bound `1.6 · 8.8 · max(0.3, speedMul) · 1.15`, plus 17.5
    right after a dodge.
  - Accepted poses go into `S.poses` (last 6) for `releaseOnChampion`.
  - Corrections carry `{x, z, epoch}`; frames carry `champ: {x, z, yaw}` (sim.worker.ts:~350, protocol.ts:~161).
- **Control reasons**: `player | hold | autopilot | downed | captive | dead`.
  - `downed` counts as player control (`isPlayerCtrl`).
  - `hold` = pointer lock lost (Esc, menus, the altar UI). The sim stands the champion still (`holdGround`).
  - `autopilot` = `sim.order`, including the 5-minute idle defense, which walks home with `goTo`/`nearestWalkable`
    (champion.ts:~437–449, 479–486).
  - `findPath` allows an unwalkable start tile (pathfind.ts:~58).
  - `nearestWalkable(r)` returns null when nothing is within r.
- **Monster AI** (`src/sim/monster-ai.ts`):
  - `setState` calls `sim.stop(m)` on every change (~165–169); `go()` repaths only when not moving or every N ticks.
  - The fight branch calls `setState(…, 'fight')` every tick (~291).
  - Champion aggro (~296) fires within 5 tiles (3.5 when resting).
  - Roar responses re-target the champion (~314–316); raids pick the nearest human (~464–473); being hit sets
    `target` (champion.ts:~288, spears.ts:~240).
  - `aloft(m)` (alt > 3) blocks flyer strikes and grabs. `targetAlt` (~61–77) sets flyer altitude by state.
  - `fight()` (~760): wind-up, release after 8 ticks → `releaseOnChampion` (horizontal arc and distance only).
  - `hunt()` grabs; `preyScore` allows the champion as prey only when downed or under 40% hp.
  - Flyers cost 1 on every tile (sim.ts:~404).
- **Sim collision** (sim.ts:~728–747) separates bodies in 2D, the champion included.
- **Champion actions**:
  - `swing` `ok()` (~252–259) checks horizontal distance and bearing only.
  - `near()` (~301–303) gives the interact/bind/finish range, 2D.
  - Spear pickup is 2D (spears.ts:~191–195).
  - `champThrow` (spears.ts:~132) aims from `ground.y + 1.6`, but the spear is created in `launch()`
    (spears.ts:~120) at `ground.y(thrower) + 1.6`.
- **Frame packing** (sim.worker.ts:~180): entity `y = ground.y` (+ `monster.alt` for flyers).
- **Sizes** (`src/sim/body.ts`): `heightM(e)` and `reachT(e)` (tiles) scale with `e.scale`. At base scale:

  | Body | Height | Reach |
  | --- | --- | --- |
  | Nephil | 4.95 m | 3.4 m |
  | Anak | 3.4 m | |
  | Se'ir | 3.0 m | |
  | Lilit | 2.4 m | |
  | Re'em | 2.3 m | |
  | Ziz | 2.2 m | |
  | Rahab | 1.6 m | |
  | Tannin | 1.4 m | 2.6 m |
  | Humans | 1.8 m | |
- **Damage**: `applyDamage(sim, t, amount, { type, zone, sourceId, deathType })` (combat.ts:~99). `out.hurt` counts
  only non-human sources (combat.ts:~116).
- **Rain**: `renderer.sky.atmosphere.weather === 'rain'` (renderer.ts:~127, 152).
- **Tests**: vitest (`test/`). `terrain.test.ts` builds imported islands from settings; `fp.test.ts` has a
  pose-feeding bot.
  - The controller imports only `../sim/ground`, `../sim/world` and a type, and uses `performance.now()`, so it runs
    under vitest with a fake `Controls` (`down`, `take`, `readLook`).

## Rules (the numbers)

| Constant | Value | Notes |
| --- | --- | --- |
| `WALL` | tan 50° ≈ 1.19 m/m | steeper than this on a cliff tile is a wall: you can't walk up it or stand on it |
| `LEDGE` | tan 40° ≈ 0.84 m/m | flatter than this is somewhere you can stand. Between the two: you stay on the wall while climbing, but don't start a climb (hysteresis) |
| `PROBE` | 0.25 m | directional slope probe for walking (never the per-frame step) |
| `CLIMB_SPEED` | 1.8 m/s | |
| `STANDOFF` | 0.45 m | body axis to the face, measured at **feet** height |
| `HANDS` | 1.3 m | above the feet: where the normal and the mantle test are read |
| `DRAIN_MOVE` / `DRAIN_HOLD` | 6/s and 3/s | ×1.5 in rain. No overhang ×2: a heightmap can't overhang (that's phase 2) |
| Lunge | 2 m over 0.25 s, 15 stamina | |
| Wall jump | 4 m/s horizontally toward the look direction, vy 6.2 | only when looking away from the face (look · n > 0.3); otherwise Space is an upward lunge. No re-grab for 0.3 s |
| Mantle | 0.5 s | the ground 0.8 m into the face is ≤ `HANDS` above the feet, flatter than `LEDGE`, and `clear()` |
| Start a climb | blocked by a wall, forward held, facing within 60° of the face, for 0.15 s | stamina ≥ 5, not dragging, view `normal` |
| Air grab | Space held and a face steeper than `WALL` within 0.6 m of the body at `feetY + HANDS` | design said "0.8 m of the eye"; same thing in practice |
| Fall damage | none at ≤ 13 m/s; (impact − 13) × 4 hp split over legL/legR, crush; > 28 m/s kills (`crushed`) | no damage when the ground where you land is ≥ 1 m under `WATER_Y`. The design said 2 m; **use 1 m and update the design** |
| Vertical reach (champion only) | m can hit the champion iff `−(reachM(m) + 1.8) < feetY(c) − feetY(m) < heightM(m) + reachM(m) − 1` | terraformer islands only |
| Pose vertical bound | alt may rise at most `10 m/s × elapsed + 1` | falls are unbounded |
| Besiege | 1.5 game hours (at least 90 s × timescale), then ignore the champion for 1 hour | fixed duration, no rng |

## Part A: client — the rock mask (replaces the persisted solid mask)

The sim's `solid` mask is not saved and misses overhangs, arch spans and thin spires. Instead, the client marks the
cliff tiles that have feature-mesh rock on them. It builds this from the mesh it already makes, so the save format,
protocol and sim don't change, and old saves work.

- `buildFeatureMesh(s)` (`render/feature-mesh.ts`) also returns `rock: Uint8Array(SIZE²)`. For each **kept**
  triangle whose lowest vertex is below the ground at its centroid + 40 m (so floating isles high overhead don't
  count), mark every tile its xz bounding box overlaps.
- `render/terrain.ts` keeps `rock` next to the mesh (`null` on procedural islands).
- `main.ts` passes it to the controller on `fullState`, next to `controller.walk`.
- In phase 1, cliff tiles in `rock` are hard-blocked like walls. Phase 2 replaces this with real feature-mesh
  collision.

## Part B: client — `src/input/climb-surface.ts` (new, pure, unit-tested)

Queries against `Ground` only. Phase 2 adds the feature-mesh triangles behind the same functions.

```ts
export interface Face { nx: number; nz: number; slope: number } // horizontal unit vector OUT of the face; slope m/m
/** Gradient-based face at (x, z) tiles, averaged over a 2 m square (5 samples): no sawtooth jitter. */
export function faceAt(g: Ground, x: number, z: number): Face;
/** Directional slope (m/m) from (x, z) along a horizontal unit direction, over PROBE. */
export function slopeAlong(g: Ground, x: number, z: number, dx: number, dz: number): number;
/** Horizontal distance (m) from (x, z) along −n to where the ground reaches height y; null if not within maxM. */
export function distToFace(g: Ground, x: number, z: number, nx: number, nz: number, y: number, maxM = 2): number | null;
/** The steepest face around (x, z) at height y (8 probes at 0.6 m), or null: for air grabs and re-grabs. */
export function wallNear(g: Ground, x: number, z: number, y: number): Face | null;
```

`distToFace` marches in 0.1 m steps, then bisects 6 times (Ground.y is piecewise linear).

## Part C: client — the controller

### C0. Structure

- `mode: 'walk' | 'air' | 'wall' | 'mantle'` replaces the boolean `air`.
  - Keep `get air()` (= `mode === 'air'`) for readers like main.ts:~856.
  - Rewrite every assignment site (`snap`, `setFlying`, `tryJump`, the else branch, landing) to set `mode`.
- `get climbing()` = `mode === 'wall' || mode === 'mantle'`.
- New fields:
  - `face: Face | null`, `noGrabUntil`, `mantle` (from/to and t), `lunge` (dir and t);
  - `rock: Uint8Array | null`, `grid: TileGrid` (set from main.ts on fullState: `renderer.terrain.grid`, which
    receives god tile edits in place);
  - `reason: CtrlReason` (main.ts sets it from frames: the controller must tell `hold` from `autopilot`);
  - `rain: boolean`;
  - callbacks `onClimbStep()` and `onFall(impact)`.
- `climb(dt, now)` and `mantleStep(dt)` are sibling functions of `fly()`.
- Whenever the mode changes to walk, set `smoothEye = eyeY` so the eye smoothing and the 3 m snap don't jerk.

### C1. Passability

`passable(ix, iz)`: out of bounds → no. Otherwise look at the **tile type first**:
- `'cliff'` → yes unless `rock[i]`. The slope rules (C2) govern movement on it.
- any other type → `walk[i] > 0`, exactly as today.

`clear()` uses `passable()`. Add `unstick()`: the ring search from `setFlying(false)` (controller.ts:~130–142) for the
nearest `clear()` spot. Run it whenever walk mode begins and `!clear(x, z)`.

### C2. Walk mode, slope rules (cliff tiles only)

For each sub-step of `move()`, if the tile at the current or next position is `'cliff'`:
- **Uphill wall:** `slopeAlong(pos, moveDir) > WALL` → block that axis (velocity zeroed), like a blocked tile. Record
  "blocked by a wall" for the climb-start rule.
- **Downhill drop:** `slopeAlong(pos, moveDir) < −WALL` → `mode = 'air'`, `vy = 0`, horizontal velocity kept.
  You walk off the edge and fall.

After moving, on a cliff tile, if `faceAt(x, z).slope > WALL` under the feet, switch to `air` (C3 then slides you
down). This covers landing on a face, snaps, loads, fly-mode drops and corrections.

Off cliff tiles nothing changes: the eye snap, smoothing and so on stay as they are.

The procedural ground never reaches these branches. Neither do non-cliff tiles of terrain islands, apart from the
`passable` check being identical to today.

**Starting a climb:** the C2 wall block happened this frame, forward is held, the view faces within 60° of
`−faceAt.n`, and this has lasted 0.15 s, with stamina ≥ 5, not dragging (`dragging`), `view === 'normal'`, and
`reason === 'player'`. Then enter `wall` with `feetY` = current feet.

`tryJump` and `tryDodge` require `mode === 'walk'` (or `!climbing && mode !== 'air'` as today for dodge).

### C3. Air mode

- Existing physics (gravity 22, air control).
- **Grab:** Space held (`controls.down('jump')`), `now ≥ noGrabUntil`, stamina ≥ 5, not dragging, view `normal`, and
  `wallNear(x, z, feetY + HANDS)` → `wall`, `vy = 0`.
- **Landing** (`feetY ≤ gy`):
  - On a cliff tile where `faceAt.slope > WALL`, it is a **slide**, not a landing: `feetY = gy`, keep `vy` (still
    falling), and set the horizontal velocity to `max(|v|, 3 m/s)` along the downhill direction `n`. The landing
    test runs again next frame. Speed builds while you slide down a face, and you hit the bottom with it.
  - Otherwise land as now: `onLand(impact)` for effects, `onFall(impact)` for damage (the sim decides), then
    `unstick()` if `!clear()` (e.g. the water at a sea-cliff foot).
- Air movement uses `clear()`/`passable` and the uphill wall rule, so you can't fly into a face.

### C4. Wall mode (`climb`)

The body is at `(x, z)`, `feetY`, with face `face`. The **anchor** is the point at feet height on the face:
`distToFace(x, z, n, feetY)` keeps the body `STANDOFF` out from it. The ground under the body is therefore always
below the feet.

Each frame:
1. **Input** (only when `reason === 'player'`):
   - Forward/back → `feetY ± CLIMB_SPEED·dt`.
   - Left/right → move along the tangent `(−nz, nx)` at `CLIMB_SPEED·dt`. If the new body position is not `clear()`,
     undo the lateral part.
   - Shift + direction → lunge in that direction (needs ≥ 15 stamina).
2. **Re-anchor:**
   - Normal `n` = `faceAt` at the anchor point, at `feetY + HANDS`.
   - Move the body along `n` so the face distance at feet height is `STANDOFF`.
   - If `distToFace` at feet height finds nothing within 2 m, go to step 3 (mantle or let go).
3. **Exits**, checked in order:
   - **Mantle:** moving up, and the ground 0.8 m beyond the anchor is ≤ `feetY + HANDS`, flatter than `LEDGE`, and
     `clear()` there → `mantle`. If it isn't clear (a house or wall on the lip, deep water, rock), you can't mantle
     here: you stay on the wall and must traverse sideways.
   - **Stand:** the ground slope at the body position < `LEDGE` and `|feetY − Ground.y(x, z)| < 0.15` and `clear()`
     → `walk`. This covers both a ledge and the foot of the climb. If not `clear()` (the foot is water), you don't
     descend any further: `feetY` is clamped.
   - **Face flattened** (anchor slope < `LEDGE`) but no stand → treat as the mantle test above, otherwise let go.
   - **Stamina 0** → let go: `air`, `vy = 0`, pushed 0.3 m along n if `clear()` there, `noGrabUntil = now + 0.6`.
   - **Dodge (C) pressed** → let go (no stamina rule).
   - **Space pressed** → wall jump (looking away from the face) or an upward lunge (C7 routes the press here).
   - **`knock()`** (main.ts calls it on `f.hurt > 0`) → let go.
   - **View becomes `downed` or `carried`** → let go (downed) or `snap` (carried: the sim moves you).
   - **`reason` becomes `autopilot`** → `snap` (the sim moves you; D3).
4. **Stamina:** −`DRAIN_MOVE` or −`DRAIN_HOLD` per second (× 1.5 in rain), but only while `reason === 'player'`.
   No regen in wall or mantle mode.
5. **Eye:** `eyeY = feetY + EYE_H` (no smoothing, no bob).
6. Every 0.6 m climbed, `onClimbStep()` (main.ts plays `step` with surface `'rock'`).

### C5. Mantle

Over 0.5 s: `feetY` rises to `Ground.y(top)` in the first 60%, then x/z lerp to the top point. No input. Then `walk`.

### C6. Hold, corrections and resync (the Esc problem)

- **The `ctrl !== 'player'` branch** of `update()` only applies its "air = false, eye to the ground" reset in walk
  mode.
  - In `wall`/`mantle` the controller stays frozen: no input, no drain, no regen.
  - In `air` it keeps simulating the fall with no input, and still calls `onFall` on landing.
- **Stamina regen** at the top of `update()` only happens in `walk`/`air` modes.
- **Frames** carry `champ.alt`, and corrections carry `alt` (D2).
- **`snap(x, z, alt = 0)` becomes mode-aware:**
  - If the controller is climbing and (x, z) is within 0.1 tile of where it is, it's a resync: keep the mode.
  - Otherwise place at (x, z) with `feetY = Ground.y + alt`.
    - If `alt > 0.3`, set `mode = 'air'` and try `wallNear` right away; if a face is found, regrab it **without**
      Space (a correction mid-climb puts you back on the wall, not on the ground).
    - Otherwise `walk`, then `unstick()`.
- **main.ts `onFrame`** passes `f.correction.alt` / `f.champ.alt` to `snap`.

### C7. What's disabled while climbing, and main.ts wiring

- **Frame loop** (main.ts:~788–815):
  - `take('jump')`: if climbing → `controller.wallJump()`, else `tryJump`.
  - `take('dodge')`: if climbing → `controller.letGo()`, else `tryDodge`.
  - `mouseL` swings, `setBlocking`, throw, interact and finish are no-ops while `controller.climbing`.
- **On fullState:** `controller.grid = renderer.terrain.grid`, `controller.rock = renderer.terrain.rock`.
- **Each frame:**
  - `controller.reason = ctrlReason`;
  - `controller.rain` from `renderer.sky.atmosphere.weather`;
  - `f.hurt > 0` → `controller.knock()`.
- **Callbacks:**
  - `controller.onFall = (impact) => input({ type: 'land', impact })`, only when `impact > 13`;
  - `onLand` still drives the landing kick and dust.
- **Monster circles** (main.ts:~847–854): skip a monster whose vertical span `[v.pos.y, v.pos.y + box.hgt]` doesn't
  overlap the champion's `[feetY, feetY + 1.8]`. Without this, a monster at the foot of the cliff shoves you around on
  the plateau above it.
- **Rendering:** `renderer.render` gets `climbing: controller.climbing`, and `viewmodel.ts` treats it like `dragging`
  (the weapon is lowered out of view).
- **Third-person:** `champPose.y = cam.y − EYE_H` already follows `eyeY`, so it works.
- **Poses:** the controller sends `alt = max(0, feetY − Ground.y(x, z))`, and `climb = 'wall'` in wall or mantle,
  `'perch'` when standing or airborne over a cliff tile, otherwise undefined. Poses keep being sent in wall mode
  (from `climb()`, same 50 ms cadence).

## Part D: sim

### D1. Height on the champion

- `HumanInfo` (`types.ts`) gains `alt?: number` (meters of the feet above `Ground.y`, champion only) and
  `climb?: 'wall' | 'perch'`.
- New in `body.ts`:
  - `feetY(ground: Ground, e)` = `ground.y(e.x, e.z) + (e.human?.alt ?? 0) + (e.monster?.alt ?? 0)`;
  - `reachM(e)` = `reachT(e) * M`;
  - `champReachable(ground, m, c)` = the vertical reach rule from the table (no Sim argument).
- `vReachOk(sim, m, t)` lives in **monster-ai.ts**, to avoid an import cycle (champion.ts already imports body.ts;
  monster-ai.ts imports champion.ts):
  - true unless `t.id === sim.championId && sim.grid.base` (a terrain island) and the rule fails.
  - `releaseOnChampion` gets the champion's feet height passed in, or computes it from body.ts the same way.

### D2. Poses and corrections

- `ChampInput` pose gains `alt?: number; climb?: 'wall' | 'perch'`.
- **`applyPose`:**
  - The tile test becomes `sameTile || sim.walkableFor(c, x, z) || (p.climb && sim.grid.get(ix, iz) === 'cliff')`.
    The sim doesn't check the rock mask: the client is trusted.
  - Speed bound: when `p.climb === 'wall'`, `max = Math.max(max, 9.5)` (lunges are 8 m/s, whatever `speedMul` is).
  - Vertical bound: `alt` may rise at most `10 · elapsed + 1` over the last accepted alt. Otherwise correct.
  - On acceptance: `human.alt = clamp(p.alt, 0, 300)` (0 if not finite), `human.climb = p.climb`. `S.poses` entries
    also store `alt`.
  - `fly` poses set `alt = 0`, `climb = undefined`.
- **`correct()`** keeps the current `alt` and `climb`, and `S.correction` gains `alt`. The frame's
  `champ: {x, z, yaw}` gains `alt` too (sim.worker.ts:~350, protocol.ts `FramePayload`).

### D3. Hand-over resets

In `stepChampion`:
- **`captive`:** `alt = 0`, `climb = undefined`.
- **`hold`:** keeps `alt` (the client is frozen on the wall, or finishing a fall and reporting `land`).
- **`autopilot` start, while `alt > 0` or on a cliff tile:** place the champion on `nearestWalkable(c, x, z, 24)`;
  if that is null, the village door, the same fallback as offline.ts:~76–80. Then `alt = 0`, `climb = undefined`.
  This fixes the idle-defense order being re-issued every tick when `nearestWalkable(r 4)` returns null in the
  middle of a plateau.
- **`downed`:** keeps whatever the client reports (the client lets go and falls).
- **Death, succession, and offline.ts `longAway`:** clear `alt`/`climb` on the champion (a new champion starts at
  0 anyway).

### D4. Falls

New input `{ type: 'land'; impact: number }`, accepted when the reason is `player`, `downed` **or `hold`**:
1. Clamp `impact` to [0, 60]. Ignore it if ≤ 13, or if another `land` arrived within the last 5 ticks.
2. Water: if `WATER_Y − ground.y(c.x, c.z) ≥ 1`, do nothing, whatever the tile type.
3. `impact > 28` → `applyDamage(sim, c, 9999, { type: 'crush', zone: 'torso', sourceId: -1, deathType: 'crushed' })`.
4. Otherwise `(impact − 13) × 4`: half to `legL`, half to `legR`, type `crush`, `sourceId: -1`. The two calls mean
   two blood bursts, which is accepted.
5. Add the damage to the frame's `hurt` explicitly, so the hurt flash shows; this also means a climber who takes a
   fall gets knocked off, which is harmless. Toast "You land badly."
6. Set `alt = 0`.

### D5. Vertical reach (champion only, terrain islands only)

Use `vReachOk` in each of these:
- **`releaseOnChampion`:** a candidate pose that fails it is a `miss` (use the pose's alt).
- **`fight()` wind-up:**
  - Add `vReachOk(sim, m, t)`.
  - For flyers, keep `!aloft(m)` when the champion's alt is 0. When the champion has alt, `vReachOk` alone decides,
    so a stooping flyer can strike a climber at its own height.
- **`hunt()` grab:** keep stalking when it fails.
- **`preyScore`:** the champion scores `-Infinity` when the besiege condition (D7) holds.
- **Champion `swing` `ok()`:** the target must be inside the sword's vertical band:
  `feetY(t) ≤ feetY(c) + 1.65 + SWORD_M` and `feetY(t) + heightM(t) ≥ feetY(c) + 1.65 − SWORD_M`.
- **`near()`** (interact/bind/finish) and **spear pickup:** add `|feetY(t) − feetY(c)| < 3`.
- **Spears:** `launch(sim, thrower, …, y)` takes the launch height. `champThrow` passes `feetY(c) + 1.6`, both for
  aiming and for launching.
- **Worker frame packing:** the champion's `y` adds `human.alt`.
- **Sim collision** (sim.ts:~728–747): skip pairs involving the champion when `alt > 3`, as for flyers.

Known 2D leftovers, noted in the README and not fixed in phase 1:
- `burstOn` puts blood at ground level;
- the god-module API (module-runtime.ts:~360) doesn't see `alt`;
- vision ignores height.

### D6. Flyers stoop on climbers

`targetAlt` in `fight`/`stalk`/`grab`: when the target is the champion with `alt > 0`, return
`max(current formula, feetY(t) − ground.y(m.x, m.z))`, capped at 120.

Flyers path over cliff tiles, so a stooping ziz will hover at the champion's x/z, partly inside the face. That's
accepted as a visual issue in phase 1 (README).

A hit from a flyer sets `f.hurt`, and the client lets go (C4).

### D7. Besiege

Besiege is a flag, `M.besiegeUntil`; the **state stays `'fight'`**, because `setState` stops the path on every
change and the fight branch sets `'fight'` every tick.

**Trigger**, in `fight()` before the wind-up logic. All of these:
- the target is the champion;
- this is a terrain island;
- `!canFly(m)` (`targetAlt` has no besiege case, which is fine because flyers never besiege);
- the champion's tile is `'cliff'`, or the champion's `alt > 0.5`;
- the champion's tile is not walkable for m (`!sim.walkableFor(m, t.x, t.z)`);
- the monster can't hit from where it is (`!vReachOk`, or `d > hitR`);
- the monster has arrived: `!sim.moving(m)` (it reached the goTo goal next to the cliff), or `go()` returned false;
- all of the above held for 20 consecutive ticks (`M.besiegeSince`, cleared whenever the condition breaks).

This means a monster at the bottom of a road walks up it instead (the champion's tile is walkable for it, or it
is still moving). A flat cliff tile next to walkable ground (`d > hitR` from the adjacent tile) also gets besieged
instead of stalling forever.

**While besieging:**
- the first time, set `M.besiegeUntil = sim.clockMs + max(1.5 * HOUR_MS, 90_000 * sim.timescale)` and
  `sim.emote(m, '💢', 2)`;
- no `go()` toward the champion. Every 80 ticks it paces to `nearestWalkable(m, m.x ± 1, m.z ± 1, 2)` (deterministic
  offsets from `sim.tick`, no rng);
- face the champion, and `roar` as `fight()` already does.

**Giving up** (`sim.clockMs > besiegeUntil`):
- `m.target = -1`, `M.besiegeUntil = M.besiegeSince = undefined`;
- `M.ignoreChampUntil = sim.clockMs + HOUR_MS`;
- `setState(sim, m, 'return')`;
- toast/chronicle "`<name>` gives up and slinks off."

**If the champion comes back within reach** (the trigger no longer holds), clear `besiegeUntil` and `besiegeSince`
and fight normally.

**`ignoreChampUntil`** is checked in the aggro (~296), the roar response (~314–316) and raid targeting (~464–473).
The champion hitting the monster (swing or spear) clears it, so the fight is back on, and possibly another besiege.

**Clearing stale besiege state:** when the target is dropped (~294–296), in offline.ts where states are reset
(~55–59), and in `startRaid` (~441).

`MonsterInfo` gains `besiegeUntil?`, `besiegeSince?` and `ignoreChampUntil?`. Check how `serialize.ts` saves
`MonsterInfo`; if it saves the whole object these come along, otherwise add them.

### D8. Loading

`deserialize`: clear the champion's `alt` and `climb`. If the champion is on a cliff tile, move them as in D3
(`nearestWalkable` r 24, else the village door). The first fullState after loading has `alt` 0, and the client snaps
to the ground.

## Part E: tests

### `test/climb-sim.test.ts`

Build an imported island from `DEFAULT_SETTINGS` as `terrain.test.ts` does, and find a cliff tile next to a walkable
tile with a big height step.

1. A pose onto the cliff tile without `climb` is corrected; with `climb: 'wall'` it is accepted, and `alt` is stored.
2. A correction while `alt` is 12 keeps `alt` 12 in the correction and in the frame champ.
3. `vReachOk` with `scale` pinned to the archetype's base scale: a nephil reaches a champion at alt 5 but not at 9;
   a tannin can't reach at 3.5. On a procedural island it's always true.
4. Release: a monster winds up, the champion reports alt 20 before the release, and the strike misses.
5. Besiege:
   - a non-flyer near a champion at alt 20 on a cliff tile never winds up and gets `besiegeUntil` set while its state
     stays `'fight'`;
   - it paces without restarting its path every tick (the path object persists between 80-tick paces);
   - it gives up after `besiegeUntil` and doesn't re-target the champion for an hour, via aggro, respond or raid;
   - a champion swing at it clears `ignoreChampUntil`.
6. No besiege when the champion is reachable by walking: they stand on a walkable terrace top reached by a road, and
   the monster walks up and attacks.
7. Falls: `land` 10 → no damage; 20 → leg damage, and `hurt` shows in the frame; 40 → dead, deathType `crushed`; on
   ground 1.5 m under water → no damage; `land` during `hold` is applied.
8. A ziz fighting a champion at alt 20 is above 15 m within 40 ticks.
9. Autopilot from the middle of a cliff plateau (alt 0, `nearestWalkable(r 4)` null) puts the champion on a walkable
   tile once. The order is not re-issued every tick.
10. Loading a save with the champion on a cliff tile with alt 12 puts them on a walkable tile with alt 0.
11. **Procedural unchanged:** a procedural island run for 3000 ticks with the champion standing on the High Place gives
    the same final `sim.rng` state and entity states as the same run with this feature's code paths stubbed out.
    Simpler alternative: assert no monster ever has `besiegeUntil` set and `vReachOk` was never false. The existing
    suite must pass unchanged.

### `test/climb-client.test.ts`

No DOM. Build a synthetic `TileGrid` with `base` set to a 20 m step over one cell, `orig` set to the tile heights,
types `'cliff'` on the step tiles and walkable on the foot and top, and `walk` 0 on cliff. Drive the controller with a
fake `Controls`.

12. `faceAt` points away from the step, and `distToFace` finds the face within 0.1 m.
13. The slope rule at dt 1/30, 1/60 and 1/144: walking into the face never climbs it, and walking off the top always
    becomes `air`.
14. Walking into the face for 0.15 s with forward held → `wall`. Holding forward climbs, then mantles on top.
15. Holding on a 60° face: the controller stays in `wall` for 2 s holding still (no flicker to walk).
16. With 10 stamina it falls, and `onFall` reports an impact > 13 at the bottom.
17. Landing on a 70° face slides down to the foot instead of standing on it.
18. Foot over a water tile (passable false): climbing down stops above it, and no stuck walk mode results. A mantle
    with a non-passable tile on top doesn't happen.
19. Hold while hanging: the mode stays `wall`, the stamina doesn't change, and the eye doesn't drop to the ground. On
    resume, `snap(x, z, alt)` at the same spot keeps `wall`.
20. Hold mid-fall: the fall continues and `onFall` still fires.
21. `snap` far away with alt 10 next to a face regrabs without Space held.
22. A climb doesn't start while `dragging` or with view `downed`. Space on a wall never calls `tryJump`'s ground jump.

### Manual and visual

`npm run dev`, a saved terrain, `?pose=x,z` at a terrace foot (it uses `nearestWalkable`, which is fine for a foot).
Check: climb, mantle, fall damage, Esc while hanging and mid-fall, a monster besieging, a ziz stooping, the rock mask
blocking a spire. Take screenshots with `ANGLE=d3d11 dev/winshot.sh`.

## Order of work

1. B (climb-surface) and tests 12.
2. A (rock mask).
3. C (controller) and tests 13–22.
4. D (sim) and tests 1–11.
5. main.ts wiring.
6. The full suite and `npx tsc --noEmit`.
7. The manual check.
8. The README: a "Climbing" section, plus the known 2D leftovers.
9. Update `docs/climbing-design.md`: the water depth is 1 m, and the status line.

## Accepted risks

- **The sim trusts the client's alt and climb flag.** It's single-player; the sim only clamps.
- **Hanging forever in hold** (Esc on a wall): no drain while paused. Monsters besiege and then give up; the 5-minute
  idle autopilot brings the champion down (D3).
- **A stooping flyer clips into the rock face** while it attacks a climber.
- **Faces on non-cliff tiles** (up to ~54.7° on walkable, road and KEEP tiles) still behave as today, with the eye
  snap and no climbing.

## Build notes (what changed while building, 2026-10-11)

Built as planned, with these departures. Each was found by a failing test or a headless run:

- **`localFace`** (climb-surface.ts): an unaveraged slope (±0.1 m). The "can I stand here" decisions use it: the
  steep-under-the-feet check, the slide, the stand exit and the mantle target. With `faceAt`'s 2 m average, a walker
  0.8 m from the foot of a wall already "felt" the wall, flipped to air every few frames, and never got close enough
  to start a climb. `faceAt` is still used for normals.
- **`wallNear` searches 1 m, not 0.6 m.** Heightmap faces lean back: at hand height, a 78° face is about 0.7 m from a
  climber's body. With 0.6 m, re-grabs and corrections mid-climb failed.
- **The slide** sets the horizontal speed to `max(|v|, 3 m/s, |vy| / slope)` along n. That's fast enough to follow
  the face down at the current fall speed. With the plan's `max(|v|, 3)`, a body on a 60° face was pinned for
  seconds while `vy` kept growing. There's also a 3 s safety cap.
- **Lip catch:** walking off a cliff top (or jumping) while holding Space catches the lip, hanging with the hands just
  below it (`fallFrom − HANDS`). Without it you can't start a climb down: at walking speed you're more than 1 m out
  before your hands drop to the lip.
- **Wall start** raises the feet 0.3 m onto the face, so the feet-height anchor isn't on the flat at the foot.
- **Re-anchoring** searches inward from 2 m out along n (up to 4 m), so a body that's slightly embedded still finds
  the face.
- **Over water:** in air and wall modes the body may be over water tiles (`free()`), on terraformer islands only,
  so you can fall into the sea at a cliff foot and then `unstick()`. The sim's `applyPose` accepts, on terraformer
  islands:
  - a climb or airborne pose on a cliff or water tile;
  - a `wall` pose on any non-structure tile next to a cliff tile.
- **Paused mid-fall:** main.ts doesn't copy the sim's x/z onto the controller during `hold` while it's in the air or
  climbing, so a paused fall carries on where it was going. The `land` input carries the landing x/z, and in `hold`
  the sim moves the champion there (when it's walkable or cliff). Otherwise resuming would teleport you back to the
  top.
- **Poses** only carry `alt`/`climb` on terraformer islands. Procedural islands send exactly what they did before.
- `groundChampion(sim, c)` (champion.ts) is the one "off the cliff" routine. It's used for autopilot, captivity and
  loading.
- Rock-mask coverage, measured: about 20 % of cliff tiles on the default and the saved terrain.
- Dev aids: `?hold=action:fromMs:toMs,…` and `?climblog=1` (README).
