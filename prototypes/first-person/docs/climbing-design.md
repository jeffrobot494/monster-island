# Free climbing: design

Status: build step 1 (climbing the heightmap ground, falls, height in the sim, 3D reach against the champion,
besiege) is built: see `docs/climbing-phase1-plan.md` and its build notes. Step 2 (the feature mesh) is built: see
`docs/climbing-phase2-plan.md`. Steps 3–5 are still proposals.

## Why

Terraformer islands are mostly vertical. About 45% of the default island's land is `cliff`: terrace faces, canyon
walls, spires, arch legs. Today all of it is scenery you walk around on the graded roads. Climbing turns it into
play, and the same system lets the champion climb the monsters, in the spirit of Shadow of the Colossus.

Pillars:

1. **Anything steep can be climbed, for a price.** There are no special handholds. Stamina is the limit, and the
   island's shape decides the routes. Roads are the slow, safe way; climbing is the fast, risky one.
2. **Big monsters are terrain that moves and fights back.** You climb them to reach weak points and ride them, and
   they try to throw you off.
3. **Height matters in the sim.** A high place is a refuge from some monsters and a lookout, a fall hurts, and
   monster reach becomes 3D for the champion.

## Part 1: climbing terrain

### Feel

- **Start a climb:** push into a surface steeper than 50° while moving forward. Or jump at it: in the air, any steep
  surface within 0.8 m of the eye is grabbed while Space is held. Falling past a ledge with Space held also grabs it,
  so dropping off a terrace edge and catching the lip is a move.
- **Move:** WASD moves across the face at 1.8 m/s, up and down and sideways. The camera stays free, so you can look
  around while hanging.
- **Lunge:** Shift + a direction jumps 2 m along the face for 15 stamina. It's how you cross a gap in the holds, or
  get up before the bar runs out.
- **Wall jump:** Space while climbing pushes you off the wall, backwards and up (look away from the wall first). It
  can carry you to the opposite canyon wall.
- **Let go:** C (dodge) drops you.
- **Mantle:** when the face above you turns walkable within 1 m, you pull up onto the top automatically (0.5 s,
  camera dips and rises).
- **Rest:** any spot flatter than 40° is a ledge. You stand there, stamina regenerates as usual, and you can climb on
  from it. Terraces turn a tall cliff into a staircase of short climbs with ledges in between.

### Stamina (the existing 100-point bar)

| Situation | Drain |
| --- | --- |
| Climbing, moving | 6 / s |
| Climbing, holding still | 3 / s |
| Overhang (face tilted past vertical) | ×2 |
| Rain (atmosphere `weather: 'rain'`) | ×1.5 |
| Lunge | 15 each |

At 0 stamina your grip fails and you fall. A full bar climbs about 30 m. With `heightScale` 4, terrace faces are
roughly 8–20 m, so one bar does a terrace. A 40–60 m spire needs a ledge partway up or a lunge at the end. These
numbers are a starting point, and the terraformer's climb view (Part 4) is how we'd check them on real islands.

### Falling (new: there is no fall damage today)

Damage scales with landing speed, using the controller's existing `onLand(impact)` hook:

| Landing speed | Fall (gravity is 22 m/s²) | Result |
| --- | --- | --- |
| up to 13 m/s | about 4 m | no damage |
| 13–28 m/s | about 4–18 m | (speed − 13) × 4 hp, split between the leg zones; legs can be crippled |
| over 28 m/s | about 18 m or more | dies, death type `crushed` |
| any speed, into water at least 1 m deep | | no damage |

Crippled legs are a big deal: the champion moves at crippled speed. Falls feed the violent death system without
needing anything new.

### What can be climbed

Climbing tests the geometry you see, so your hands touch the rock on screen. There are two sources:

- **The heightmap ground** (`Ground`): terrace faces, canyon walls, and the steep slopes of procedural islands too. The
  wall's normal comes from the heightfield's slope averaged over 2 m, not from single triangles, so the sawtooth on
  cliff faces doesn't make the camera jitter.
- **The feature mesh:** spires, arch legs and spans, overhangs, the undersides of floating isles. These triangles get
  sorted into a per-tile hash on the main thread when the mesh is built, which adds a few milliseconds to the
  existing ~850 ms build. Rays cast from the eye pick the nearer of the two surfaces.

As a result, the feature mesh also becomes **ground you can stand on**. The controller's floor becomes the higher of
the heightfield and any upward-facing feature triangle under your feet. So you can stand on a spire top, walk across
an arch, and walk under it on the heightfield. Floating isles are reachable only by being carried by a flyer
(Part 2).

### Walking on cliff tiles

`cliff` keeps its meaning for the sim: villagers, monsters and pathfinding can't use it. The champion can, while
climbing or perched. A perched champion can walk on a cliff tile as long as the slope under their feet is flatter than
40°, checked on the client, so a spire top or a small high plateau works as ground. Everything else about walking is
unchanged.

### In the sim

The sim stays 2D for everything except the champion, who gains a height:

- **Pose message:** the pose gets `alt` (feet above `Ground.y`, in meters) and `climb?: 'wall' | 'perch' | 'mount'`.
  It works like the existing `fly` flag. `applyPose` accepts cliff tiles when `climb` is set, and rejects a pose
  that moves faster than climbing speed vertically. That's the same tolerance it uses for horizontal moves.
- **Reach:** reach becomes 3D for attacks on the champion only. In `releaseOnChampion` and monster target choice, a
  monster can't hit the champion when `alt` is more than its height plus its reach, minus 1 m. A nephil (5 m tall,
  3.4 m reach) can still pluck you off a low wall; a tannin can't.
- **Sitting out of reach:** when its target is out of reach, a monster switches to a new `besiege` state. It waits at
  the foot of the cliff, circles, and roars, then loses interest after one to two game hours. That's what makes a high
  place a refuge, but not a perfect one:
  - **Flyers** (saraph, ziz) treat climbers as easy prey: they stoop. Any hit while climbing knocks you off the wall.
  - **Se'ir climbs** like the wild goat it is. It's the only monster that can follow you up, slower than you, on
    walls under 70°.
  - **The nephil throws rocks** (a new projectile reusing the spear flight code) at climbers out of its reach.
- **Landing:** the client reports `{ type: 'land', impact }` and the sim applies the fall damage. It's the sim's
  decision, like every other kind of damage.
- **Lookouts:** while the champion stands more than 30 m above the surrounding ground, sight range grows by 50%, and
  lairs inside it are marked found (`lairFound`). Spires become watchtowers worth climbing.
- **Saving:** a game saved mid-climb loads with the champion on the nearest walkable tile (the fly-mode landing code
  already does this). Climbing state isn't saved.

## Part 2: climbing monsters

### Which monsters

These are body sizes at the base scale; levels make monsters bigger.

| Monster | Size | How you climb it |
| --- | --- | --- |
| Nephil | 5 m tall | climbed: legs → loincloth/belt → back → shoulders → head |
| Anak | 3.4 m tall | climbed: back and shoulders |
| Se'ir | 3 m tall | climbed: back, then grab the horns |
| Lilit | 2.4 m tall | climbed briefly: back only; she shakes you off fast |
| Re'em | ox body, 2.3 m tall at the shoulder | ridden: hang on to the back and horns |
| Rahab | long and low, over 6 m long | ridden: along the back |
| Ziz and saraph | flyers | ridden: back and wing roots |
| Tannin | 1.4 m tall | not climbable; it constricts whatever grabs it |

### Getting on

- **Stunned or downed:** walk into the monster and press Space. This is the easy way.
- **From above:** drop from a ledge onto it. If you land within its body volume, you grab automatically. This is
  where terrain and monsters meet: you lure it under a terrace and jump. The fall counts only down to its back, so
  you take no damage.
- **During its attack recovery:** in the short window after its strike lands (`attackReadyAt`), jump at a leg or
  flank to grab it.

### Moving on the body

Each archetype has **climb volumes**: capsules attached to rig joints, in shape units, defined in a new
`src/sim/climb-body.ts` next to `BODY`. Each one is `{ joint, a, b, r, zone, grip }`. Both the procedural rigs and the
GLB rig map joint names (`body`, `hipL`, `shR`, `neck`, `segs[i]`, wing groups; the GLB maps to bone names the same
way `MODELS.bones` does), so one set of definitions drives both.

- **Your position on the body** is `(capsule, u along it, θ around it)`. WASD changes u and θ, and you move to a
  linked capsule where their ends overlap. The links are worked out once per archetype.
- **The camera** follows the joint's world transform every frame. It takes on the monster's position and turn, but
  only 30% of its pitch and roll, so a bucking monster reads as violent without making players sick.
- **Holding on:** while you're on a monster, right mouse means hold on instead of block. Holding on stops your
  movement and halves the drain from shakes.

### Fighting back (sim)

The monster gets a new state, `ridden`, that runs alongside whatever it was doing.

- **Shakes:** about every 3 s, the monster shakes. It's telegraphed: a roar plus a 0.6 s shudder on the rig.
  - If you're holding on when it lands, it costs 15 stamina (20 on lilit).
  - If you aren't, you're thrown off. You fly away from the body and land with normal fall damage, so being thrown
    off a nephil's shoulders hurts.
  - Reading the telegraph is the skill.
- **Per-monster moves:**
  - Nephil: grabs at you with a free arm if you're in its reach (front, shoulders). Severing that arm first, or
    climbing the back, keeps you safe. The club arm is its `sig` zone.
  - Anak: scrapes you off against a cliff tile if one is within 2 tiles.
  - Se'ir and re'em: buck, a double shake.
  - Rahab: heads for water and dives. You must let go before it submerges, or take drowning damage.
  - Flyers: climb to 20–30 m and roll. When you let go over a floating isle, you land on it. That's the only way onto
    floating isles. Damaging the wing (`sig`) while riding brings it down in a crash landing.
- **Your attacks while on a monster:**
  - Your swing hits the zone of the capsule you're on, so you choose your target by where you climb.
  - Damage is doubled and can't be blocked or dodged. On the head it's tripled and staggers the monster for 2 s.
  - Severing the limb you're on drops you along with the limb.
  - A spear thrown from the back counts as a thrust at point-blank range.
- **Sim position:** the champion's x and z follow the monster's capsule point, and `alt` is the height of that
  point. The pose carries `mount: { id, cap, u, th }`. The client decides where you are on the body, because it has
  the rig. The sim decides shakes, throw-offs and damage. That's the same split as walking now.

## Part 3: client pieces

- `ChampionController` gets a `mode` field: `walk | air | wall | mantle | mount`. The current code is the walk and
  air modes; each new mode is its own update function, like `fly()`.
- `src/input/climb-surface.ts` (new) answers the ground and wall queries: a ray against the heightfield and the
  feature-triangle hash, the floor under a point, and a smoothed normal.
- `src/render/climb-rig.ts` (new) gives the world transform of a climb volume for a monster view, from either rig
  type.
- **Viewmodel:** two hands that reach and grip on the surface, alternating with movement, with grit particles on
  rock. The weapon is lowered while climbing (swinging from a wall isn't allowed; swinging on a monster is).
- **Audio:** grip scrapes, falling grit, and heavier breathing below 30 stamina.
- **HUD:** the stamina bar flashes while climbing. Shakes get a hold-on prompt the first few times.

## Part 4: the terraformer

- **Climb view:** a new toggle tints faces by how hard they are to climb: green for ledges, yellow for climbable,
  red for overhangs, white for faces taller than one stamina bar without a ledge. You'd use it to design the routes
  the island is meant to have.
- **Height scale:** `heightScale` now changes gameplay, not just looks: at 8, terrace faces are often taller than a
  stamina bar. The panel would show the share of cliff area climbable on one bar.
- **Roads:** island generation stays the same. Roads still guarantee every lair can be reached on foot, so climbing
  is always optional. We could cut roads to only the High Place and lairs later, once climbing is proven.

## Build order

Each phase is playable on its own.

1. **Climbing terrain on the heightfield:** controller modes, wall, mantle, ledges, stamina, falls and fall damage.
   On the sim side: `alt`/`climb` in the pose, cliff tiles accepted, 3D reach, besiege.
2. **Feature mesh climbing:** the triangle hash, standing on spires and arches, and climbing overhangs.
3. **Monster mounting:** climb volumes for the nephil first (the only GLB model, and the biggest monster), getting on,
   moving on the body, the camera.
4. **Monsters fighting back:** shakes and holding on, per-archetype moves, attacks while on a monster, flyers carrying
   you to floating isles.
5. **The rest of the monsters, Se'ir climbing, the nephil's rocks, lookouts, the terraformer climb view, viewmodel
   hands and audio.**

## Risks

- **Two surfaces that disagree.** The heightfield samples every 4 m, while the feature mesh has 16 m cells with
  jitter. They overlap at the foot of spires, so a climber crossing from one to the other may jump by up to a meter.
  Fixes: blend the two normals across 2 m, and snap the hands to the nearer surface.
- **The sim is still 2D for everyone else.** Monsters path toward the tile under a climber, villagers don't know
  about height, and vision ignores cliffs (a gap already in the README). Besiege covers the common case; anything
  more needs 3D in pathfinding, which this design doesn't do.
- **Motion sickness on monsters.** The 30% pitch/roll inheritance needs tuning by playing, and probably an option in
  the settings menu.
- **Clipping into animated bodies.** Capsules are rough approximations of the meshes, especially on the GLB nephil,
  so hands will sink in or float at times. That's acceptable at first person's close range if the camera stays
  0.4 m off the surface.
- **Exploits.** A high place is a refuge. Besiege timing, flyers and Se'ir keep it from being a perfect one, but
  balance needs playtesting.
- **God modules.** The creation API can't see climbing. We could later add `api.champion.alt` and a climbing flag to
  `api.world`, so creations like "vines that make walls cheap to climb" are possible.

## Defaults chosen (change any of these)

- You can climb anywhere steep: no special surfaces, and no unclimbable rock yet.
- Space grabs, C lets go, right mouse holds on while you're on a monster. No new keys.
- Falls of 18 m or more kill.
- Se'ir is the only monster that climbs.
- Floating isles can be reached only by riding a flyer.
