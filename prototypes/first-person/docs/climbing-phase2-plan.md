# Climbing, phase 2: the feature mesh

Phase 2 of `docs/climbing-design.md`: spires, arch legs and spans, and overhangs become solid, climbable and
standable. Phase 1 (`docs/climbing-phase1-plan.md`) hard-blocked cliff tiles under that rock (the `rock` mask, about
20 % of cliff tiles). Phase 2 replaces the mask with collision against the triangles you see.

Everything stays gated to terraformer islands, with no new rng calls. Procedural islands have no feature mesh, so
nothing changes there.

## What the mesh is

`buildFeatureMesh` keeps the terraformer triangles that stand clear of the ground: about 7,000 on the default and
the saved terrain. They're big and faceted, with 12–17 m edges, because a 1.5–2 tile surface-nets cell with ±10 %
jitter is flat-shaded. About 30 % face mostly up, 20 % are steep and 50 % face down. The downward ones are arch and
overhang undersides and the bottoms of floating isles.

Spire footprints and arch legs are already `cliff` tiles (`ImportedTerrain.solid`). Arch spans stand over ordinary
tiles.

## Part A: the collision surface (`src/input/feature-surface.ts`, new, pure)

`FeatureSurface` is built from a triangle soup in meters and hashed per tile: each triangle goes in every tile its xz
bounding box overlaps, padded by 1.6 m. A point query reads only its own tile; a ray reads the tiles under its
bounding box. Queries (positions in tiles, heights and distances in meters):

- `floor(x, z, yMax)`: the highest surface of an upward-facing triangle (`ny > 0.1`) under the point, at or below
  `yMax`. Returns the triangle, or null.
- `ray(x, z, y, dx, dz, maxM)`: a horizontal ray, hitting front faces only. Gives the distance and the triangle.
- `normalAt(p, t)`: the normals of triangles within 1.5 m of `p` (on the same side as `t`), weighted by
  `1.5 − distance`. That way the camera eases across a facet edge instead of snapping.
- `sphereHit(x, z, y, r)`: the first wall-like triangle (`ny < 0.64`, i.e. steeper than 50°, undersides included)
  within `r`. This is the body test.

The **collision triangles** are the kept triangles, plus a **skirt**: dropped triangles that are steeper than 50°
on a `solid` tile. Without the skirt, a spire's lowest ~2 m would have no collision, since the heightmap there is
the landform under it.

## Part B: the controller

- **Floor:** `gy(x, z, ref = feetY)` is the higher of `Ground.y` and the mesh floor at or below `ref + 0.5`, so you
  step up onto low rock and stand on a spire top. Under an arch, the span is above `ref`, so the floor is the
  ground. In the air, `ref` is the feet before this frame's fall, so a fast fall can't pass through a spire top. Every
  `ground.y` that means "the floor" now uses `gy`. `alt` stays relative to `Ground.y`, as the sim expects.
- **Slope under the feet:** `floorFace` uses the floor triangle's own normal when the mesh is the floor, and
  `localFace` otherwise.
- **Slope rules** apply on cliff tiles, as before, and now also whenever you're on the mesh (`feetY` more than 0.3 m
  above `Ground.y`). So walking off an arch over grass is a fall, not a 40 m snap down.
- **The body:** three spheres (r 0.33 m) at feet + 0.55, 1.1 and 1.6. `clear()` tests them at the feet (or at a
  given target height for the mantle check). In walk mode, a sphere hit blocks the step and sets `wallHit` from
  `normalAt`, so pushing into a spire starts a climb exactly as on a heightmap face.
- **Face queries:** `faceDist(x, z, n, y, max)` takes the nearer of the heightmap's `distToFace` and the mesh `ray`,
  and returns the distance plus the `Face` there. A mesh face's slope is `h / ny` (99 when `ny ≤ 0`), and it gains
  `over: true` when it leans past vertical. `wallNear` and `reanchor` use it.
- **Ceilings aren't climbable:** a mesh hit with `ny < −0.7` (more than 45° past vertical) doesn't count as a wall,
  and in wall mode an upward move that puts the head sphere into rock is refused. You can climb up to an arch's
  underside, but not along it.
- **Overhangs:** `reanchor` reads the face at the feet (required), at mid-body and at the hands, and keeps the body
  STANDOFF from the nearest of them. On a face that leans out, that's the hands, so your head stays out of the rock.
  Climbing on an overhang drains stamina ×2 (the design's rule).
- **The mantle** target uses `gy` with `ref = hands`, `floorFace`, and the body test at the target height, so you
  pull up onto spire tops and arch spans.
- The `rock` mask goes. `buildFeatureMesh` returns `{ mesh, surface }`, `render/terrain.ts` keeps `surface`, and
  main.ts hands it to the controller as `controller.feat`.

## Part C: the sim

- **Vertical bound:** `applyPose` bounds the rise of the feet's absolute height (`Ground.y + alt`), not `alt`, so
  walking across an arch over a valley isn't corrected.
- **`climbTile`** also accepts a pose more than 3 m up on any non-structure tile (an arch top over the village's
  grass is walkable anyway; this covers water and other tiles).
- **`upCliff`** (besiege, prey choice) is also true when the champion is off the ground and out of the monster's
  vertical reach, even over a tile the monster can walk. Someone on an arch top over grass gets besieged instead of
  hunted forever from below.
- `sendPose` sends `climb: 'perch'` whenever the feet are on the mesh.

## Part D: tests (`test/climb-feature.test.ts`)

A synthetic spire, a 10 × 10 × 30 m box, and an arch. Tests 23–30:

23. `FeatureSurface`: floor on the top, none from an underside, ray distances, sphere hits.
24. Walking into the spire is blocked, and holding forward climbs it and mantles onto the top.
25. Walking off the spire top is a fall, with a landing reported.
26. Walking under the arch keeps you on the ground; on the span you stay on the span; walking off it falls.
27. A face leaning out 20° is climbable, drains ×2, and keeps the eye out of the rock.
28. An underside stops an upward climb: no passing through it.
29. On real terrain (DEFAULT_SETTINGS): every collision triangle is hashed, and a champion pushed into a spire
    found from `solid` starts a climb.
30. Sim: an arch-top pose over grass with a valley under it is accepted, and the besiege rule holds there.

Phase-1 tests 1–22 must still pass unchanged.

## Out of scope

Floating isles (reached by being carried, in phase 4), eye rays for aiming against the mesh, and blending
heightmap and mesh normals across a seam (the nearer surface wins).

## Build notes (what changed while building, 2026-10-11)

Built as planned, with these departures. Each was found by a failing test or a headless run:

- **The mantle checks its path** (`pathClear`): horizontal rays at the body heights from the climber to the target.
  The sphere test only sees surfaces near the body, so the inside of a spire looked like open ground 0.8 m into the
  face, and the climber "mantled" into the rock.
- **The walking body test** runs at the higher of the feet and the floor at the next step. Testing at the next
  step's floor alone put the body on the ground beside the spire as you walked off its top, so the spire's own side
  blocked you from walking off.
- **`applyPose` takes the smaller of the two rises** (`alt`, or the feet's absolute height) instead of replacing the
  `alt` bound. Phase-1 test 1–2 steps onto a cliff tile in one big pose that only the `alt` bound allows. Either way,
  the bound stays a loose check on a client-authoritative pose.
- **`wallNear` moved into the controller**, since it needs the mesh. `climb-surface.ts` keeps the ground-only queries.
- **Test 29 changed.** Steep rock that reaches walkable ground is rare on the real terrains: 3 such faces on the saved
  terrain. Most kept triangles stand 60 m or more above the ground (floating isles, high spans), and spire bases flare
  out gently. So the test grabs real faces 3–40 m up and climbs on: 38 of 40 hold and climb 1 m or more.
- **Test 30** checks pose acceptance, and that a ground monster under the arch can't reach. It doesn't run a full
  besiege; phase 1's test 5 covers that, and `upCliff` only adds the out-of-reach case.

Measured on the saved terrain:
- **Collision:** 6,874 drawn triangles plus 467 skirt triangles; the build is about 1 s, as before.
- **The 88,64 footprint** is a slab about 10 m up, and you walk under it.
- **Headless climb of a real spire:** a 20 m spire at 66.5, 46.7 (yaw 120). The champion climbed 15 m in about
  9 s (stamina 100 → 32), pulled up over the edge, walked up the top to 29 m above the ground, crossed it, and walked
  off the far side into a fall. A third-person shot partway up shows the body in front of the face, not inside it.
