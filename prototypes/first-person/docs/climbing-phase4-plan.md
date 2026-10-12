# Climbing, phase 4: monsters fighting back

Phase 4 of `docs/climbing-design.md` (Part 2, "Fighting back", build step 4). The monster you ride reacts:
- it shakes,
- you hold on,
- the nephil grabs at you,
- you attack from its body,
- a flyer carries you up to the floating isles.

Phase 5 covers the other walkers' volumes and moves: Anak's scrape, Se'ir and Re'em bucking, and Rahab diving.

As in phases 1–3:
- Everything stays gated to terraformer islands.
- Nothing new calls the rng.
- The client decides where you are on the body. The sim decides shakes, throw-offs and damage.

## Part A: the ridden state (sim, `monster-ai.ts`)

A monster is **ridden** while the champion's `human.mount.id` is its id.
- **When the branch runs:** first in `stepMonsterAI`, over whatever the monster was doing (carrying, feeding,
  sacrificing), except when it's downed or bound. So a downed body never shakes.
- **What it replaces:** `fight()` against its rider. Phase 3's stand-still stub goes.
- **Ignoring the champion:** getting on clears the monster's ignore timer. Something on its back gets its attention.

Each archetype's ride rules are in `RIDE` (`src/sim/climb-body.ts`):

| | nephil | ziz | saraph |
| --- | --- | --- | --- |
| shake every | 30 ticks | 50 | 45 |
| a held shake costs | 15 stamina | 15 | 15 |
| grab | the left (free) arm | none | none |
| flies | no | yes | yes |

### Shakes

- **First shake:** 25 ticks after you get on. After that, one every `every` ticks.
- **The telegraph:** the shake starts with a 6-tick (0.6 s) telegraph: a roar, and the new entity flag `F_SHAKE`.
  The client shudders the rig, and the rider's view with it.
- **When it lands:**
  - **Holding on** (the sim's `blocking` while mounted: right mouse): a `shake` combat event with the cost. The
    client takes the stamina.
  - **Not holding on:** a `thrown` event. The sim drops the mount but keeps `alt`, since the champion is in the air
    now. It refuses mount poses on that monster for 10 ticks: they're ignored, not corrected, because they're only
    latency. The client throws you off, away from the body (6 m/s out, 4 m/s down), and the landing hurts as any
    fall does.
- Each shake also twists a walker 0.5 rad, alternating sides, so the view swings.
- No shakes while it's staggered or winding up a grab.

### The nephil's grab

- **When it grabs:** when the rider is in reach of its free left arm, that arm isn't severed, and
  `attackReadyAt` has passed. The grab is an ordinary 8-tick windup: `F_TELEGRAPH`, so the rig's windup pose and the
  HUD warn.
- **In reach:**
  - the shoulders, the head and the arms (capsules 5–10), from anywhere;
  - the torso and the thighs (4, 1, 3), only in front of it: within 80° of its facing when it starts to reach. When
    its hand closes, a rider still on that capsule is caught. Its own windup swings the leg you're on round, so the
    angle alone would miss.
  - The shins are below its reach, and so is the back of the torso.
- **When it releases:**
  - **Still in reach, no i-frames:** `0.8 × dmg` crush to the torso, and a `thrown` event with `hard`: hurled 9 m/s
    away.
  - **Otherwise:** a miss. `attackReadyAt` is `+15` as after any blow, so the recovery window for jumping back on
    opens.
- You don't dodge the grab by holding on. You dodge it by climbing out of reach.

### Stagger

`M.staggerUntil`: no shakes, no grabs and no moving, with a 💫 emote.

### Thrown-off bookkeeping

`ChampState.unmount = { id, until }`.

## Part B: attacks from the body (sim, `champion.ts`)

- **Swinging while mounted** skips the reach and arc tests: the target is the ridden monster.
  - The zone is `capZone(arch, cap)`.
  - Damage ×2, unblockable (monsters don't block anyway), and no ambush bonus.
  - **On the head:** ×3 instead of the usual ×1.5, and it staggers the monster for 20 ticks (2 s).
  - A downed or bound monster still can't be hit, as now: you finish it instead.
- **A spear thrown while mounted** is a point-blank thrust: the spear's damage (`24 × level`) ×2, pierce, on the
  capsule's zone (×3 and a stagger on the head). The spear is spent: it stays in the wound. The throw isn't launched.
- **Severing the zone you're on drops you with it.** The client's rider finds its capsule gone and lets go, rather
  than moving to the nearest capsule (phase 3 did that).
- **Holding on isn't a block:** against other monsters' blows, `releaseOnChampion` ignores `blocking` while mounted.

## Part C: flyers (sim; points and volumes on the serpent rigs)

- **Climb volumes for the ziz and the saraph:**
  - **New body points:** `back`, `tail`, `wingL`/`wingR` (the wing roots) and `wingMidL`/`wingMidR`.
  - **The ziz:** its back (neck to tail, r 0.14), the wing roots (r 0.06, zone `sig`) and the head.
  - **The saraph:** the front of its body (torso), its tail (`legL`, as its rig marks the rear segments), its wing
    roots (`sig`) and its head.
  - Only the procedural rigs have them, since neither has a model.
- **Getting on:** the same three ways as the nephil. A downed flyer lies on the ground. The recovery window opens
  after it stoops and strikes at your height. A drop from above works on one at rest.
- **Ridden flight:**
  - **On the ground:** if you get on away from an isle, it heads for the nearest floating isle. It climbs (5 m/s) to
    the isle's top + 3 m, flies over it, and circles there.
  - **Over an isle** (you got on up there): it goes home and lands at its lair.
  - **No isles on the island:** it circles at 25 m where you got on.
  - **Shakes are rolls:** the rig rolls instead of shuddering.
- **Floating isles in the sim:** `ImportedTerrain.isles` (`{ x, z, R, top }`, tiles and meters) comes from the field.
  `fantasy-terrain.js` returns its `isles`, which nothing read before.
- **Letting go over an isle** lands you on its top: the client's fall already stops on the feature mesh's floor, and
  the sim accepts any tile at `alt` > 3 m.
- **The wing:** severing the wing (`sig`) while it's ridden brings it down in a **crash landing**:
  - It falls 1 m a tick instead of 3.
  - When it hits the ground, it's downed.
  - Your capsule may have been the wing, and then you drop with it.

## Part D: the client

- **Holding on:**
  - Right mouse while mounted is `holding`. It sends the same `block` input the sim already reads.
  - It stops your movement.
  - It doesn't drain on a top. Elsewhere it drains like any hold.
  - A `shake` event takes its cost from stamina, and it can wind you, which drops you.
- **Thrown:** `controller.throwOff(awayX, awayZ, hard)` goes into a fall with that velocity, and the grab-noGrab
  timer stops you grabbing straight back.
- **Swinging and throwing on a body:**
  - `trySwing` and `throw` work in mount mode, but not while holding on.
  - The weapon is raised.
  - The swing's target is the ridden body, and the blood shows at the anchor.
- **The shudder:** a view with `F_SHAKE` jitters its root (a walker: a 25 Hz yaw and roll wobble; a flyer: a roll
  building up). The rider feels it through the anchor, and the camera adds a little kick.
- **HUD hints:** `hold` the first three times a body you're on starts to shake ("Hold on: [right mouse]"), and `grab`
  when the nephil reaches for you.
- **Dev:** the scenarios `ziz` and `ziz-downed`, which do for the nearest ziz what `nephil` and `nephil-downed` do for
  the nephil.

## Part E: tests (`test/climb-fight.test.ts`)

37. **Shakes:** a ridden nephil telegraphs (`F_SHAKE` timing) and lands a shake 25 ticks after you get on, then every
    30.
    - Held: a `shake` event, and you're still mounted.
    - Not held: a `thrown` event, the mount cleared, and mount poses on it ignored for 10 ticks.
38. **The grab:**
    - On the shoulders: a windup, then a `thrown` (hard) event and damage.
    - On the back of the torso: no windup.
    - With the left arm severed: no windup.
39. **Attacks from the body:**
    - A swing while mounted on the thigh hits `legL` for twice a normal swing's damage.
    - On the head: three times, and a stagger. No shakes during the stagger.
    - A spear from the body deals damage and spends the spear.
40. **The controller:**
    - Holding stops movement.
    - A shake costs 15 stamina.
    - `throwOff` falls away from the body.
    - Swinging works on a mount, but not while holding on.
    - A severed capsule drops you.
41. **Flyers:**
    - The ziz's and the saraph's capsule points exist on their rigs.
    - A ridden ziz climbs toward the nearest isle and ends up over it, above its top.
    - With its wing severed, it comes down and is downed when it lands.
    - A pose standing on the isle is accepted.

Phase 1–3 tests (1–36) must still pass unchanged.

## Out of scope (phase 5)

- The other walkers' volumes and moves (Anak, Se'ir, Lilit, Re'em, Rahab, the tannin's constriction).
- A climbing animation for the champion in third person.
- Viewmodel hands.
- Audio for grips and breathing.
- The terraformer's climb view.

## Build notes (what changed while building, 2026-10-11)

Built as planned, with these departures. Each was found by a failing test or a headless run in the real game:

- **The grab's reach is decided when it starts.** The nephil's windup animation swings the thigh you're on round, so a
  rider in front at the start was behind it 0.8 s later, and every grab missed. When its hand closes, it catches a
  rider still on the capsule it reached for, or anywhere else in reach.
- **The ridden branch comes first.** It runs before the carry, sacrifice and feed cases, not after them, so a feeding
  or carrying monster reacts to a rider. The dev scenarios now leave the monster feeding: a ziz at rest by day takes
  off on its rounds before you can reach it.
- **Flyers are ridden astride.** `RIDE.perch` is 0.3 for the ziz and saraph: anywhere on the upper half of the back
  or a wing is a seat, where stamina comes back between rolls.
  - **Why:** with the standing rule (0.8), a rider on the side of the back drained through an 18 s climb to an isle
    and fell from 180 m, every run.
- **The wing capsules start just clear of the back.** Starting at the wing joint, they began inside the back, so
  climbing up its side ran into a wing's underside.
- **Mount poses allow for render lag.** The client draws a body a few ticks behind the sim. A ziz at full speed moves
  about 5 m in that time, which is more than the pose's distance check allowed, so the rider was corrected off it.
  - **Horizontal:** half a second of the monster's speed is allowed.
  - **Vertical, on a flyer:** 7 m for a dive.
- **Letting go of a body blocks grabbing for 1.2 s, not 0.6.** Letting go of a flyer you sit on, you fell straight
  back onto it.
- **The ziz circles 3 m over the isle, not 8.** Letting go from 8 m up cost about 40 % of your health.
- **A flyer comes up to a climber up to 300 m, not 120.** At 120 it couldn't reach someone on an isle, so you couldn't
  get back on it to come down.
- **A phase 1 bug: hard landings cleared the champion's height.** `land()` deleted `alt`, so after a hard landing high
  up (on an isle, 140 m over the ground) the next pose looked like an impossible climb. The correction dropped the
  champion to the ground and killed them.
  - **Now:** it keeps the height and clears only `climb` and `mount`. A paused landing still clears everything.
  - **Water:** deep water breaks a fall only at its surface.
- **Rules unchanged:** shake cost, timings and the throw speeds are as planned.
- **Test 36 changed:** it asserted phase 3's stand-still stub, "no wind-up for 60 ticks", but now the grab is that
  wind-up. It now rides the shin, which is out of the grab's reach, and holds on through the shakes. It still checks
  for no blows and no shove.
- **Dev:**
  - `?terrain=default`: an island with floating isles. The saved terrain may have none.
  - `?hold=`: `grip` is the right mouse and `attack` the left. A one-shot action is pressed again every 250 ms while
    held and not climbing.
  - `?autogrip=1`: hold on through each shudder.
  - The `ziz`, `ziz-downed`, `saraph` and `saraph-downed` scenarios.
  - `?climblog=1` also logs shudders, shakes, grabs, throws, blows from the body and snaps to the sim.

Checked headless in the real game (seed 1):
- **Nephil** (`?script=nephil&mountany=1`):
  - **Not holding on:** the first shake threw the rider off.
  - **Holding on** (`grip`): each shake cost 15, and the fourth emptied the bar, dropping the rider.
  - **On the front of its thigh:** it reached and tore the rider off.
  - **Swinging right after getting on:** two blows landed on `legL` for 29 each, twice a normal swing.
- **Ziz** (`?terrain=default&script=ziz&mountany=1&autogrip=1`):
  - **Up to the isle:** it took off, climbed at 10 m/s to the isle's top, and circled over it. The rider stayed at
    full stamina between rolls.
  - **On the isle:** C dropped the rider onto the isle's grass at 172 m, alive.
  - **Back home:** the ziz came up to fight. Jumping back on, it flew the rider down to its lair.
  - **The rider's view:** at 180 m over the sea it looks right.

- **Saraph:** the same climb, with its rolls held and the rider seated on its body.

Not checked in the browser:
- the crash landing,
- a spear thrown from the body (tests 39 and 41 cover these).

No one has played it with a mouse yet.
