# Climbing, phase 3: mounting monsters

Phase 3 of `docs/climbing-design.md` (Part 2, build step 3): climb volumes for the nephil, getting on, moving on the
body, and the camera. The monster doesn't fight back yet; shakes, holding on, per-monster moves and attacks from the
body are phase 4.

Like phases 1 and 2, everything is gated to terraformer islands (the sim ignores a mount pose elsewhere), and nothing
new calls the rng.

## Part A: climb volumes (`src/sim/climb-body.ts`, new, pure)

`CLIMB[archetype]` lists capsules `{ a, b, r, zone }`. A capsule runs between two **named body points**, and its
radius is in shape units, so the entity's scale sizes it. The point names (`hips`, `chest`, `neck`, `headTop`,
`shL`/`elbowL`/`handL`, `hipL`/`kneeL`/`footL`, and the right-hand ones) are shared by both kinds of rig:

- **Procedural rigs** (`rigs.ts`): `biped()` adds the points as empty joints at the shoulder, elbow, hand, hip, knee,
  foot and head top. So every biped has them, for phase 5.
- **The generated model** (`glb-rig.ts`): `MODELS.nephil.points` maps each name to a bone (`LeftUpLeg`, `LeftLeg`,
  `LeftFoot`, `Spine`, `head_end`, …), the same way `MODELS.bones` maps zones.

The nephil has 11 capsules: two per leg (shin and thigh), the torso (hips to chest: back, belly and belt), a capsule
across the shoulders, two per arm, and the head. Capsules on a severed zone are left out.

The design's `{ joint, a, b }` became point pairs: an offset in a joint's frame means something different on a
procedural limb and on a Mixamo bone, but a named point is the same place on both.

## Part B: the body as a surface (`src/render/climb-rig.ts`, new)

- `bodyCaps(view)`: the view's capsules this frame, in world meters, with the joint that carries each one: the parent
  of the end that hangs from the other (the thigh rides `LeftUpLeg`, the torso rides the upper spine), or the joint
  both hang from (the shoulders).
- **Where you are on the body** is `(capsule, u, dir)`: `u` along the axis (0..1) and `dir`, the outward direction,
  stored in the carrying joint's frame. Each frame the anchor is rebuilt from the posed rig as
  `lerp(a, b, u) + dir·r`, so it rides the animation, the monster's walk and turn, and a downed monster's roll.
- **Moving** slides the anchor by a world displacement and projects it back onto the union of capsules: out of the
  deepest capsule it ended up inside (that's how you pass from the thigh onto the torso), otherwise onto the nearest
  surface, preferring the current capsule. Passing an end cap wraps round it.
- `Mounts.find(point, maxM, how)` is the getting-on rule (below). It returns a `MountBody`: `place()`, `move()`,
  `yaw()` and `tilt()`. That's the controller's whole view of the body, so the controller stays free of three.js.
- **Order of a frame:** the entities are animated *before* the controller runs (`Renderer.animate`), so the rider is
  placed on this frame's pose, not the last one. Otherwise the camera would trail a walking leg by a frame.

## Part C: the controller (mode `mount`)

- **Getting on** (the design's three ways):
  - **Downed:** Space beside a downed monster (hands within 1 m of the body, facing it) climbs on instead of jumping.
  - **Its attack recovery:** in the air with Space held, hands within 0.8 m of the body, during the 1.5 s after its
    strike lands (the sim's `attackReadyAt`). The view keeps `struckAt` for this.
  - **From above:** falling at more than 5 m/s with the feet inside the body volume grabs automatically, wherever
    you land on it. The fall ends there, so it doesn't hurt.
- **Moving:** WASD at 1.8 m/s. W moves along the camera's up plus forward, projected onto the surface. Facing a
  leg, that's up; standing on the shoulders and looking ahead, it's forward. A/D move along the camera's right. Sprint
  plus a direction lunges 2 m along the body for 15 stamina, as on rock.
- **The view:**
  - The anchor is where the hands are. On a steep part the eye hangs 0.45 m out from it and 0.35 m above it (hands
    1.3 m above the feet, as on rock). On a top (normal within ~37° of up) you stand on it, so the eye is EYE_H
    above the anchor. Between the two it blends.
  - The view turns with the monster's yaw, and takes 30 % of its pitch and roll (the hips joint against the moment
    you got on).
- **Stamina:** the climbing drain (6 moving, 3 holding, ×1.5 in rain). On a top you're perched: no drain, and it
  regenerates.
- **Getting off:**
  - **C** lets go: a fall, pushed 0.3 m off the body, with normal fall damage.
  - **Space while looking away** from the body jumps off; otherwise it lunges up.
  - **Climbing down a leg** onto the ground puts you back on your feet.
  - **Running out of stamina, any hit (`knock`), the body leaving view (killed, despawned), or the sim taking over**
    drops you.
- `climbing` includes `mount`: no swinging, blocking, throwing or interacting while on a body (attacks from the body
  are phase 4), Space and C are routed as on a wall, and the weapon is lowered.
- **Pose:** `climb: 'mount'`, `mount: { id, cap }`, and `alt`, the feet above the ground.

## Part D: the sim

- **`applyPose` with `climb: 'mount'`** checks the monster: alive, climbable (`CLIMB`), on a terraformer island, the
  pose within its height of its position, and the feet no higher than its top + 1 m. It skips the walk and speed
  rules, since the monster does the moving. A failed check is a correction. `human.mount = { id, cap }`.
- **The ridden monster leaves its rider be** for now: `fight()` against the rider cancels any windup and stands
  still, and `releaseOnChampion` misses the rider. Other monsters hit as usual, and a hit knocks you off on the
  client.
- **`separate()`** skips a mounted champion. The champion is an immovable obstacle there, so a rider on a shin would
  otherwise shove the nephil away.
- `clearClimb(c)` (alt, climb, mount) replaces the paired deletes in groundChampion, land, fly, crown and offline,
  so saving, hand-over and captivity clear a mount the same way they clear a climb.
- **Dev:** the scenarios `nephil` (the nearest nephil, standing beside you and ignoring you) and `nephil-downed`.

## Part E: tests (`test/climb-mount.test.ts`)

31. Every nephil capsule's points exist on the procedural rig, and on the model: every bone named in
    `MODELS.nephil.points` is in `nephil.glb`.
32. **Following:** attached to the shin of a procedural nephil, the anchor stays on the same spot of the surface (to
    1 cm) while the body walks, turns 90° and rolls onto its side.
33. **Moving:** holding W from the left shin climbs the leg, onto the torso and up to the shoulders. The anchor never
    sinks more than 2 cm into any capsule.
34. **Controller:**
    - It mounts with a fake body.
    - Stamina drains 6/s moving, not at all on a top.
    - It falls at 0 stamina.
    - C lets go into a fall, and a fall from the shoulders reports `onFall`.
    - Climbing down to the ground stands you up.
35. **Getting on:**
    - Space beside a standing monster jumps; beside a downed one, it mounts.
    - An air grab works only in the recovery window.
    - A drop from above grabs without Space.
36. **Sim:**
    - A mount pose is accepted, and x, z and alt follow.
    - A pose too far from the body, on a non-climbable monster, or on a procedural island is ignored.
    - The ridden nephil never strikes its rider over 60 ticks, and isn't shoved.
    - `groundChampion` clears the mount.

Phase 1–2 tests (1–30) must still pass unchanged.

## Out of scope (phase 4 and later)

Shakes and holding on, the nephil's grab, attacks from the body (zones by capsule, ×2 damage), flyers and floating
isles, the other monsters' volumes, a climbing animation for the champion's body in third person.

## Build notes (what changed while building, 2026-10-11)

Built as planned, with these departures. Each was found by a failing test or a headless run:

- **A climbable monster's client collision circle is its trunk:** the sim's `BODY` radius, about 1 m on a nephil.
  Before, it was the hit box's width (arms and club, over 3 m), so a standing nephil's legs were never in reach.
  Other monsters keep the hit box.
- **Reach for getting on:**
  - 1.2 m from the hands beside a downed body, and 1 m in a jump.
  - A downed body lies low, so Space beside one also reaches down from the waist (feet + 0.6 m).
  - Facing it is only required when the nearest point is more than 1 m away. Standing over or beside a downed body,
    the nearest point is often underfoot or behind you.
- **You face what you grab** (unless you dropped onto a top). Otherwise a grab beside you left you staring away from
  the body.
- **The torso capsule's lower end** reaches down over the tops of the thighs. That stands in for the loincloth and
  belt, so a grab 1.3 m up a standing nephil lands on the torso, and test 33 reaches low to start on the shin.
- **Dev:**
  - `?script=` scenarios now run once the world is loaded, and `?hold=` times count from then too. Loading takes a
    varying few seconds, which made boot-relative timings useless.
  - `?hold=` also presses one-shot actions such as jump.
  - `?mountany=1` drops the getting-on rules, for headless checks on a standing nephil.
  - The climb log names the body being ridden and the nearest nephil.
- **Seeds:** seed 7, the one phases 1–2 were checked on, has no nephil. Test 36 and the headless checks use seed 1.

Checked headless on seed 1, against the generated model (`nephil.glb`), not only the procedural rig:
- **Downed nephil:** Space beside it gets you on, and holding forward walks you across its low body and off the far
  side.
- **Standing nephil** (`?mountany=1`): you get on its torso facing it, with the model's skin 0.45 m from the eye, and
  climb up its back to the shoulders, about 4 m up. Holding still drains 3 stamina a second. A third-person shot shows
  the champion standing on its shoulders.
- **Not done yet:** a climb onto the top of the head. From the back of the shoulders the head capsule is in the way,
  and you stay at the shoulders.
- **Load-sensitive tests:** two existing tests have wall-clock limits (island generation under 5 s, and vitest's 5 s
  default timeout). They failed in 2 of 13 full runs, with the new file running alongside them, and pass on their own.
