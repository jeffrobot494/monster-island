# Island Humans and Monsters — MVP Tech Spec

Source design: [`design-doc.md`](design-doc.md) (Oct 9, 2026). This spec turns it into something buildable on the
tech of the `monster-island` prototype. Where the design is silent, this spec picks the **simplest thing that
plays**. Those choices are tagged **[gap]** so a designer can find and replace them later.

---

## 0. Summary of the big decisions

| Topic | Decision |
|---|---|
| Codebase | New repo `~/humans-and-monsters`, seeded from `~/monster-island`. Keep: Vite + TS + three.js, the deterministic sim in a Web Worker, the hardened module runtime, the AST checker, the validator, the god pipeline, the `claude -p` dev middleware, and the save store. Rewrite: island generation, the core sim, the renderer's camera and input, the UI, the prompts. |
| The nightly creation | Built with the prototype's main idea: **the winning god writes a JavaScript gameplay module** that the host validates and then installs for good. One Judgment produces one module. |
| Time | One **game clock** (`clockMs`, local wall time). At `timescale=1` it is the real local clock. The **sim tick** is always 100 ms of real time; each tick moves the clock forward `100 × timescale` ms. Physical things (walking, attacks, the 30–90 s roar response) are measured in ticks. Schedules (shifts, monster hours, Judgment, "2 days") are measured on the clock. |
| Away time | Short gaps (≤ 3 real minutes) are caught up tick by tick. Longer gaps use an **abstract hourly resolver** (§9) instead of the tick sim. Modules do not run during the resolver **[gap]**. |
| Combat **[gap]** | Tap a monster to attack-move. The champion auto-swings when in reach. Monster attacks have a **0.8 s wind-up telegraph** (a red ground ring). Tap away during the wind-up to dodge. Hit zones, crippling, severing, and a **downed** state at ≤ 20 % HP make it possible to capture monsters alive. |
| Capture | Tap a downed monster to bind it, then drag it home (slowly; nearby villagers help). Offer it at the village altar. |
| Monster generation **[gap]** | Procedural: 8 hand-authored archetypes from scripture and legend, with 6 picked per island, stats rolled, and generated names, hours, and neighbor graph. No AI. |
| Fog of war | Tiles are revealed around the champion. Lairs stay hidden until the champion comes within 5 tiles. Monsters render only while some human can see them. |
| Scale | 128 × 128 tiles, **1 tile = 8 m**, so the island is about 1 km across. The champion sprints 1.1 tiles/s, so a full traverse takes about 2 minutes. |
| Platform | Mobile-first web (portrait), tap to move and pinch to zoom. It also runs in a desktop browser (click, wheel). It is served by the Vite dev server, which also hosts the AI middleware. |

---

## 1. Repository and build

```
humans-and-monsters/
  docs/            design-doc.md, tech-spec.md (this file)
  dev/             claude-code-middleware.ts (kept), serve.sh, winshot.sh (kept)
  src/
    main.ts        boot, wiring, input
    protocol.ts    main ⇄ worker messages
    sim-client.ts  worker owner + watchdog (kept)
    platform.ts    provider + store selection (kept)
    sim/           pure TS, no DOM: deterministic simulation
      clock.ts         game clock math
      world.ts         TileGrid, tile defs (SIZE = 128)
      island-gen.ts    regions, terrain, village, lairs, High Place
      monsters-gen.ts  archetypes, rolls, names, neighbor graph
      names.ts         Hebrew-flavored names, bios
      sim.ts           the Sim class: entities, tick, schedules
      village.ts       villager AI, jobs, food, growth
      monster-ai.ts    monster AI
      combat.ts        damage, zones, downed, death types, XP
      champion.ts      player orders, binding, dragging
      favor.ts         altars, offerings, Judgment
      vision.ts        fog of war, sight
      offline.ts       hourly away-time resolver
      serialize.ts     save format
      module-runtime.ts, ast-check.ts, validator.ts, island.ts (adapted)
    workers/       sim.worker.ts, validator.worker.ts, harden.ts (kept)
    god/           pipeline.ts (adapted), prompts.ts (rewritten), schemas.ts, observe.ts, providers/ (kept)
      reference-modules/  war-hounds.js, poison-fog.js (examples, fixtures)
    render/        renderer.ts (camera + follow), terrain.ts (+decor, fog), shapes.ts, particles.ts, sprites.ts, sky.ts, rings.ts
    ui/            hud.ts, panels.ts, style.css
    persist/       save store (kept)
  test/            vitest: sim, combat, judgment, offline, modules, validator
```

Scripts are unchanged: `npm run dev` (Vite with the AI middleware) and `npm test` (vitest). `dev/serve.sh` serves on
:5199 with `--host` so a phone on the LAN can connect.

---

## 2. Time

### 2.1 Clock
- `clockMs`: milliseconds since the Unix epoch **shifted to local time** (`utcMs − tzOffsetMin·60000`). That makes
  hour math plain UTC math: `hour = (clockMs mod 86 400 000) / 3 600 000`.
- `msPerTick = 100 × timescale`. Each `step()` adds `msPerTick` to `clockMs`.
- `timescale`: 1 in normal play. Dev param `?timescale=N` (for example 60 makes a game day last 24 real minutes).
  It is saved with the world.
- The game starts at the current real local time. `day` = 1 + whole local midnights since the island was created.
- At `timescale=1`, the main thread sends the real time every 30 s. If the clock has drifted more than 5 s (from
  dropped ticks), the sim adds the difference to the clock. This does not fire hour or midnight events twice: events
  fire on boundary crossings, which `advanceClock()` checks (§2.3).

### 2.2 Phases
- **Day:** 06:00–18:00. **Night:** 18:00–06:00. Dawn event at 06:00, dusk at 18:00, **Judgment at 00:00**.
- Light level `L(hour)`: 1 between 07 and 17, 0 between 19 and 05, linear in between. The renderer's sky keys use the
  hour. Creations can shift the light with `atmosphere.light` / `atmosphere.darkness` (§11.5).

### 2.3 Boundary events
`advanceClock(ms)` walks forward and, for every boundary crossed in order, fires: `hour` (each whole hour), `dawn`
(06), `dusk` (18), `midnight` (00, which runs Judgment before resets, §8.4). The tick loop calls it with `msPerTick`.
The offline resolver calls it hour by hour.

---

## 3. World

### 3.1 Grid
- `SIZE = 128`, 1 tile = 8 m. Entity `x, z` are floats in tile units (the tile center is n + 0.5). x points east and
  z points south.
- `TileGrid` from the prototype, with `SIZE` changed. Each tile also stores `elev` (extra height for hills) and
  `region` (a Uint8 region index), and core keeps `stock` (a Float32 work-site stock, §5.3).

### 3.2 Tile types (core)

| id | color | height | walkable | cost | used by |
|---|---|---|---|---|---|
| deep-water | #1f4f7a | −0.6 | no | – | sea |
| shallow-water | #3f86b8 | −0.3 | no | – | shore, tidal pools |
| sand | #e3d3a0 | 0.0 | yes | 1.2 | shore (fishermen) |
| grass | #9db35a | 0.2 | yes | 1.0 | pasture (shepherds) |
| scrub | #b6a66a | 0.2 | yes | 1.1 | dry hills, wilderness pasture |
| wheat | #e2c25a | 0.2 | yes | 1.0 | fields (farmers) |
| olive | #7f9a52 | 0.25 | yes | 1.2 | terraces (vinedressers) |
| vineyard | #8d8f3e | 0.25 | yes | 1.2 | terraces (vinedressers) |
| cedar | #2f5a35 | 0.3 | yes | 1.6 | Cedar Heights (woodcutters) |
| rock | #9a9286 | elev ≥ 0.6 | yes | 2.0 | hills, cliffs |
| wadi | #c9a877 | 0.05 | yes | 1.1 | dry riverbeds |
| salt | #ece8dc | 0.02 | yes | 1.3 | salt flats |
| marsh | #6f8a6a | 0.0 | yes | 2.2 | salt marsh |
| ruin-floor | #b8ab92 | 0.2 | yes | 1.0 | Ruins of the Anakim |
| road | #c8b48a | 0.18 | yes | 0.8 | village streets, paths |
| wall | #a8865a | 1.2 | no | – | village wall |
| shrine-floor | #d8ccb0 | elev | yes | 1.0 | High Place summit |

The terrain renderer adds instanced decoration per tile type, chosen by a deterministic tile hash: cedar cones on
`cedar`, round olive trees on `olive`, vine rows on `vineyard`, salt pillars (sparse) on `salt`, fallen blocks on
`ruin-floor`, reeds on `marsh`, boulders on `rock` and `scrub`. Decoration is visual only.

### 3.3 Regions and layout (island-gen)
The island mask is a radial falloff plus value noise (prototype code), radius about 58 tiles, centered at (64, 64).
The edge ring is always deep water.

Seven regions. Region **seeds** are placed on a ring (angles are listed for the default layout and jittered ±15° per
seed); each land tile joins the region of its nearest seed (Voronoi):

| # | Region | Seed position | Terrain fill | Lair | Lair look |
|---|---|---|---|---|---|
| 0 | Village and harbor | SW, r = 38 | grass, wheat ring, sand shore, road; walls | none | — |
| 1 | Cedar Heights | N, r = 34 | cedar 70 %, rock hills (elev 0.6–2.2), grass clearings | cave beneath a giant cedar | giant cedar + dark cave mouth |
| 2 | Olive Terraces | SE, r = 32 | olive / vineyard bands, scrub, a wine press | abandoned wine-press cave | stone press + cave mouth |
| 3 | Salt Flats | E, r = 40 | salt, marsh, tidal pools (shallow water), sand | sunken cistern | round stone ring, dark water |
| 4 | Wilderness of Stones | NE, r = 36 | scrub, wadi channels, rock cliffs | cliff tomb | rock face with a square door |
| 5 | Ruins of the Anakim | W/NW, r = 36 | ruin-floor, scattered wall stubs (rock), grass | ruined giant's hall | giant broken columns |
| 6 | The High Place | center, r = 0, radius 9 | rock hill (elev to 2.5), shrine-floor summit, sacred grove (olive) | catacomb under the shrine | stair down beside the altar |

- **Village** (region 0): a walled oval (radius about 9 tiles) on the SW coast, with 2 gates (one facing the island
  center, one facing the harbor), 10 houses, the **village altar** in the square, a **sheepfold**, a granary (a
  visual for the food store), and road tiles. Wheat fields form a ring 2–5 tiles outside the wall. A harbor is a
  sand strip and a pier (road tiles into the water).
- **High Place** (region 6): the summit holds the **monster altar** (a stone table with horns). Roads are not
  required.
- **Paths:** a road from the village gate to the High Place foot (A* over terrain with cost bias, stamped as `road`).
- **Lairs:** one per region 1–6, on a walkable tile at 55–80 % of the way from the island center toward the region
  seed (the High Place lair sits 3 tiles from its altar). Make sure every lair, the village gate, and both altars
  can reach each other (flood fill; unreachable land becomes shallow water, as in the prototype).
- **Wild animals:** 8 wild goats (Wilderness, Cedar Heights) and 3 wild oxen (Olive Terraces, Ruins). They wander
  slowly within their region (core `animal` behavior).

`layout` (saved) records: region seeds and names, village center, gates, house positions, altar positions, fold,
granary, lair positions, guard posts (2 per gate), and the job-site tile lists.

---

## 4. Entities

All entities live in `sim.ents: Map<number, Entity>`, as in the prototype, with these fields added or changed:

```ts
type Faction = 'human' | 'monster';
type Kind = 'human' | 'monster' | 'animal' | 'corpse' | 'part' | 'blood' | 'structure' | string /* module kinds */;
type Zone = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'sig';
type DmgType = 'slash' | 'pierce' | 'crush' | 'bite' | 'fire';

interface Entity {
  id; kind; faction?; name?; x; z; yaw; shape; tint; scale; owner; tags; tagOwners; data; mods;
  inhabitant: boolean;            // true for humans and monsters (the two factions' members)
  hp: number; base: { speed, maxHp, strength, sight };
  zones?: Partial<Record<Zone, { hp: number; max: number; state: 'ok' | 'crippled' | 'severed' }>>;
  level: number; xp: number;
  state: string;                  // core AI state (see 5.4, 6.4, 7.2)
  stateUntil: number;             // tick
  target: number;                 // entity id or -1
  path, want, idleUntil;          // from the prototype
  // visuals packed per frame
  lift: number;                   // y offset (impaled victims, carried captives)
  roll: number;                   // 0 standing … 1 lying on the side (corpses, downed)
  squash: number;                 // y scale 0.1–1 (crushed corpses)
  hidden: boolean;                // inside a house, or not rendered
  // human
  job?: Job; shift?: 'day' | 'night'; homeId?: number; bio?: string; siteTile?: number;
  // monster
  monster?: MonsterInfo;          // §6
  // carrying
  carrying?: number; carriedBy?: number;
  // corpse / part
  corpse?: { species: string; name?: string; maxHp: number; diedClock: number; deathType: string; faction?: Faction; bones: boolean };
  // burning
  burnUntil?: number;
}
```

Stats are `speed` (tiles/s), `maxHp`, `strength` (damage multiplier, 1 = normal), and `sight` (vision multiplier, 1 =
normal). Effective value = `base × Π mul + Σ add`, as in the prototype. `maxHp` base comes from the level (§10).

Structures (houses, altars, fold, granary, lair markers, gates) are `kind:'structure'` entities with a `tags` role
(`house`, `village-altar`, `high-altar`, `fold`, `granary`, `lair:<region>`).

---

## 5. Village sim

### 5.1 Start
- 20 villagers, population cap 40. Jobs: 4 shepherds, 3 vinedressers, 3 woodcutters, 3 fishermen, 4 farmers,
  3 guards. One extra person is the **champion** (so the total is 21) **[gap: the design says 20 villagers and
  separately "the champion"; the champion counts as a villager for win/loss]**.
- Night shift **[gap]:** 2 shepherds, 1 fisherman, and 1 guard have `shift:'night'` (18–06); everyone else is
  `day` (06–18).
- Levels: villagers start at level 1, guards at 2, and the champion at **3** (100 HP) **[gap]**.
- Names: Hebrew-flavored given name + "son/daughter of" + father's name (for example "Elah son of Gera"). The bio
  is one generated sentence built from templates: trait + family tie + small detail ("Sings to his flock at dusk.
  His daughter Noa tends the fold.").
- The **elder** is the oldest-named villager flag (`tags:['elder']`). It only matters for text.

### 5.2 Food
- `food` store: capacity 500, starts at 300.
- Production: per **game hour** a worker spends at a work site doing work: farmer 1.5, fisherman 1.5, shepherd 1.0,
  vinedresser 1.0, woodcutter 0 (+1 timber, flavor only), guard 0. It accrues continuously, prorated by
  `msPerTick`.
- Consumption: 10 per villager per game day, deducted continuously.
- If food reaches 0, every villager loses 1 HP per game hour until food is above 0 again.
- **Growth:** at each midnight with an even `day` number, if `food > 250` and pop < 40, one newcomer arrives at the
  village gate ("A wanderer, X, joins the village"). The newcomer is level 1, gets a random job weighted toward the
  least-filled job, and gets a house with a free spot **[gap: "one new villager every 2 days"]**.

### 5.3 Work sites and drift
- Each job has a site tile type (and sometimes a region): shepherd → grass/scrub outside the walls; vinedresser →
  olive/vineyard; woodcutter → cedar; fisherman → sand next to water; farmer → wheat; guard → its guard post (fixed).
- `stock[tile]` is in 0..1 and starts at 1. One worked game hour lowers the worked tile's stock by 0.34. Stock grows
  back by 0.2 per midnight.
- When a worker needs a site, it picks the tile with `stock ≥ 0.34` that minimizes `pathDistanceEstimate`
  (straight-line distance × terrain factor), among at most 200 sampled candidates. Sites near the village run out
  first, so workers drift outward toward lairs. This is the design's pressure mechanism.
- At most 2 workers share a tile.

### 5.4 Villager AI (core FSM, evaluated each tick; pathing reuses the prototype's A* with a repath budget)

| State | Enters when | Does |
|---|---|---|
| `sleep` | off-shift and at home | hidden in the house; heals 5 HP per game hour |
| `commute` | on shift, not at the site | paths to the site tile |
| `work` | at the site, on shift | stays within 1.5 tiles of the site, produces food, wanders a little; guards face outward |
| `go-home` | off-shift, or shofar sounded | paths home, then `sleep` (or `hide` when an alarm is active) |
| `hide` | home during an alarm | hidden indoors until the alarm clears |
| `flee` | a visible monster within 6 tiles (non-guards) | runs toward the village gate, then home; `speed × 1.25` |
| `fight` | guard, monster within 8 tiles of its post or attacking a villager within 8 tiles | attack-moves (spear: pierce, 6 dmg, cooldown 12 ticks, reach 1.4) |
| `help-drag` | the champion is dragging a monster within 8 tiles and the villager is not fleeing | walks next to the champion; counts as a helper (§7.4) |
| `downed` | HP ≤ 20 % maxHp | lies on the ground (`roll = 1`), cannot act; after 600 ticks gets up at 25 % HP (if not captured) |
| `captive` | grabbed | carried (`lift`), screams |
| — | HP ≤ 0 | death (§7.6) |

Priority order: captive > downed > flee > fight > help-drag > go-home/hide > commute/work > sleep.
**Module behaviors** (§11.4) are checked before the core FSM. A module behavior scoring above 50 takes the entity
for that tick.

### 5.5 Alarm (shofar)
A guard that sees a monster within 14 tiles of the village center **sounds the shofar**: a UI banner and a horn
sound (WebAudio, synthesized) play, `alarmUntil = tick + 3000`, and every villager within 35 tiles of the village
switches to `go-home`/`hide`. Cooldown is 3000 ticks. Guards keep fighting.

---

## 6. Monsters

### 6.1 Archetypes **[gap: the "monster generation system"]**

| id | Display | Base HP | Scale | Speed | Damage | Type | Reach | Signature limb (zone `sig`) | Hours bias | Region affinity | Special |
|---|---|---|---|---|---|---|---|---|---|---|---|
| nephil | Nephil (giant) | 320 | 2.2 | 0.85 | 22 | crush | 1.9 | club arm | day | Ruins, Cedar | grabs tear victims in two |
| saraph | Fiery flying serpent | 170 | 1.3 | 1.35 | 11 | fire | 1.4 | wings | dusk-dawn | Wilderness, High Place | flies: crosses water and cliffs; burn DoT |
| seir | Se'ir, goat-demon | 210 | 1.5 | 1.2 | 14 | pierce | 1.5 | horns | dusk-dawn | Wilderness, Cedar | charge (×1.5 dmg after running 5+ tiles) |
| lilit | Lilit, night hag | 150 | 1.25 | 1.3 | 13 | slash | 1.4 | talons | night | Ruins, High Place | sees in the dark (sight ×1.5 at night) |
| rahab | Rahab, marsh dragon | 260 | 1.8 | 0.95 | 18 | bite | 1.7 | jaws | night | Salt Flats | swims (shallow water walkable) |
| anak | Anak, tomb ghoul | 280 | 1.9 | 0.95 | 17 | crush | 1.7 | grasping hands | night | Wilderness, Ruins | eats corpses |
| reem | Re'em, wild-ox demon | 240 | 1.7 | 1.2 | 16 | pierce | 1.6 | horns | day | Olive Terraces, Salt Flats | impales |
| tannin | Tannin, serpent | 200 | 1.6 | 1.1 | 15 | bite | 1.6 | coils | restless | any | constricts (crush on grab) |

Generation (seeded): for regions 1–6 in order, pick an unused archetype with the best affinity (ties broken
randomly; if none fits, any unused one). Rolls: HP ×U(0.85, 1.15), damage ×U(0.9, 1.1), and a tint from the
archetype palette. Name: generated from syllables plus an epithet (for example "Gaash the Hill-Breaker"). Hours
pattern: 75 % the archetype bias, 25 % `restless`.

Shapes: one composite shape per archetype (≤ 12 primitives), built so it reads at a glance from above (a giant
humanoid, a winged serpent, horns, an owl-faced hag, a crocodilian, a hunched ghoul, a horned ox, coils).

### 6.2 MonsterInfo
```ts
interface MonsterInfo {
  archetype: string; epithet: string; region: number; lairX: number; lairZ: number;
  hours: 'day' | 'night' | 'dusk-dawn' | 'restless'; restlessWindows: [number, number][]; // rerolled at midnight
  neighbors: number[];            // monster entity ids
  dmg: number; dmgType: DmgType; reach: number; flies: boolean; swims: boolean;
  enragedUntilClock: number;      // 0 if not enraged
  huntsLeft: number;              // reset each midnight
  visit: { atHour: number; to: number } | null;
  lairFound: boolean;             // the player knows the lair
  seenHours: number[];            // whole hours in which the player saw it active (max 24 entries, unique)
  lastSeenClock: number;
}
```

### 6.3 Hours and boldness
- Base active windows: day 07–17, night 19–05, dusk-dawn 04–08 and 16–21, restless 3 random 3-hour windows per day.
- **Boldness** `b = day − 1`. Windows widen by `min(6, b × 0.5)` hours at each edge. Hunts per day
  `= 1 + floor(b / 3)`. Roam radius `= 30 + 4b` tiles from the lair (max 90).
- **Enraged** (2 game days after a neighbor dies): damage ×1.25, always active, hunts target the village (raid).

### 6.4 Monster AI states

| State | Behavior |
|---|---|
| `rest` | inactive hours: stays at the lair (wanders ≤ 2 tiles). The champion's first hit on a resting monster deals ×2 ("caught in its lair"). |
| `hunt` | active with `huntsLeft > 0`: picks a hunting ground = a weighted random visible villager work site within roam radius (weight = 1 + level), or the village gate if enraged. It paths there and looks for prey. |
| `stalk` | prey found (sight 10 tiles; prey = a villager not inside a house, lone = no other human within 4 tiles; score = level × 2 + (lone ? 3 : 0) + (downed ? 5 : 0) − dist/10; the champion is prey only when below 40 % HP): paths to the prey, re-pathing every 10 ticks. |
| `grab` | within reach of the prey: a 10-tick grab. Guards and the champion are fought instead (`fight`). Others become captive (`carrying`). If prey moves out of reach, back to `stalk`. |
| `carry` | paths to the High Place altar at 70 % speed. The captive screams every 50 ticks (§12.3). |
| `sacrifice` | at the altar: 200-tick ritual, then the victim dies (`impaled` or `torn`), the monster faction gains favor = victim maxHp, XP +50, `huntsLeft−−`, then `return`. |
| `fight` | attacked by, or targeting, the champion or a guard: attack loop (§7.2). Drops any captive first. Roars every 100 ticks. |
| `flee` | HP < 30 % (and not downed): drops the captive and runs to the lair at full speed. Heals 10 % maxHp per game hour while at the lair. |
| `respond` | heard a neighbor's roar within 50 tiles and is not busy (rest/hunt/return): runs to the roar position, then fights. |
| `visit` | at `visit.atHour` during active hours: walks to the neighbor's lair, stays 3000 ticks, then returns. |
| `return` | goes back to the lair, then `rest` or `hunt`. |
| `feed` | anak, or a hungry monster that just killed (30 %): eats a human corpse for 200 ticks ("eaten" death visuals). |
| `downed` | HP ≤ 20 %: collapses and cannot act. After **1200 ticks** gets up at 30 % HP and `flee`s, unless bound. |
| `bound` | dragged by the champion (§7.4). |

If no villager is found within 2 game hours of hunting, the monster grabs the nearest wild animal (goat 40, ox 80
favor), carries it, and sacrifices it.

### 6.5 Social graph
- Neighbor graph: start with a random spanning tree over the 6 monsters, then add edges until every monster has 2–3
  neighbors (at most 3).
- At midnight each monster rolls 30 % to schedule a visit to a random neighbor at a random hour inside its next
  active window.
- **Roar:** a monster in `fight` (or downed) roars every 100 ticks. Each neighbor within 50 tiles that is not
  `downed`/`bound`/`carry`/`sacrifice` switches to `respond` (with a 0–20 tick reaction delay). Run speed ×1.3
  while responding, so arrival lands in roughly the design's 30–90 s.
- **Death:** each living neighbor gets `enragedUntilClock = clock + 2 days` and a chronicle line ("Gaash howls for
  his brother.").

---

## 7. Combat and the violent death system **[gap: "its design comes later"]**

### 7.1 Zones
- Humanoids (humans): head 15 %, torso 40 %, armL 12 %, armR 12 %, legL 13 %, legR 13 % of maxHp.
- Monsters: the same plus `sig` 15 %.
- Hit-zone weights: torso 38, head 8, each arm 10, each leg 12, sig 10 (monsters). Pick a zone by weight among the
  zones that are not severed.
- Damage `d` is subtracted from the zone hp **and** from the total `hp` (total hp is the source of truth for
  death).
- Zone hp ≤ 0 → **crippled**. A hit on an already crippled limb with `d ≥ 8 % maxHp` → **severed** (head/torso:
  **destroyed** → instant death).
- Effects: each crippled or severed leg ×0.6 speed (both: ×0.25); each crippled arm ×0.7 damage; crippled `sig`:
  the archetype's special is lost (wings → no flying, jaws/horns → ×0.7 damage); head crippled → ×0.5 sight.
- Severed limb → spawn a `part` entity (a small shape: arm, leg, horn, wing) that flies 1–2 tiles, plus a blood
  burst. It stays where it falls until midnight, then turns into bones; bones are removed after 3 days.

### 7.2 Attacks
- **Champion:** a bronze sword, `slash`, damage `12 × (1 + 0.1 × (level − 1)) × strength × armFactor`, cooldown 7
  ticks, reach 1.3 + target radius (0.25 × target scale). No wind-up. A champion only auto-attacks his **current
  target**, and stops automatically when the target becomes downed.
- **Monster:** wind-up **8 ticks** (the entity flag `TELEGRAPH` makes the renderer draw a red ring of radius
  `reach × scale × 0.6` on the ground). At release it hits if the target is still within `reach × 1.25`; otherwise
  it misses ("whiff" puff). Cooldown 15 ticks. Damage = `dmg × strength × armFactor × (enraged ? 1.25 : 1) ×
  rules.damage multipliers`.
- **Guards:** spear, `pierce`, 6 dmg, cooldown 12, reach 1.4.
- **Burn:** fire damage also sets `burnUntil = tick + 50` (2 dmg every 10 ticks, emitter `fire`).
- Module rule `rules.damage(info)` can multiply any damage (§11.3).

### 7.3 Downed and finishing
- When a hit would leave the target with HP between 0 and 20 % maxHp → it becomes `downed` (only the first time it
  crosses the line, and only if `hp > 0`).
- More hits on a downed target can kill it. The champion never auto-hits a downed target; the player must press
  **Finish** (a contextual button) or tap the downed target **twice** within 400 ms.

### 7.4 Binding and dragging
- Tapping a downed monster within 1.5 tiles **binds** it (instant; it becomes `bound`, `roll = 1`). Tapping one
  farther away walks to it and binds on arrival.
- While dragging: the monster follows 1 tile behind the champion. Champion speed = `base × clamp(0.40 + 0.15 ×
  helpers, 0.40, 0.85)`, where helpers = villagers in `help-drag` within 3 tiles (max 3). The champion cannot attack
  while dragging.
- **Drop** button releases it (it stays bound for 300 ticks, then is downed again and its 1200-tick recovery timer
  continues).
- The same drag works for **corpses** (any corpse: human, monster, or animal).
- Reaching within 2.5 tiles of the village altar while dragging opens the altar panel (§8.2).

### 7.5 Captures and intercepts
- A monster that takes a hit while in `carry` drops the captive (who becomes `flee` toward home, or stays `downed`)
  and switches to `fight` (or `flee` if below 30 %).
- Captives cannot act. If the carrier dies, the captive is freed.

### 7.6 Death types (chosen by the killing blow)

| Death type | Rule | Visual (all built from primitives + particles) |
|---|---|---|
| Dismemberment | slash or ≥ 15 % maxHp hit on a crippled limb (that limb severs, then death) | part entity flies off, blood burst ×2, corpse `roll = 1`; the victim "crawls" 1 tile first (20 ticks) |
| Torn apart | killed during or right after a grab by a monster with scale ≥ 1.8, or a nephil sacrifice | two corpse halves (`corpse-upper`, `corpse-lower`) fly apart, big blood burst |
| Bitten | bite killing blow | corpse with a dark red chunk part, blood burst |
| Burned alive | fire damage kills, or burning when HP hits 0 | runs randomly for 30 ticks with `fire` attached, collapses; corpse tinted #2a2420 with `smoke` for 600 ticks |
| Crushed | crush hit ≥ 20 % maxHp, or crush killing blow | corpse `squash = 0.25`, `roll = 1`, blood pool |
| Impaled | pierce killing blow (and all High Place sacrifices) | victim lifted (`lift` up to 1.2 over 10 ticks), held 20 ticks, thrown 2 tiles, corpse |
| Eaten | monster `feed` on a corpse | corpse scale shrinks from 1 → 0.35 over 200 ticks with blood bursts, leaving `bones` |

- Every death writes a specific chronicle line: "*Elah son of Gera, shepherd, was torn in two by Gaash the
  Hill-Breaker in the Olive Terraces.*"
- Corpses keep `maxHp`, `diedClock`, and the faction. At midnight all corpses become **bones** (sacrifice value 0)
  and are removed 3 midnights later. Blood pools (flat red discs) are removed at midnight (cap 60; the oldest goes
  first).

---

## 8. Favor, sacrifice, Judgment

### 8.1 Favor
`favorToday = { human: 0, monster: 0 }`. Only sacrifices add to it. It resets after Judgment.

| Offering | Value |
|---|---|
| Live creature at an altar | 100 % of its current max HP (level-scaled) |
| Fresh carcass (died since the last midnight) | 50 % of max HP |
| Bones | 0 (the altar refuses) |
| Lamb (from the fold) | 40 (live) |
| Wild goat 40, wild ox 80 (live) | monsters only (wild animals cannot be bound by the champion **[gap]**) |

### 8.2 Village altar (player)
The altar panel opens by tapping the altar when the champion is within 2.5 tiles (otherwise the champion walks
there first), or automatically when arriving with a dragged body. Options:
1. **Offer a lamb** (fold count > 0): +40. Fold count is shown; max 6; +1 each midnight.
2. **Offer what you drag** (a bound monster or a corpse): shows the value. A bound monster dies on the altar
   (burned alive visuals). Human XP to the champion: +50 for a live monster.
3. **Offer a villager** — the forbidden offering. A list of villagers in the village. Confirm twice. +maxHp
   (live). The elder condemns the champion: an importance-3 chronicle line + banner, and every villager emotes 😠.
   **[gap: no other penalty]**
4. **Pray**: a free-text box (≤ 200 chars). Saved as `prayer` for tonight's Judgment (the latest prayer
   replaces an earlier one). Shown back as "Your prayer rises: …".

Each offering plays the burn visuals (`fire` + `smoke` + a light pillar emitter) and a floating "+N favor" emote.

### 8.3 High Place (monsters)
§6.4 `sacrifice`. The monster faction's prayer is written by the monster god itself during Judgment (§11.6).

### 8.4 Judgment (at the 00:00 boundary)
1. `h = favorToday.human`, `m = favorToday.monster`. If `h === m` → "Both gods rest." (chronicle + banner).
2. Otherwise winner `w`, total `f = max(h, m)`. Scale = 1 (< 100), 2 (100–299), 3 (300–599), 4 (600–999), 5
   (≥ 1000).
3. Allowed domains for `w` = all domains except those `w` used in the last 3 nights (night index n−1..n−3).
   Domains: `creatures, weather, sky, land, plants, bodies, laws`, plus `fundamental` only when scale ≥ 4. If every
   domain is blocked (it can't happen with 7 domains and a 3-night window), allow all.
4. Push a **creation request** `{ night: n, day, god: w, favor: f, scale, allowedDomains, prayer: w === 'human' ?
   prayer : null, favorBoth: {h, m} }` onto `pendingCreations` (saved in the world). Cap 3: older requests beyond
   the cap become "rested" with a chronicle line.
5. Reset favor to 0 and clear `prayer`.
6. Then the other midnight work: corpses → bones, bones aging, blood pools cleared, fold +1, work-site regrowth,
   villager survival XP (+10 to every living human), growth check, enraged countdown, restless windows rerolled,
   visits rolled, `huntsLeft` reset, and the `midnight` hook for modules.

The god pipeline (main thread) consumes `pendingCreations` (§11.6). The domain the god returns is recorded in
`domainHistory[w]` when the creation installs. If the creation fails, nothing is recorded and the night counts as
rested.

---

## 9. Away time and catch-up

`lastRealMs` is saved with the world on every save. On boot and whenever the page becomes visible again, the main
thread sends `catchUp { realNowMs, tzOffsetMin }`:

1. `gapReal = realNow − lastRealMs` (clamped ≥ 0). `gapClock = gapReal × timescale`.
2. If `gapReal ≤ 180 000` → run `gapReal / 100` ticks synchronously (capped at 1800), then continue.
3. Else → **offline resolver**: the champion is treated as "at the village defending". Step hour by hour (the last
   step is partial):
   - Snap state: captives in flight die at the High Place (counting for the monsters); downed creatures recover;
     dragging is dropped.
   - For each living monster active in that hour: `pHunt = huntsPerDay / activeHoursToday`. On a hunt: pick a
     victim among humans on shift outside the walls in that hour (weighted by level + 1); if there is none, an
     animal. Success chance 0.5 (0.3 if the victim's site is within 12 tiles of the village because the champion
     defends; enraged raids 0.35, and the champion wounds the raider for 25 % maxHp). On success: the victim is
     removed, monster favor += victim maxHp, monster XP +75, and the chronicle gets "*While you were away, X was
     dragged to the High Place by Y.*" On failure there is a 30 % chance the defender (guard or champion) wounds the
     monster 15 % maxHp.
   - Food production and consumption for the hour by shift.
   - Clock boundaries fire via `advanceClock`: **Judgment runs normally** (creation requests are queued for when
     the page is open), along with growth, XP, and so on.
   - The champion can't die offline; he heals to full. Wounded monsters heal 10 %/h at the lair.
   - Stop early if either faction is wiped out.
4. Afterwards, re-place entities: humans at home (off-shift) or at a fresh site (on shift); monsters at their lair
   (inactive) or in `hunt` (active); clear paths.
5. The UI shows a **"While you were away"** panel: hours away, the deaths list, favor tallies, Judgments.

Modules **do not run** during the resolver **[gap]**. Their `onHour`/`midnight` hooks are skipped for resolved hours.

---

## 10. Experience and levels

| | Humans | Monsters |
|---|---|---|
| XP | +1 per point of damage dealt to monsters; +50 for a kill or a live sacrifice of a monster (to the champion); +10 each midnight survived | +1 per damage to humans; +25 capture; +25 kill; +50 sacrifice (+75 offline) |
| XP to the next level | `100 × level` | `150 × level` |
| Max HP | `60 + 20 × (level − 1)` | `archetypeHp × roll × 1.1^(level − 1)` |
| Other | — | scale `× 1.05^(level − 1)` |

On level up, hp rises by the max-HP increase. The change shows as an emote ("⬆") and a chronicle line for the
champion and for monsters the player has seen.

---

## 11. Creations: the god pipeline and the module API

### 11.1 Flow
`pendingCreations[0]` → **Decree** call (sonnet): the winning god names its creation → **Implement** call (opus):
it writes the module → **Validate** (validator worker) → up to 2 repairs → **install immediately** in the live sim →
the Genesis announcement banner plays and the camera flies to the first visible effect, as in the prototype →
recorded in the **Book of Creation**. Requests are processed one at a time. The pipeline runs only while the page is
open; an in-flight job is persisted, as in the prototype.

If the AI is unavailable (no CLI): the manual provider is offered in dev, and otherwise the creation crumbles with a
chronicle line.

### 11.2 Decree (schema)
```json
{ "title": "≤40", "domain": "one of allowedDomains", "announcement": "Genesis voice, ≤280",
  "mechanic": "plain rules: what changes, who it helps and harms, ≤400", "visible": "what the player will see ≤160",
  "priestsPrayer": "monster god only: what the priests cried for, ≤140, else empty" }
```
The host checks that `domain ∈ allowedDomains`. If it isn't, it re-asks once and then rejects the job.

### 11.3 Module format
The prototype's module format, unchanged in structure: `export default { id, title, description, requires, define,
init, hooks, behaviors, rules, tests }`. Changes:
- Hooks: `onTick, onHour, onDawn, onDusk, onMidnight, onSpawn(e), onDeath(e, info), onDamage(target, info),
  onSacrifice(info), onCapture(monster, victim), onArrive(e)`. `info` for a death/damage is `{ amount, type, zone,
  sourceId, sourceKind, deathType? }`. `onSacrifice` info is `{ faction, altar: 'village'|'high', victimKind,
  favor }`.
- `rules.moveCost(kind, tile)` (kept; the kind for monsters is `'monster:' + archetype` *and* the plain
  `'monster'` is checked: the first number returned wins) and **`rules.damage(info) → multiplier`** where `info =
  { amount, type, targetKind, targetFaction, sourceKind, sourceFaction }`.
- `behaviors` (§11.4).
- Tests: `ticks ≤ 6000`, `start: 'dawn' | 'dusk' | 'night'` (night = 23:00).

### 11.4 Module behaviors
The same shape as in the prototype (`appliesTo, score, act`). Applies to inhabitants except the champion and
creatures in `captive`/`downed`/`bound`/`carry`/`sacrifice`. Core baseline = 50: the highest module score > 50 runs
its `act` that tick **instead of** the core FSM. Leaving a module behavior returns the creature to its core FSM,
which re-evaluates its state from scratch.

### 11.5 Host API changes from the prototype
- `api.time` → `{ tick, clockMs, day, hour (float 0–24), isNight, msPerTick, light }`. The prompt must stress that
  clock rates should use `msPerTick` (or `onHour`) and physical durations should use ticks.
- `api.game` (read-only): `{ day, favorToday:{human,monster}, villageCenter, villageAltar, highAltar, championId,
  regions:[{id,name,center}], lairs:[{region,x,z,found,monsterId|null}], food, foodCap, creations:[{title,god,domain,day}] }`.
- `api.world.regionAt(x,z) → region id`, `api.world.regionName(id)`.
- Entity views add: `job, level, xp, state, downed, zones (crippled/severed zone names), carrying, carriedBy,
  archetype (monsters), enraged, corpse (for corpses: species, maxHp, fresh)`.
- `api.ent.damage(e, n, { type?, zone?, sourceId? })` runs through the core combat pipeline (zones, downed,
  death types, XP, hooks). `api.ent.heal(e, n)`.
- `api.ent.kill(e, { type?, deathType? })` (instead of `remove` for inhabitants).
- `api.ent.spawn(...)`: module entities (never inhabitants, never targets for the core AI). Modules move them
  themselves. Module kinds must not collide with core kinds.
- `api.ent.modify(e, stat, {mul, add})` with stats `speed | maxHp | strength | sight`.
- `api.ent.setCoreState(e, 'flee'|'go-home'|'hide'|'rest'|'return')` for simple nudges.
- `api.vis.*` is kept. `atmosphere` gains `darkness (0..1)`, `light (0..1)` (night light), and `weather:
  'none'|'rain'|'fog'|'ash'`. Core light = `clamp(L(hour) × (1 − darkness) + light × (1 − L(hour)), 0, 1)`, which
  feeds sight (§12.1).
- Removed: `api.food.*` (no foraging in this game) and `feed`/hunger.
- Kept caps: 150 spawned entities per module, 8 shapes, 6 emitters, 4 tile types, 300 setTile per day (per game
  day), 30 logs per day, 8 KB state, 30 KB source; 600 island entities.
- **Favor** cannot be written by modules (the design says sacrifice is the only source).

### 11.6 Prompts
- Persona: two gods of a young, unfinished island in an Iron Age Levant. One prompt is shared, and the voice is
  switched by the god (`The Most High`: shelter, plenty, fire, order; `Dagon`: venom, darkness, predators, rot).
- The decree prompt gets: an observation (day, populations, levels, monsters with archetypes and known status, food,
  favor tallies, the last 15 chronicle lines, the Book of Creation, missing fundamental systems), the scale with a
  rubric (§11.7), the allowed domains, the human prayer (the human god must honor the prayer's spirit if it is
  possible and in character), and the creation examples table from the design.
- The implement prompt: the API reference (§11.3–11.5), rules (determinism, no globals, frozen views, caps), the two
  reference modules, and craft notes: bounded and self-balancing; visible on the first night; must not wipe out a
  faction in the soak; scale guides power.
- The **unfinished world** starts missing these systems (fundamental candidates): **Pain, Aging, Desire and birth,
  Cooking and the oven, Hunger, Sleep, Metalworking, Speech among monsters**. (Night and the sea exist from the
  start.) Each installed fundamental creation is removed from the list.

### 11.7 Scale rubric (in the prompt)
1: a small plant/animal/detail, local. 2: a new creature species or a regional effect. 3: an island-wide
weather/terrain/plant system. 4: a body-wide or law-of-nature change, or a fundamental system. 5: remaking the
world (every monster grows wings; the island floods).

### 11.8 Validator changes
- The clone runs with a **validation clock**: `msPerTick = 14 400` (a game day = 6000 ticks), starting at 05:00 on
  the clone's next day. Judgment is disabled in clones (`sim.judgment = false`), so no requests are queued.
- Soak = 6000 ticks (1 game day). Invariants: the candidate throws 0 times; no NaN/out-of-bounds; entities ≤ cap;
  both factions survive (unless `suspends` includes `faction-survival`); state ≤ 8 KB; visible effect; save
  round-trip; tests pass.
- Removed invariants: eat/sleep.

### 11.9 Reference modules (hand-written; prompt examples, dev fixtures, test fixtures)
- `war-hounds.js` (human god, creatures, scale 2): 4 hounds spawn at the village and patrol near villagers. They run
  at visible monsters within 10 tiles and bite (`api.ent.damage(..., {type:'bite'})`). A hound dies after taking
  hits (its own hp in `api.data`). One new hound is whelped every midnight up to 6.
- `poison-fog.js` (monster god, weather, scale 3): at night with 40 % chance per hour, fog rolls in from the salt
  flats (atmosphere fog + `weather:'fog'`). Humans in fog lose 2 HP per game hour; monsters in fog heal 5 per hour.
  Green mist emitters drift over the flats.

---

## 12. Vision, fog of war, and the HUD

### 12.1 Sight
- Champion sight radius: `lerp(7, 16, light) × sight`. Villagers: `lerp(3, 7, light)`. Guards at posts and
  anything inside the walls at night: 10 (torches).
- `explored: Uint8Array(SIZE²)`: tiles within the champion's sight radius are marked explored (updated every 5
  ticks). The village region starts explored.
- A monster is **visible** if it is within the sight radius of the champion or any awake human. Visible monsters
  add their current hour to `seenHours` (when active).
- A lair is **found** when the champion comes within 5 tiles of it (chronicle: "You found the cliff tomb in the
  Wilderness of Stones. Something lives here."). Found lairs are always rendered, and the monster card shows its
  archetype, name (once seen), and seen hours.

### 12.2 What the worker sends
- Entity pack per frame (`ENT_STRIDE = 12`): `id, shapeIdx, x, y, z, yaw, tint, scale, flags, lift, roll, squash`.
  Flags: `1 inhabitant, 2 telegraph, 4 downed, 8 champion, 16 selected/target, 32 bound, 64 burning`.
- Rendered entities: humans, structures on explored tiles (lairs only if found), corpses/parts/blood on explored
  tiles, animals on explored tiles, **monsters only if visible**, and module entities on explored tiles.
- `explored` changes are sent as index lists in the frame. Terrain draws unexplored tiles near-black and flat.
- A HUD block every 5 ticks: `{ clockMs, day, champion: {hp, maxHp, level, xp, state, dragging}, favor, food,
  foodCap, fold, pop, monstersAlive, monstersKnown, alarm, prayer, pendingJudgment }`.

### 12.3 Alerts
- **Scream:** a captive within 19 tiles of the champion → a toast plus an edge-of-screen arrow pointing at the
  carrier until the captive dies or is freed.
- **Missing:** 600 ticks after a capture outside the 19-tile range → a toast: "*Elah did not come back from the
  pasture.*" (no arrow).
- **Shofar:** a banner plus the horn sound.
- **Judgment:** at midnight a full-width banner shows the tallies and the result ("Dagon prevails, 240 to 40 — the
  god of the beasts is shaping the world…"). When the creation installs: the Genesis announcement card + "And it
  was so."

---

## 13. Input and camera

- The camera is perspective, polar angle 25° from vertical, distance 20–70 (pinch or wheel), with a smoothed follow
  of the champion. The **Map** button toggles a zoomed-out overview (distance 150, centered on the island). Tapping
  in map mode exits it.
- Pointer: a pointer-down/up with movement < 10 px and duration < 500 ms is a **tap**, and a hold ≥ 500 ms is a
  **long-press** (inspect). Two pointers mean pinch zoom. Drag-to-pan is **not** supported (the camera always
  follows) **[gap]**.
- Tap resolution: raycast entities first (with a generous radius of 0.8 tiles projected on the ground plane), then
  the ground:
  - monster (not downed) → attack target; downed monster → bind; bound/corpse → pick up and drag; village altar →
    altar panel; human → inspect card; lair structure → lair card; ground → move (if walkable; otherwise the nearest
    walkable tile within 3 tiles).
- The champion's order types are `move(x,z)`, `attack(id)`, `bind(id)`, `drag(id)`, `altar`. Each is sent to the
  worker as `{type:'order', ...}`. Orders are ignored while the champion is `downed` or dead.

---

## 14. UI (DOM overlay, mobile-first)

- **Top bar:** day + local time (☀/☾ icon), favor "Most High N · Dagon M", 👥 villagers, monster skulls (alive of 6,
  ✓ for slain), and a food bar.
- **Bottom-left:** champion portrait, HP bar, level + XP bar, and a state line ("Dragging Gaash — 2 helpers").
- **Bottom-right contextual buttons:** `Finish`, `Drop`, `Altar`, `Map`, `☰` (menu).
- **Menu panels** (sheet from the bottom): **Village** (villager list with job selects, level, HP, bio on tap; job
  changes take effect at the next shift start), **Monsters** (cards for found/seen monsters: name, archetype, level
  if seen, region, seen hours, status), **Book of Creation**, **Chronicle**, **God** (pipeline activity log,
  dev-useful; kept from the prototype), **Settings** (new island).
- **Altar panel** (§8.2), **While you were away** panel (§9), **Judgment banner** + **Genesis card**, **Game over**
  screen (who won, days, kills, creations; **New island** button).
- **Champion death:** "X has fallen. A new champion will be chosen at dawn." The camera is free over the village
  until 06:00; then a random living human becomes champion (keeping their level and job reset to champion), with a
  banner. If no human is left, the monsters win.

Visual direction: warm parchment and bronze panels, serif titles (Google Fonts "Cinzel" for headings with a system
serif fallback; offline-safe fallback required), and dark translucent backgrounds so the map shows through.

---

## 15. Save format

LocalStorage keys per slot (the prototype's `LocalSaveStore`): `world` (core + modules + manifest), `chronicle`
(last 200), `pending` (god pipeline state), `mod:<id>` (sources).

`SavedCore` adds: `clockMs, msPerTick, timescale, lastRealMs, createdClock, explored (RLE), stock (quantized
0–255 RLE), region (RLE), favorToday, prayer, fold, food, alarmUntil, pendingCreations, domainHistory, nightIndex,
championId, championPendingDawn, gameOver: null | {winner, day}, stats {kills, sacrifices, deaths}`.
The schema version is bumped to `2`; old saves are rejected (new island).

---

## 16. Win and loss

- Checked after every death and after the offline resolver.
- **Humans win:** every monster is dead (a live sacrifice counts as dead).
- **Monsters win:** no living humans (the champion included).
- Game over freezes the sim. The game-over screen offers **New island** (wipes the slot and uses a new seed).

---

## 17. Dev and test hooks

URL params: `?slot=`, `?fresh=1`, `?seed=`, `?timescale=N`, `?ai=manual`, `?nogod=1`, `?debug=1`, `?shot=ms`,
`?reveal=1` (no fog), `?god=1` (an invincible champion), `?at=HH:MM` (start the clock of a new island at that local
time), `?devinstall=war-hounds|poison-fog`, `?judge=human:300` (dev: force favor and run Judgment now),
`?skip=N` (ticks at boot), `?cam=x,z,dist`.
`window.__hm` exposes the sim client, pipeline, and renderer.

Vitest suites:
1. **Generation:** 20 seeds; all regions present; 6 lairs reachable from the gate and both altars; 6 distinct
   monsters; neighbor degrees 2–3 and connected.
2. **Determinism:** two sims with the same seed and the same orders produce the same state hash after 5000 ticks.
3. **Combat:** zone damage, crippling, severing, downed thresholds, finishing, death-type selection, XP and level up.
4. **Monster loop:** at timescale 144 with no champion orders, within 2 game days at least one villager is captured
   and sacrificed at the High Place and monster favor > 0.
5. **Judgment:** tallies, ties, scale thresholds, the variety rule, the request queue cap, resets.
6. **Offline resolver:** 24 h away → deaths happen, food changes, one Judgment is queued, deterministic.
7. **Modules:** the reference modules pass the validator; broken modules are rejected (kept from the prototype,
   adapted).
8. **Capture loop:** a scripted champion downs a monster, binds it, drags it to the altar, offers it → favor =
   maxHp and the monster is dead.

Headless visual checks with `dev/winshot.sh` (Windows Chrome) at a phone viewport (`--window-size=430,932`).

---

## 18. Build milestones

1. Scaffold + world: SIZE 128, regions, terrain + decor + fog, structures, follow camera, tap-to-move champion.
2. Village: villagers, jobs, sites/drift, food, clock-based shifts, sleep, alarm.
3. Monsters: generation, shapes, lairs, AI states, roar/visit/enrage, discovery and sight.
4. Combat and death: zones, telegraphs, downed, binding, dragging, death visuals, corpses, XP.
5. Favor: altars, offerings, prayer, Judgment, HUD and banners.
6. Creations: module API adaptation, validator clock, prompts, decree/implement pipeline, reference modules, Book.
7. Away time: catch-up, the offline resolver, the away panel; champion succession; win/loss; game over.
8. Tests, balance passes with headless runs, mobile polish.

---

## 19. Revisions after the adversarial review (these OVERRIDE earlier sections)

A fresh-context reviewer attacked v1 of this spec and returned 38 findings. Each accepted fix is listed below with its finding number.

**Clock and away time**
- R1 (#3, #30): the catch-up gap is measured from the sim's own clock: `gapClock = (realNow − tzOffset) − clockMs`. If `gapClock ≤ 60 s × timescale`, it is caught up tick by tick (≤ 600 ticks). Longer gaps go to the resolver. The worker pauses while the page is hidden. The game autosaves every 30 s and on `visibilitychange: hidden`/`pagehide`.
- R2 (#4): `clockMs` never moves backwards; a negative drift holds the clock. Judgment fires at most once per calendar day (`lastJudgedCalDay`).
- R3 (#36): `day` = calendar days since creation + 1. If the island was created at or after 12:00, the first midnight does not advance `day` (it still runs Judgment).
- R4 (#2): the resolver fires the module hooks `onHour/onDawn/onDusk/onMidnight`, plus `onDeath`/`onSacrifice`/`onCapture` for resolved events. Only `onTick` and behaviors are skipped.
- R5 (#14): on resolve, tick timers are rebased. Burning, alarms, downed and bound timers, and visits are cleared; downed creatures recover; module `schedule` entries are dropped. A **bound monster stays bound**: if the gap is ≥ 30 min it is placed beside the village altar ("the villagers kept it chained"). Offline wounds never take a monster below 30 % HP. The champion only snaps home (and heals fully) if the gap is ≥ 30 real minutes; otherwise he keeps his position and HP.

**Monsters and pacing**
- R6 (#1, #7): at midnight (and at creation) each monster pre-rolls `huntAt: clockMs[]`, uniform inside its active windows. Count = `1 + floor(b/4)`, with b = day − 1; enraged monsters get +1. The live sim starts a hunt when the clock passes an entry. The resolver consumes the same list, so a monster can't hunt twice for one entry. Between hunts in active hours a monster **prowls** (roams within 12 tiles of its lair). A hunt that is still running when its window ends finishes; no new hunt starts outside a window.
- R7 (#7): offline hunt success is 0.35, or 0.2 when the victim's site is within 12 tiles of the village. Offline victims must work within the monster's roam radius.
- R8 (#15): night monsters are also active whenever `light < 0.3`, and day monsters only while `light > 0.4` (so eclipses and a second moon matter).
- R9 (#11): monsters fighting the champion never flee. They flee at < 30 % HP only from guards. Wounded monsters (< 30 %) move ×0.8. A monster can be downed again after any recovery.
- R10 (#12): a downed champion is a valid grab target. His sacrifice kills him (succession as usual).
- R11 (#22): a carrier that sees the champion within 12 tiles of the High Place altar abandons the ritual and eats the captive on the spot (`eaten`, no favor).
- R12 (#24): one wild animal respawns per midnight in each of regions 1, 2, 4 and 5 (cap 14 total). A hunt that has found nothing after 2 game hours makes the monster `return`. A `carry` whose path fails drops the captive and eats it. Newcomers fill empty night-shift slots first.
- R13 (#26, #33): monsters pay half the terrain penalty (`cost' = 1 + (cost − 1)/2`). Villager speed is 0.8 tiles/s (fleeing ×1.25). Monster reach and the ring scale by `1.05^(level−1)`. Monster sight is 10 by day and 7 at night (Lilit 10). Fliers cross walls. Hidden villagers inside houses are never grabbed.
- R14 (#32): every state except downed/bound/carry/sacrifice can respond to a roar. On arrival a responder fights the champion if he is within sight; otherwise it returns.

**Combat**
- R15 (#9): the ring radius equals the hit radius, `reach × levelScale × 1.25` (+ target radius). **Dash dodge:** any move order while a monster within 4 tiles is winding up on the champion gives an instant 1.2-tile hop toward the tap that ignores terrain cost (cooldown 20 ticks).
- R16 (#10): the champion regenerates 2 % maxHp/s when no visible monster has been within 15 tiles for 10 s. Nephil base damage is 18.
- R17 (#13): Finish is button-only.
- R18 (#31): the severing threshold is `max(8 % maxHp, 12)`. Head and torso can't be destroyed while the target is above 20 % HP. Dismemberment as a death type uses the same threshold.
- R19 (#37): after 5 minutes without orders, the idle champion walks home and auto-attacks monsters within 10 tiles of the village.

**Win/loss and the champion**
- R20 (#6): monsters win when no non-champion human is alive. Humans win when no monster is alive. The win check runs on every death and every game hour.
- R21 (#25): succession happens at the next dawn **or after 1 real hour, whichever comes first** [gap; flagged for the designer]. The successor is a random free, non-downed, non-captive villager. During the interregnum the camera can be dragged to pan. The resolver gives no champion defense bonus while there is no champion.

**Favor**
- R22 (#21): the forbidden offering (a live villager **or a villager corpse**) also adds the same amount to Dagon's tally that night. The elder condemns the champion as before.
- R23 (#20): `allowedDomains` is computed when the pipeline **starts** a job. It counts installed domains plus the in-flight one, against the request's own night index.

**Village**
- R24 (#23): starvation costs 4 HP per game hour and stops sleep healing. The champion doesn't eat. Farmer output is 2.0.

**Module API and validator**
- R25 (#15): new API calls and rules: `rules.production(job) → multiplier`; `api.village.addFood(n)` (±50 per call, capped per day at 300); `api.village.spawnVillager({ job?, level? })` (respects the cap of 40); `api.ent.setTrait(e, 'flies'|'swims', bool)`; `api.ent.revive(corpse)` (monster or human corpse, not bones; restores the creature at 50 % HP); `api.monster.addHunt(e, clockMs)`; `api.champion.setWeapon({ type, mul })` (mul 0.5–3); `api.ent.setCoreState` also accepts `'hunt'` and `'prowl'`. `api.perHour(x)` returns `x × msPerTick / 3 600 000` (a per-tick share of an hourly rate).
- R26 (#18): `api.ent.remove` and `api.ent.setPos` throw for inhabitants and structures (use `kill`/`damage`).
- R27 (#19): module entities count against a 400 budget; 200 slots stay reserved for core entities.
- R28 (#5, #17): **validator** runs three segments, each from a fresh clone:
  - (A) a 2-game-day soak at the fast clock (msPerTick 14 400, 12 000 ticks), with scripted synthetic events: a human dies, a monster takes 50 damage, a lamb is offered at the village, a goat at the High Place, and a midnight passes;
  - (B) 6000 ticks at the **live rate** (msPerTick 100), starting at 22:00;
  - (C) a 24 h resolver pass.
  - Invariants hold in each segment: no candidate throws; neither faction wiped out; no NaN; the module-entity budget is respected.
  - After (A), walker reachability is asserted between the inner gate, both altars and every live lair. `api.world.setTile` refuses wall, gate, altar and lair tiles (±1).
  - Tests may set `start` and `ticks ≤ 6000` and run at the fast clock.
- R29 (#16): Sleep is removed from the missing systems. Monster `feed` is only the 30 % roll after a kill.

**Pipeline and platform**
- R30 (#8): the dev middleware runs each `claude -p` call as a **server-side job** keyed by a job id, keeps it running if the page disconnects, and caches the result for 24 h. A reconnecting page polls `/dev-ai/job/:id`. The HUD shows "Dagon is shaping the world…" until the creation installs. PWA/offline boot is **out of scope** [gap: the game needs the dev machine reachable].
- R31 (#27): the install happens immediately, but the Genesis card and camera fly-to wait until no monster has been within 15 tiles of the champion for 10 s. Until then a "✦ A creation is ready" chip is shown.
- R32 (#38): the middleware accepts requests from localhost, or from LAN clients carrying a per-boot token (printed at startup, passed as `?token=` and stored in a cookie). Tools stay disabled for `claude -p`.

**Performance**
- R33 (#28): A* gets a per-tick node budget (24 000 expansions total) instead of a path count; `maxNodes` is 8000 per search; and a failed (start-region, goal-tile) pair is cached for 600 ticks.
- R34 (#29): terrain geometry is static. Fog of war is a 128×128 R8 `DataTexture` sampled in the terrain and decoration shaders, updated when explored tiles change.

**Balance testing**
- R35 (#35): `test/balance.test.ts` is a Node headless harness that runs a whole game day at timescale 1 (864 000 ticks) with an AI-free autopilot, and reports deaths, sacrifices and food.

Rejected or deferred: #34 (logging time syncs for replays). Determinism tests use an explicit clock instead.
