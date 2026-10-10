# Monster Island: MVP Technical Spec

*Reduced-scope build plan · October 9, 2026 · Supersedes the scope (not the vision) of `monster-island-technical-brief.md`*

## 1. What this MVP is

A single-player browser game on Run.world. A small blocky 3D island holds a monster village and a human village. Inhabitants wander, gather food, eat, and sleep. Watching over them is **the god**, an AI that writes new **JavaScript gameplay code** to change how the island works.

Whenever the god is idle, it offers the player three **omens**: proposed changes to the island. The player picks one. The god then writes the code, tests it against a copy of the world, and repairs it if needed. A build may take many in-game days; speed isn't a goal for the MVP. Once it passes, the change goes live at the next dawn, and the camera reveals it the first time it visibly does something. Over a session, the island picks up behavior nobody hand-wrote: swimming, frozen rivers, fishing, feuds, weather, rituals.

The non-negotiable requirement from the brief still holds: **the god writes executable code that adds new behavior**. It does not choose from prebuilt features or tweak numbers. The host provides general infrastructure: movement, pathfinding, rendering primitives, storage, and testing. Everything else comes from the AI.

### In scope

- One island, one player, one god.
- The core simulation: hunger, food, day and night, sleep, and births.
- The god pipeline: observe → propose 3 omens → player picks → implement → validate → repair (×2) → activate at the first dawn after passing → persist.
- **Modules**: AI-written features that plug into a fixed host API.
- A declarative 3D visual kit (shapes, tile types, particle emitters, emotes, atmosphere) that generated code can extend.
- Recovery: watchdog, quarantine, checkpoints, and player-initiated **Unmake**.
- Save and reload through Run `appStorage`.

### Cut (deferred, not rejected)

| Cut | Why it's safe to cut |
|---|---|
| Shared cross-player feature catalog | This is where the security risk and most of the infrastructure live. The module format below is designed so it can be added later. |
| Development while the player is offline | Run has no supported route for it. A partial substitute is in §9. |
| Separate spec and critique agents | Merged into one implement call followed by a repair loop driven by real test failures. That's cheaper and grounded in actual results. |
| Multiple gods, prayers, rival patrons | Single god only. A god "voice" is still there for flavor. |
| Built-in combat | Left out of the core so the god can invent it. |
| Module versioning and upgrades | A module never changes after install. Changing a feature means Unmake plus a new module. |

### Build phases

The goal of **Phase 1** is a working **proof of concept**:

> a living island in 3D → AI-written omens → pick one → AI writes a module → it's validated in a background thread → it goes live and you can see it → it survives a reload.

Speed, robustness against hostile or broken features over long play, and Run deployment are **Phase 2**. Sections 2–9 describe the full design. The table below says what Phase 1 builds from each part, and what it uses instead of the cut items.

| Area | Phase 1 (proof of concept) | Phase 2 |
|---|---|---|
| Platform (§4) | **Local only.** `platform.ts` exists, but only the local implementations are built. | Run SDK, `RunAiProvider`, `RunSaveStore`, deploy and §12 checks |
| AI providers (§8) | `ClaudeCodeProvider` + `ManualProvider` | `FixtureProvider`, `?record=1`, `LocalAnthropicProvider`, `RunAiProvider` |
| Simulation (§3) | All of it (it's small) | — |
| Rendering (§6) | Terrain chunks, shape kit, particles, emotes and speech, day/night, atmosphere. **Plain meshes per entity are fine**; instancing is optional. | Instancing per part, mobile checks |
| Module contract (§5) | `define`/`init`, hooks, behaviors, `moveCost` rules, tests, frozen entity views, attribution (needed for the visibility check and reveal). **Not built:** schedules, `tileData`, `suspend`, and inter-module events (`api.log` stays). | The cut API pieces |
| Lasting changes (§5, §7) | Direct changes, attributed but **not layered**: `setTile`, `modify`, tags, shape/tint/scale overwrite the current value. | Per-module layers |
| Isolation (§4) | AST allowlist check + runtime stubs for `Math.random`, `Date`, `performance.now`, `crypto`, timers, and network APIs | Frozen built-in prototypes, V7 |
| Faults (§7) | try/catch per module call. More than 5 faults in a day → quarantine. | — |
| Hangs (§7) | Watchdog: no frame for 5 s while visible and unpaused → restart from the last save with the **most recently activated** module quarantined | Hang replay to find the real culprit |
| Performance (§7) | Per-module time shown in a dev overlay only | Global budget, auto slow-down |
| Validation (§8) | Static + AST, install, dawn-advanced clone, **single** 2-day soak with **absolute** invariants (no candidate errors, no NaN, caps, someone ate and slept each day unless `suspends`, no faction wiped out unless `suspends`), module tests, visibility, save round-trip | Paired baseline soak with relative invariants |
| Activation (§8) | First dawn after passing; reveal on first visible effect | Manifest-version re-validation |
| Unmake (§7) | **Not built.** A dev-only "disable module" toggle quarantines a module for testing. | Unmake with cascade, layer removal, strand recovery |
| Persistence (§9) | `LocalSaveStore`: one `mi:world` key (world + manifest), `mi:mod:<id>` sources, `mi:chronicle`, `mi:pending`. Saved at dawn, after activation, and every 30 s. | Two-slot atomic commit, size guard, checkpoint key |
| UI (§2) | Omen cards (with pause and ⚠ `suspends` line), shrine status, activation banner + reveal, chronicle list, inhabitant inspector, 1×/2×/pause | Whisper box, Works list with Unmake |

## 2. Player experience

The player is the god's **petitioner**: they decide which change the god makes. They don't play an avatar.

| Moment | What the player sees and does |
|---|---|
The god runs on its own cycle, independent of the 3-minute day. A build takes as long as it takes, and the island keeps living meanwhile.

| Moment | What the player sees and does |
|---|---|
| God is idle | Three omen cards slide up, each with a title, flavor line, and a one-line description of what will visibly change. A ⚠ line appears if the omen suspends a core rule (see `suspends`, §8). **The simulation pauses while the cards are up**, so there is no timer. The player picks one, or picks **"Let the god decide"**. An optional **whisper** box (≤140 chars) passes a suggestion to the next round of proposals. |
| Building (any length; minutes to half an hour is acceptable for the MVP) | The simulation plays out. The **shrine** on the central hill shows the build: its particle column grows through stages, and a status line reads *The god ponders… / shapes… / tests… / is displeased, tries again (2/3) / The work is ready. It will be revealed at dawn.* |
| First dawn after the build passes | The module activates, and a banner announces it (e.g. *"The god has spoken: Rivers freeze at night."*). The **reveal** waits for the module's first visible effect, whenever it happens (dusk, for frozen rivers), then flies the camera there. As soon as the module is live, the god is idle again and new omens appear. |
| Any time | Click an inhabitant to see its name, hunger, HP, current behavior, and any module data. Open the **Chronicle** for a log of events and of the god's works. Use **Unmake** on any installed work. Controls: speed (1×/2×), pause, orbit camera. |

**Hidden tab:** the simulation and the god's pipeline both pause while the tab is hidden. An AI call already in flight finishes, and its result waits.

When a build fails all three attempts, it isn't a crash. It's a story beat: *"The god's attempt at Firefly Swarms crumbled to dust."* The god goes idle and new omens appear.

## 3. Starting simulation parameters

All randomness comes from one seeded PRNG (mulberry32). Each new island gets its seed at creation.

### Time

| Parameter | Value |
|---|---|
| Sim tick rate | 10 ticks/s at 1× |
| Day length | 1,800 ticks (3 real minutes at 1×) |
| Day phase | ticks 0–1,199 (dawn = tick 0) |
| Night phase | ticks 1,200–1,799 (dusk = tick 1,200) |
| Hour | `(6 + floor(tick / 75)) % 24` (dawn = 06:00, dusk = 22:00) |

### Island

| Parameter | Value |
|---|---|
| Grid | 64 × 64 tiles, 1 world unit per tile |
| Shape | Radial falloff + 2-octave value noise, thresholded into tile types |
| Central hill | Rock plateau at the center; the shrine sits on top |
| River | One river from the hill to the south coast, 2 tiles wide, crossed by a **single bridge** |
| Monster village | East of the river: 6 huts in a ring, **capacity 2 each** (6 residents at start) |
| Human village | West of the river: 7 cottages in a grid, **capacity 4 each** (14 residents at start, 2 per cottage) |
| Pond | One 4×4 shallow pond in the western forest |

Tile types (modules may add more):

| Tile | Height | Walkable | Move cost | Color |
|---|---|---|---|---|
| `deep-water` | −0.6 | no | — | `#2b5d8a` |
| `shallow-water` | −0.3 | no | — | `#3f86b8` |
| `sand` | 0.0 | yes | 1.2 | `#e6d39a` |
| `grass` | 0.2 | yes | 1.0 | `#7cba5a` |
| `forest` | 0.25 | yes | 1.5 | `#4d8a3e` |
| `rock` | 0.6–1.5 | yes | 2.0 | `#8c8a84` |
| `bridge` | 0.1 | yes | 1.0 | `#9b6b3f` |

### Inhabitants

| | Monsters | Humans |
|---|---|---|
| Count | 6 | 14 |
| Max HP | 100 | 40 |
| Speed (tiles/s) | 2.2 | 2.6 |
| Strength (unused by the core; available to modules) | 10 | 3 |
| Hunger rate | +1 per 30 ticks | +1 per 30 ticks |
| Scale | 1.4 | 0.9 |

### Needs and food

- **Hunger** runs from 0 to 100 and starts at 20.
- **Starvation:** at hunger 100, HP drops by 1 every 30 ticks.
- **Recovery:** sleeping with hunger below 50 restores 1 HP every 30 ticks.
- **Death:** at HP 0 the inhabitant becomes a gravestone entity that disappears after 3 days. Gravestones don't count toward entity caps or invariants.
- **Food:**
  - 24 **berry bushes** on grass and forest. At least 6 are placed within 8 tiles of each village, on its side of the river; the rest are random. Each bush grows a berry every 300 ticks, holding up to 3. A berry restores 35 hunger.
  - **Mushrooms** spawn at random on forest tiles: 1 every 100 ticks, at most 15 on the island. A mushroom restores 25 hunger.
  - **Reservation:** an inhabitant that picks a food target reserves it, so others ignore it. The reservation lapses after 200 ticks or when the target changes behavior.
  - Supply is roughly 5,500 hunger per day against a demand of 60 per inhabitant, so food is plentiful even at the population caps. Starvation only comes from placement, distance, or modules.
- **Births:** at dawn, a house with a free slot has a 30% chance to add a newborn of its faction if that village's average hunger is below 40.
- **Population caps:** 12 monsters and 28 humans, which is total house capacity.
- **Seed check:** a Vitest sweep over 50 seeds asserts that the bush placement rule holds, every house is reachable from every bush on its side, and both populations survive 10 days.

### Core behaviors

Inhabitants pick a behavior each tick by **utility score**: the highest score wins, with hysteresis (+5 to the current behavior) so they don't flicker. Module scores are clamped to [0, 100], and a non-finite score counts as 0. Ties go to core behaviors. Modules can register more behaviors and suppress core ones (§5).

| Behavior | Score | Action |
|---|---|---|
| `sleep` | 100 at night when at home | Hidden inside the house; 💤 emitter on the house |
| `go-home` | 90 at night | Path to home |
| `seek-food` | `hunger` when hunger > 30 and food within 10 tiles | Path to the nearest food and eat it on arrival |
| `wander` | 10 | Pick a random walkable tile within 6 tiles of home and path to it |

Pathfinding uses A* on the tile grid.

- **Cost table:** the host builds a cost table per (entity kind, tile type) from the base tile costs and every active module's `moveCost` rule (§5). It's rebuilt only when modules or tile types change, never inside A*.
- **Path cache:** paths are cached per entity.
- **Repath queue:** when tiles change, the affected paths are marked stale and requeued. The host runs at most 30 A* searches per tick across all entities; the rest keep moving on their old path until their turn.

## 4. Architecture

```
┌─────────────────────────── Main thread (host) ──────────────────────────┐
│  Renderer (three.js) ◄── snapshots ──┐                                  │
│  UI (omens, shrine, chronicle)       │                                  │
│  GodPipeline ── AI calls (Run SDK)   │       Persistence (appStorage)   │
│  Watchdog ── heartbeats ─────────────┤                                  │
└──────────────────────────────────────┼──────────────────────────────────┘
               postMessage             │                     postMessage
┌──────────────────────────────────────┴───┐   ┌───────────────────────────────┐
│ Sim worker (live world)                  │   │ Validator worker (on demand)  │
│  core sim + active modules (blob import) │   │  core sim + active modules +  │
│  emits snapshots, events, saves          │   │  candidate, headless, fast    │
└──────────────────────────────────────────┘   └───────────────────────────────┘
```

Key decisions:

1. **The core sim is pure TypeScript** with no DOM or three.js dependency. The same code runs in the sim worker, the validator worker, and Vitest under Node. That gives a deterministic headless simulation for both validation and our own tests.
2. **The whole simulation runs in one worker**, with the core and modules together. The main thread renders and never runs generated code. If a module hangs, the host kills the worker and restarts it from a checkpoint (§7).
3. **Generated code loads as an ES module from a blob URL** via `await import(blobUrl)` inside a module worker. Run documents blob URLs for scripts and workers. Fallback if dynamic import of a blob is blocked inside workers: build a classic worker from a blob that joins the sim bundle source (fetched from our own origin) with the module sources.
4. **Generated code can't reach the Run SDK.** The SDK exists only on the main thread, so generated code can't spend credits, write storage, or make network calls. Two more layers sit on top. Together they're defense in depth, not a true sandbox, which is acceptable for code an AI writes for one player's own world. Their main job is to catch the AI's mistakes, especially nondeterminism.
   - **AST check before loading** (acorn, run on the main thread and again in the validator). Source is rejected if it contains:
     - any free identifier outside an allowlist: `Math`, `JSON`, `Object`, `Array`, `Number`, `String`, `Boolean`, `Map`, `Set`, `Infinity`, `NaN`, `undefined`, `isFinite`, `isNaN`, `parseInt`, `parseFloat`;
     - `import`/`export` other than the single `export default`;
     - `async`, `await`, generators, `with`, `eval`, `new Function`, or tagged templates;
     - any `.constructor` or `__proto__` access;
     - computed member access (`a[b]`) on `Math`, `Object`, or `globalThis`-like roots.

     Because it parses the code, words in comments and strings never match, and `Math['ran'+'dom']` doesn't get through.
   - **Runtime hardening in the worker, before any module loads:**
     - `Math.random`, `Date`, `performance.now`, and `crypto` are replaced with stubs that throw. The host keeps private references for its own timing.
     - `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `EventSource`, `indexedDB`, `setTimeout`/`setInterval`, and `queueMicrotask` are deleted.
     - Built-in prototypes are frozen.
     - A hook that returns a thenable is a fault.

### Platforms: Run and local

Everything Run-specific sits behind two interfaces: `AiProvider` (§8) and `SaveStore` (§9). At boot, `src/platform.ts` picks one of two platforms:

| | `run` | `local` |
|---|---|---|
| Selected by | `VITE_PLATFORM=run` (production build default) | `VITE_PLATFORM=local` (`npm run dev:local`) |
| Run SDK | Initialized | Never imported (dynamic `import()` only on the `run` path, so it's absent from local bundles) |
| AI | `RunAiProvider` | `ClaudeCodeProvider` (default, uses your Claude subscription), or `?ai=manual` / `?ai=fixture` / `?ai=api` (`LocalAnthropicProvider`) |
| Saves | `RunSaveStore` | `LocalSaveStore` |

Nothing else in the codebase knows which platform it's on. A HUD badge shows the active platform and AI provider, so a local session can't be mistaken for a Run one.

The local platform runs in a plain browser tab with no iframe and no Run content policy. It **cannot** confirm V1 (blob import inside Run's iframe) or the Run-side limits. Those stay deploy-time checks.

### Messages

| Direction | Message | Contents |
|---|---|---|
| main → sim | `init` | world snapshot, active module sources, seed |
| main → sim | `control` | speed, pause |
| main → sim | `install` / `unmake` | module source + id / module id |
| main → sim | `requestSave` / `resync` | — |
| sim → main | `frame` (every tick) | sequence number, tick, entity render states as transferable typed arrays (id, shape index, x, y, z, yaw, tint, scale), changed tiles, emitter ops, emotes/speech, atmosphere |
| sim → main | `fullState` (on `resync`, load, restart) | every entity, every tile, active emitters, atmosphere |
| sim → main | `defs` (on change) | shape, tile-type, and emitter definitions |
| sim → main | `events` | chronicle-worthy events |
| sim → main | `save` | serialized world |
| sim → main | `moduleFault` | module id, hook, error, stack |
| sim → main | `heartbeat` | the `frame` message counts as one |

**Validation happens at the API boundary in the worker.** Each `api` call checks its arguments (finite numbers, `#rrggbb` colors, known ids, caps) and throws to the calling module on bad input. That's a module fault (§7), and nothing bad ever enters the world. The main thread still schema-checks frames as a backstop. If it drops a frame or sees a gap in sequence numbers, it asks for `resync` instead of rendering from a diff it missed.

The renderer interpolates between the last two frames, so motion stays smooth at 60 fps from a 10 Hz sim.

## 5. The module contract (the key interface)

A module is one ES module source file whose default export is a plain object:

```ts
export default {
  id: 'frozen-rivers-1',          // assigned by the host and given to the model; must match
  title: 'Rivers freeze at night',
  description: 'At dusk shallow water becomes walkable ice; it melts at dawn.',
  requires: [],                   // ids of modules this one reads from
  define(api) { /* tiles, shapes, emitters, food kinds, event listeners */ },
  init(api)   { /* first install only: api.state defaults, initial spawns */ },
  hooks: {                        // all optional, all synchronous
    onTick(api) {}, onDawn(api) {}, onDusk(api) {},
    onSpawn(api, e) {}, onDeath(api, e) {}, onEat(api, e, food) {},
    onArrive(api, e) {},          // entity reached its path goal
  },
  behaviors: [{                   // optional new inhabitant behaviors
    id: 'swim',
    appliesTo: (api, e) => e.kind === 'monster',
    score: (api, e) => number,    // clamped to [0,100]; compared with wander=10 … sleep=100
    act: (api, e) => void,        // called each tick while this behavior is selected
  }],
  rules: {
    // Per (kind, tile type), not per entity, so the host can cache it.
    // undefined / NaN / negative = no opinion; Infinity = blocked; a finite number
    // also makes a normally unwalkable tile walkable for that kind.
    moveCost: (kind, tileType) => number | undefined,
  },
  teardown(api) {},               // optional; host cleanup runs regardless (§7)
  tests: [{                       // 1–3 required
    name: 'ice appears at night',
    start: 'dawn' | 'dusk',       // the clone is advanced to this point first
    ticks: 1500,                  // ≤ 1,800 (one day)
    setup(api) {},                // optional arrangement on the cloned world
    check(api) { return api.world.countTiles('ice') > 0 || 'no ice after dusk'; },
  }],
}
```

**Lifecycle:**

- **`define`** runs on every load: first install, every reload, checkpoint restores, and quarantined modules too. It must be idempotent. `api.events.on` may only be called here, so listeners never pile up.
- **`init`** runs exactly once, at first install, after `define`.
- Hooks, behaviors, and rules run every tick for active (not quarantined) modules. Hooks run in module activation order, after the core sim step.

**Rules combine like this:** for each (kind, tile):

1. Any module returning `Infinity` blocks the tile.
2. Otherwise, the highest finite opinion wins.
3. If no module has an opinion, the base tile cost applies.

### Host API (what generated code can call)

Each module gets its **own** `api` instance. That lets the host credit every action to the module that made it, enforce per-module caps, and undo the module's changes on removal.

**Entities are read-only views.** Modules receive frozen snapshot objects, refreshed each tick. Assigning to one (`e.speed = 1`) throws, because ES modules run in strict mode. That's a fault, and the repair loop teaches the model to use the API instead.

**Every lasting change goes through an attributed call.** Lasting changes are tiles, stats, shapes, tints, scales, and tags. The host stores each one as a **layer** owned by the module that made it, so Unmake can remove that module's layers and leave everyone else's intact (§7).

```ts
api.time      // { tick, day, hour, isNight, ticksPerDay }
api.rand()    // seeded [0,1);  api.randInt(a,b); api.pick(arr); api.chance(p)
api.state     // module-private JSON-serializable object, persisted
api.schedule(ticks, eventType, payload?)   // emits eventType to this module after `ticks`; persisted

// World
api.world.size                         // 64
api.world.tile(x, z)                   // effective tile type id
api.world.setTile(x, z, type)          // layered: top-most module layer wins
api.world.tileData(x, z)               // this module's JSON object for that tile (sparse)
api.world.defineTile(id, { color, height, walkable, moveCost })   // define() only
api.world.countTiles(type); api.world.findTiles(type, limit?)
api.world.nearestTile(x, z, type, maxR)

// Entities: reads
api.ent.all(); api.ent.get(id)
api.ent.query({ kind?, faction?, tag?, near?: { x, z, r }, behavior?, inhabitant? })
api.ent.dist(a, b)
// View fields: id, kind, faction, name, x, z, hp, maxHp, hunger, speed, strength,
// homeId, behavior, tags[], inhabitant (true for monsters/humans)

// Entities: changes
api.ent.spawn({ kind, x, z, shape, tint?, scale?, tags? })   // module entities: never inhabitants
api.ent.remove(e)                      // own entities, or inhabitants (counts as death)
api.ent.goTo(e, x, z)                  // pathfind; no-op if same goal; false if unreachable
api.ent.moveToward(e, x, z)            // straight-line step at e's speed, no pathing (fireflies, fish)
api.ent.setPos(e, x, z)                // teleport; must be a tile walkable for e's kind
api.ent.stop(e)
api.ent.modify(e, stat, { mul?, add? })  // layered; stat: speed | maxHp | strength | hungerRate
api.ent.clearModify(e, stat)           // removes this module's layer only
api.ent.addTag(e, tag); api.ent.removeTag(e, tag)   // layered per module
api.ent.suppress(e, coreBehaviorId, ticks)          // e.g. keep a swimmer from going home
api.ent.damage(e, n); api.ent.heal(e, n); api.ent.feed(e, n)   // one-shot, not undone by Unmake
api.data(e)                // this module's data on entity e (JSON object)
api.dataOf(e, moduleId)    // read another module's data; may be undefined

// Food (lets core seek-food use module entities, e.g. fish)
api.food.register(kind, { restores, eatableBy?: ['monster'|'human'] })   // define() only

// Visuals (declarative; see §6)
api.vis.defineShape(id, shapeDef)      // define() only
api.vis.defineEmitter(id, emitterDef)  // define() only
api.vis.setShape(e, id); api.vis.setTint(e, '#rrggbb'); api.vis.setScale(e, s)   // layered
api.vis.attach(e, emitterId); api.vis.detach(e, emitterId)
api.vis.burst(emitterId, x, y, z)
api.vis.emote(e, '🐟', seconds); api.vis.say(e, 'Brr!', seconds)
api.vis.atmosphere({ skyTint?, fogColor?, fogDensity?, lightTint?, weather?: 'none'|'rain'|'snow' })

// Events
api.events.emit(type, payload); api.events.on(type, fn)   // on() in define() only
api.log(text, importance = 1)    // chronicle; importance 3 = banner
```

Module-spawned entities are **never inhabitants**. They have no hunger, run no core behaviors, and don't count toward faction survival or the population caps. Module behaviors apply only to inhabitants. Module entities move from the module's own hooks via `goTo`/`moveToward`.

Rules stated to the AI and enforced by the host:

- No randomness, time, timers, async code, network, or globals outside the allowlist. The AST check rejects these (§4), and the error message names the rule broken.
- Store state only in `api.state`, `api.data(e)`, and `api.world.tileData`, and keep it JSON-serializable. All three together are capped at **8 KB serialized per module**. Both the save round-trip check and every save enforce this.
- Data from other modules may be missing. Code must handle `undefined`.
- Don't call `goTo` every tick with a moving target. Check `e.behavior` or your own data first. Repaths are budgeted (§3) and will lag.
- **Per-module caps:** 150 spawned entities, 8 shape definitions, 6 emitter definitions, 4 tile types, 3 food kinds, and 300 `setTile` calls per day.
- **Global caps:** 450 entities (gravestones excluded), 32 attached emitters, 2,000 live particles, 40 active modules, 30 KB of source per module.

### Hand-written reference modules

Two modules ship in the prompt as examples and also serve as integration tests of the contract. They are **not installed by default**.

- `fireflies`: at night, spawns glowing entities over forest tiles. They drift with `moveToward`, and inhabitants who see them show ✨. Demonstrates `define`/`init`, spawn, emitters, onDusk/onDawn, and tests that start at dusk.
- `wading`: lets humans path through shallow water at triple cost (`moveCost` returning 3 for `('human', 'shallow-water')`). While a human is in water it shows 💦 and gets `modify(e, 'speed', { mul: 0.5 })`, cleared on leaving. Demonstrates `rules.moveCost`, `behaviors`, `modify`, and `api.data`.

## 6. Visual system

**Look:** chunky low-poly diorama. Flat-shaded `MeshLambertMaterial`, a warm palette, soft fog, an orthographic-feel perspective camera (FOV 30°) on an orbit rig angled about 50° down. Terrain is a grid of short box columns, which keeps the blocky 3D look the brief asked for.

**Terrain:** 8×8 chunks. Each chunk is one merged `BufferGeometry` of tile boxes with vertex colors. When a tile changes, only its chunk is rebuilt. Water tiles get a gentle vertical-wave shader.

**Shapes:** every visible entity, core or generated, is a composite of primitives:

```ts
shapeDef = {
  parts: [
    { prim: 'box' | 'sphere' | 'cylinder' | 'cone',
      size: [x, y, z],           // sphere: [d,d,d]
      pos: [x, y, z], rot?: [x, y, z],   // degrees
      color: '#rrggbb' | 'tint', // 'tint' uses the entity's tint
      emissive?: number,         // 0–1, glows at night
      opacity?: number,          // 0.2–1
      anim?: { type: 'bob' | 'spin' | 'pulse' | 'sway', speed: number, amount: number } }
  ]            // ≤ 12 parts
}
```

Core shapes:

| Shape | Description |
|---|---|
| `monster` | Big body box, tint-colored, with two horn cones and a bob animation |
| `human` | Small cylinder body with a sphere head |
| `hut` | Monster house |
| `cottage` | Human house |
| `berry-bush` | Shows 0–3 berries as red spheres |
| `mushroom` | — |
| `gravestone` | — |
| `shrine` | Sits on the central hill |

**Drawing shapes:**

- **One `InstancedMesh` per (shape, part).** Each part keeps its own material settings: emissive, and opacity, with transparent parts in a sorted transparent pass. `'tint'` parts take the entity's tint through `instanceColor`; fixed-color parts don't.
- **Animation:** part animations (bob, spin, pulse, sway) are computed on the CPU into each instance's matrix every frame. With ≤450 entities × ≤12 parts that's cheap, and it needs no custom shaders.
- **Desktop first.** Mobile is checked (V6) but isn't a build target.

**Particles:** one pooled `Points` system with up to 2,000 particles. Emitter definition:

```ts
emitterDef = { color, color2?, size, rate /*per s*/, life /*s*/, speed, spread /*0–1*/, gravity, glow?: boolean }
```

**Emotes and speech:** emoji or short text on canvas-texture sprites above an entity. Speech is capped at 40 characters, and at most 20 are visible at once.

**Day and night:** sky color, sun direction and color, and ambient intensity follow `api.time`. At night, windows of occupied houses glow (emissive). Modules can tint the atmosphere and set weather. `rain` and `snow` are built-in particle presets.

## 7. Safety, recovery, and removal

| Failure | Detection | Response |
|---|---|---|
| A hook throws (including bad `api` arguments and writes to frozen views) | try/catch around every module call | Record a fault. A module with more than 5 faults in one in-game day is **quarantined** (see below), and the Chronicle notes it. |
| Modules are too slow | The host times each module's whole share of the tick (hooks, plus its behaviors' `score`/`act` batched across all entities), not each call. **Global module budget: 8 ms per tick, p95 over 300 ticks.** | Over budget, the sim drops to 1× and the Chronicle names the most expensive module. No automatic quarantine: the player can Unmake it. |
| Infinite loop | The worker posts `frame` with its own tick count. The main-thread watchdog fires only if the tab is visible, the sim isn't paused, and no frame has arrived for **5 s**. | Terminate the worker. Restart from the dawn checkpoint with all modules **temporarily** suspended (not saved), so the island keeps living. Then **find the culprit by replay** in the validator worker: from the same checkpoint, run to the tick where the live hang happened, enabling modules one at a time in activation order. Each run is capped at 5 s. The sim is deterministic, so the hang reproduces. Quarantine only the module whose addition hangs, persist that, and restart with the rest. If replay finds no culprit, everything resumes and the Chronicle notes a "tremor". |
| Bad frame | Sequence gap or schema failure on the main thread | Drop it and request `resync`. Bad module input is already rejected inside the worker. |
| Corrupt save | Parse or schema failure, or a `mi:head` generation mismatch | Fall back to the other world slot, then to the checkpoint (§9). If all fail, start a new island and keep the chronicle. |

**Quarantine** stops a module's hooks, behaviors, rules, and schedules. Its `define` still runs, so its tile types and shapes stay valid. Its existing entities and layers stay in place, frozen. The Chronicle and the "Works" list mark it, and the player can Unmake it to clear its leftovers.

**Checkpoints:** a full world snapshot, with its own manifest, is taken at every dawn and before every activation. The latest is persisted.

**Unmake** is a player action. It **cascades to dependents**: every module whose `requires` lists the unmade one is unmade first. The host undoes everything it attributed to the module, so removal works even if the module's own code is broken:

1. Call `teardown` inside try/catch.
2. Unregister its hooks, behaviors, rules, listeners, schedules, and food kinds. Rebuild the cost table.
3. Remove the entities it spawned.
4. Remove all its **layers**: tiles, stats, shapes, tints, scales, tags, and suppressions. Each value falls back to the next module's layer underneath, or to the base value. If A froze water to ice and B later turned that ice to lava, unmaking A leaves lava. Unmaking B then reveals A's ice.
5. Detach its emitters, and clear its `api.data`, `tileData`, and `state`.
6. Drop its tile types. Any tile whose effective type no longer exists becomes `grass`.
7. **Strand recovery:** any inhabitant now on a tile unwalkable for its kind is moved to the nearest walkable tile, with a puff of particles. Paths are requeued.

Unmaking does not refund the god's effort. The Chronicle records it, and the god sees it in its next observation ("The petitioner rejected X").

## 8. The god pipeline

### Stages

| # | Stage | Where | Model | Output |
|---|---|---|---|---|
| 1 | Observe | host | — | ~2 KB observation JSON |
| 2 | Propose | Run AI | `standard`, JSON schema | 3 omens |
| 3 | Choose | player | — | 1 omen (+ whisper) |
| 4 | Implement | Run AI | `power`, JSON schema | module source + notes |
| 5 | Validate | validator worker | — | pass, or failure report |
| 6 | Repair (≤2) | Run AI | `power`, JSON schema | revised source |
| 7 | Stage | host | — | candidate held until the next dawn, persisted |
| 8 | Activate | sim worker | — | installed at dawn; reveal on first visible effect |

The god's cycle is independent of the day: **idle → (propose) → choose → build → staged → active at dawn → idle**. Only one job exists at a time. Proposals are generated while the current build is staged, so omens are ready the moment it activates.

Pipeline state lives in `mi:pending` after every stage, so a session that ends mid-build resumes from the last completed stage.

### 1. Observation

The host computes this so the model doesn't have to read raw world state:

- Day number, population per faction, births and deaths in the last 3 days, average hunger, and food on the map.
- **Behavior histogram:** the fraction of inhabitant-time spent in each behavior. Example: *"wander 71%" means the island is boring*.
- Tile-type counts.
- The last 15 chronicle events.
- Installed modules: id, title, description, and each module's `api.state` keys and entity data keys.
- Player history: the last 5 omens picked or ignored, unmade modules, and the latest whisper.

### 2. Propose

The system prompt sets the god's goal: *make the island more entertaining to watch*. Concretely, it should prefer changes that are:

- (a) **visible** within one in-game day,
- (b) **new behavior** rather than tuned numbers,
- (c) **interacting** with what already exists,
- (d) **varied** in tone (cozy, eerie, chaotic, social).

It should not repeat or contradict installed modules unless it means to build on them.

Output schema (each of the three omens):

```json
{ "title": "≤40 chars", "omen": "flavor line ≤100 chars",
  "change": "what will happen, ≤200 chars", "visible": "what the player will see",
  "builds_on": ["module-id"], "tone": "cozy|eerie|chaotic|social|wild",
  "suspends": ["eat" | "sleep" | "faction-survival"] }
```

- **Ids:** the host assigns each module id (`slug(title)-n`, unique across active, quarantined, and unmade modules) and passes it to the implement call. The model never chooses ids.
- **`suspends`** is how an omen declares that it intentionally breaks a core guarantee (e.g. *"Monsters stay up all night howling"* → `["sleep"]`). It's shown on the card as a ⚠ line, so the player approves it explicitly. It's the only way to relax the matching invariant in validation.

### 3. Implement

The prompt is assembled from:

1. A static system prompt (~8K tokens), using Run's prompt caching:
   - the god persona and the rules,
   - the full §5 API reference,
   - the §6 visual definitions,
   - the two reference modules.
2. The observation.
3. The chosen omen and its assigned module id.
4. Full source of any modules in `builds_on` (at most 2). Other installed modules appear only as summaries.

Output schema: `{ "source": string, "notes": string }`.

### 5. Validation

All checks run in a fresh validator worker against a **clone of the live world**. Before any soak or test, the clone is advanced headless to the **next dawn**, so every run starts from a known time of day. **Build speed is not a goal for the MVP**, so the only time limits are hang guards: 60 s per soak or test run, 5 min for the whole validation. Exceeding either counts as a hang.

1. **Static:**
   - Source ≤ 30 KB, and it passes the AST check (§4).
   - Imports successfully. The default export has the assigned `id`, a `title`, `define`, and 1–3 `tests` with `ticks` ≤ 1,800.
   - Everything in `requires` is installed and active.
2. **Install:** run `define` then `init` with no throw. Shape, emitter, tile, and food definitions pass schema checks.
3. **Paired soak:** from the same dawn clone and the same RNG state, simulate 2 in-game days (3,600 ticks) twice: a **baseline** with the current modules only, and a **candidate** run with the new module added. The baseline is cached per checkpoint and reused by repair attempts.
4. **Invariants.** These compare the two runs, so an island that is already struggling doesn't fail every candidate:
   - Zero thrown errors from the candidate.
   - No NaN or out-of-bounds positions; entities stay under the caps.
   - Candidate's share of tick time ≤ 2 ms p95, and total module time stays within the 8 ms budget.
   - **Eat and sleep:** for each of eat and sleep, if the baseline had at least one inhabitant doing it each day, the candidate run must too, unless the omen's `suspends` lists it.
   - **Faction survival:** if a faction survives the baseline, it survives the candidate run, unless `suspends` lists `faction-survival`.
   - **Other modules:** no module that ran fault-free in the baseline faults in the candidate run.
   - **State size:** the candidate's state stays under its 8 KB cap.
5. **Module tests:** each test gets a fresh dawn clone with the candidate installed. The clone is advanced to the test's `start`, then `setup` runs, then `ticks` ticks are simulated, then `check` is called. Anything other than `true` is a failure message.
6. **Visibility:** during the soak, the candidate must have done at least one of the following, credited to it through its `api`:
   - spawned an entity with a shape,
   - changed a tile,
   - emitted or attached particles,
   - set a shape or tint,
   - emoted or spoken,
   - changed the atmosphere,
   - or had one of its behaviors selected by an inhabitant.

   If none happened, the result is *"invisible change"*.
7. **Save round-trip:** serialize, then deserialize, which re-runs `define` but **not** `init`. Simulate 100 more ticks with no errors, and confirm that the module's `state`, `data`, `tileData`, layers, and schedules survive.

The failure report sent back for repair contains:

- the failing check names,
- the first 5 errors, with the stack line mapped to the module source line,
- invariant numbers,
- test messages.

Three failures in a row abandon the omen, and the Chronicle records it.

### Activation

Each candidate is stamped with the **manifest version** it was validated against. The version increments on every install, Unmake, and quarantine.

At the first dawn after a candidate passes:

- **If the manifest version is unchanged:**
  1. Write a checkpoint.
  2. Send `install` to the sim worker.
  3. Commit the save (§9).
  4. Show the banner.

  There's no re-validation at dawn. The world is a few in-game days older than the clone, and live faults are still caught by quarantine.
- **If the manifest changed** during the build (the player unmade something, or a module was quarantined), the candidate is re-validated against the current world in the background. It gets one repair attempt if it fails, and it activates at the dawn after it passes. Meanwhile the shrine reads *"The god reconsiders…"*. The sim never pauses for this.

**Reveal:** after activation, the first visual effect credited to the module flies the camera there, at whatever time it happens. If one in-game day passes with no visible effect, the camera goes to the shrine. The camera move is skipped while the player has a panel open, and a "Show me" button appears in the banner instead.

### Budget (per installed feature, worst case)

| Call | Input tokens | Output tokens |
|---|---|---|
| Propose | ~4K | ~1K |
| Implement | ~12K (8K cached), up to ~28K with two `builds_on` sources | ~5K |
| Repair ×2 | ~17K each, up to ~33K with `builds_on` | ~5K each |
| **Total** | **~50K, up to ~100K** | **~16K** |

Caps:

- Session: 1 proposal call per idle period and 1 active build at a time.
- Day: 10 builds per player per real day.
- Credits: a per-game cap set in Run's AI config.

The game is **creator-billed** for the jam. Run credit rates are still unverified (open item V4).

### AI providers

The pipeline talks only to an `AiProvider` interface:

```ts
interface AiProvider {
  complete(req: {
    role: 'propose' | 'implement' | 'repair',
    system: string, messages: { role: 'user' | 'assistant', content: string }[],
    schema: JSONSchema, maxTokens: number,
  }): Promise<{ data: unknown, usage: { input: number, output: number } }>
}
```

It has five implementations:

- **`RunAiProvider`:** the SDK's `textGen.requestChatCompletionAsync` with `responseFormat: { type: 'json_schema' }`.
  - Model class: `standard` for propose, `power` for implement and repair.
- **`ClaudeCodeProvider`** (local platform, **default**): runs Claude Code on the developer's machine. Usage comes out of the developer's Claude subscription, with no API key and no credits.
  - **Route:** the browser POSTs `{ system, messages, schema, model }` to `/dev-ai/claude-code` on the Vite dev server. A dev-only middleware in `vite.config.ts` spawns:

    ```
    claude -p --output-format json --json-schema <schema> \
      --system-prompt-file <tmp> --model <model> \
      --tools "" --safe-mode --no-session-persistence
    ```

    - It's spawned with an **argv array** (`child_process.spawn(cmd, args)`), never a shell string, so schema JSON and prompt text need no quoting.
    - The user messages go to the command on stdin.
    - If `--system-prompt-file` isn't supported, the system prompt is passed as a `--system-prompt` argv element (about 32 KB, well under Linux argv limits).
  - **Flags:**
    - `--tools ""`: no file, shell, or web access, so the model only writes text.
    - `--safe-mode`: the user's CLAUDE.md, plugins, hooks, and MCP servers don't leak into the god's prompt.
    - `--no-session-persistence`: god calls don't clutter the session history.
  - **Models:** `opus` for implement and repair, `sonnet` for propose. Both can be overridden with `CLAUDE_CODE_PROPOSE_MODEL` and `CLAUDE_CODE_IMPLEMENT_MODEL` in `.env.local`.
  - **Parsing:** the middleware reads the JSON result envelope, takes the schema-conforming output, and checks it against the schema once more before returning it. If the output doesn't parse, the provider fails the call. The pipeline treats that like any other provider error: one retry, then the omen is abandoned.
  - **Limits:**
    - One call at a time; a second request waits in a queue.
    - Timeout of 15 minutes per call. This only catches a stuck process; slow calls are fine.
    - Expect slower calls than the direct API, because each one starts a Claude Code process.
    - Usage counts against the subscription's limits. A limit error shows in the shrine status as *"The god is resting"*, and the pipeline retries after 10 real minutes.
  - **Verify first, in milestone 1, with a throwaway script:**
    - where the `--json-schema` result sits in the `--output-format json` envelope;
    - that `--json-schema` still works with `--tools ""` (structured output may depend on an internal tool);
    - that `--safe-mode` combines as expected;
    - that `--system-prompt-file` exists;
    - real latency of one opus implement call (for information only, not a requirement).

    If `--json-schema` fails with tools disabled, fall back to plain text output with a fenced JSON block, parsed and schema-checked by the middleware.
  - **Requirements:** the Claude Code CLI must be installed and logged in on the dev machine. The middleware checks `claude --version` at startup and, if it's missing, falls back to `ManualProvider` with a warning.
- **`LocalAnthropicProvider`** (local platform, **opt-in only** via `?ai=api`; a **stretch item**, built last if time allows): calls the Anthropic Messages API directly, billed to the developer's own API key. Not needed for development. It exists for measuring provider-side cost and comparing behavior.
  - **Models:** `claude-sonnet-5-5` for propose, `claude-opus-5-5` for implement and repair. Both can be overridden with `VITE_PROPOSE_MODEL` and `VITE_IMPLEMENT_MODEL`.
  - **Structured output:** the request's `schema` becomes the input schema of a single tool that the model is forced to call. The tool's `input` is returned as `data`, so the pipeline gets the same parsed object it gets from Run.
  - **Prompt caching:** the system prompt carries a `cache_control` breakpoint, matching the caching assumed in the budget.
  - **The key never reaches the browser.** Requests go to `/dev-ai/v1/messages` on the Vite dev server. A dev-only proxy in `vite.config.ts` forwards them to `https://api.anthropic.com` and adds `x-api-key` from `ANTHROPIC_API_KEY` in `.env.local` (git-ignored, never prefixed `VITE_`), plus `anthropic-version`.
  - The proxy exists only in `vite dev`, so a production build has neither the route nor the key.
  - Token usage is logged per call. That gives provider-side cost numbers before V4 is measured on Run.
- **`FixtureProvider`:** replays recorded responses. Used for deterministic pipeline tests in Vitest. Any provider can record its responses into `test/fixtures/` with `?record=1`.
- **`ManualProvider`** (dev builds only): a panel where a human pastes module source, to exercise validation and activation directly.

## 9. Persistence

All saving goes through a `SaveStore` interface, so the game can run off Run:

```ts
interface SaveStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
```

It has three implementations:

- **`RunSaveStore`:** `RundotGameAPI.appStorage`.
- **`LocalSaveStore`** (local platform): `localStorage`, with keys prefixed by save slot. A `?slot=name` URL parameter keeps several test islands side by side, and `?fresh=1` clears the slot.
- **`MemorySaveStore`:** Vitest and validator tests.

Both browser stores enforce **Run's limits** (key count, per-value size), so a save that would fail on Run fails locally too. Run's limits:

- 128 keys
- ~256 KB comfortable per value
- 10 MiB per bucket

`localStorage` holds only about 5 MB per origin, so the local store warns at 4 MB total.

| Key | Contents | Size estimate |
|---|---|---|
| `mi:head` | `{ schemaVersion, gen, slot: 'a'\|'b', manifestVersion }`, **written last** | tiny |
| `mi:world:a` / `mi:world:b` | two alternating world slots. Each holds tiles (RLE), all layers, entities, time, RNG state, module state/data/tileData, schedules, **the manifest** (id, title, description, status, day installed, requires), and its `gen` | ~40–150 KB each |
| `mi:checkpoint` | last dawn's world, same format, **with its own manifest** | same |
| `mi:mod:<id>` | module source, one key per module (≤30 KB). **Immutable**: written once at activation, never changed | ≤40 keys |
| `mi:chronicle` | last 150 entries | ~20 KB |
| `mi:pending` | pipeline job: omens, choice, stage, latest source, validated flag, manifest version stamp | ≤40 KB |

**Atomic commit:** `appStorage` writes keys one at a time, so a crash can land between writes. A save therefore commits in this order:

1. Write any new `mi:mod:<id>` sources.
2. Write the world into the **inactive** slot, stamped with `gen + 1`.
3. Write `mi:head` pointing to that slot.

On load, the head's slot is used only if its stamped `gen` matches the head. Otherwise the other slot is used. A crash at any point therefore leaves the previous complete save intact. Because the manifest lives inside each world, a world and its module list can never disagree. Sources of unmade modules are deleted only after a commit that no longer lists them, and after the checkpoint stops referencing them.

**Size guard:** each module's state is capped at 8 KB (§5). A world over 200 KB logs a warning and adds a note to the god's observation ("the island is heavy"). A world over 900 KB refuses to save and quarantines the module with the largest state.

**When the game saves:**

- at dawn,
- after activation, Unmake, and quarantine,
- every 30 real seconds,
- when the tab is hidden: one best-effort save. `pagehide` can't be relied on for an async write, so the 30 s cadence is the real guarantee.

**What gets saved:** the module *source*, never a blob URL. On load, the worker re-imports each active and quarantined module from source and runs its `define`, never its `init`.

**Away from the game (the partial answer to offline development):** the simulation doesn't advance while the game is closed. Two things soften that:

1. A build that **passed validation before the session ended** is persisted and activates at the first dawn after the player returns, with the full reveal. *"While you were away, the god finished its work."*
2. If a build was mid-pipeline, it resumes at load, and the shrine shows progress right away.

## 10. Project layout

**Location:** the repo lives on the Linux filesystem (e.g. `~/monster-island`), **not** under `/mnt/c/.../OneDrive`. Vite's file watching is unreliable over WSL's Windows mount, and OneDrive would try to sync `node_modules`. The design docs can stay where they are or be copied in.

```
monster-island/
  index.html, package.json
  vite.config.ts                      # base './'; dev-only /dev-ai routes (§8)
  dev/claude-code-middleware.ts       # spawns `claude -p` for ClaudeCodeProvider
  .env.local                          # optional model overrides / API key, git-ignored
  rundot/textGen.config.json          # allowed models, credit cap (format to verify)
  src/
    main.ts                           # boot: pick platform, load save, start workers
    platform.ts                       # run | local → AiProvider + SaveStore
    sim/                              # pure TS, no DOM
      world.ts island-gen.ts rng.ts entities.ts behaviors.ts
      pathfind.ts needs.ts time.ts serialize.ts
      layers.ts                       # per-module override stacks (tiles, stats, visuals, tags)
      module-runtime.ts               # api factory, views, attribution, caps, faults, unmake
      ast-check.ts                    # acorn-based source rules (§4)
      invariants.ts validator.ts      # paired soak + checks + visibility + round-trip
      hang-replay.ts                  # culprit search after a watchdog restart
    workers/sim.worker.ts validator.worker.ts
    render/                           # three.js
      renderer.ts terrain.ts shapes.ts particles.ts sprites.ts sky.ts camera.ts
    god/
      observe.ts prompts.ts schemas.ts pipeline.ts
      providers/ ai-provider.ts run.ts claude-code.ts local-anthropic.ts fixture.ts manual.ts
      reference-modules/fireflies.js wading.js
    ui/ hud.ts omens.ts shrine.ts chronicle.ts inspector.ts
    persist/ save-store.ts run-store.ts local-store.ts memory-store.ts
  test/ (vitest: sim determinism, invariants, module runtime, unmake, pipeline w/ fixtures)
```

Stack: TypeScript, Vite, three.js (bundled), acorn (bundled), Vitest, and the Run SDK. No other runtime dependencies.

## 11. Build order

Each milestone ends with something runnable. Everything is local. Phase 1 needs no Run account, no API key, and no credits; only a logged-in Claude Code CLI.

### Phase 1: proof of concept (the one-session target)

1. **Scaffold + probe:**
   - Vite + TS + three in a Linux-side folder; `npm run dev:local` shows an empty scene.
   - **Probe script** for `claude -p`: run the §8 checks (structured output with tools off, `--safe-mode`, `--system-prompt-file`) and record one real implement-call latency.
2. **Core sim (headless):** island generation with placement rules, entities, needs, food with reservation, day and night, utility behaviors, cost table + A* with the repath budget, births and deaths, serialization. Vitest:
   - the same seed gives the same state after 10 days;
   - the 50-seed sweep passes;
   - births occur.
3. **Renderer:** terrain chunks, shape kit (plain meshes), particles, emotes and speech, sky and day/night, camera, frame interpolation. The island is visibly alive.
4. **Sim worker + saves:** sim worker, frame messages with resync, watchdog, 1×/2×/pause, `LocalSaveStore` save and load.
5. **Module runtime:**
   - AST check and runtime stubs;
   - per-module `api` with frozen views, `define`/`init`, attribution, caps, faults, quarantine, and the dev "disable module" toggle.

   Both reference modules install, run, and survive a reload.
6. **Validator:** validator worker, static checks, dawn-advanced clone, single soak with absolute invariants, module tests, visibility, round-trip. A deliberately broken module of each of these kinds is caught:
   - one that throws,
   - an infinite loop,
   - an invisible change,
   - unserializable state,
   - writes to a frozen view,
   - `Math.random`.
7. **God pipeline + UI:**
   - observation, prompts, schemas, host-assigned ids, `suspends`, `ClaudeCodeProvider` + `ManualProvider`;
   - the god's cycle: idle omens with pause, shrine status, dawn activation, first-effect reveal;
   - chronicle, inspector;
   - pending-job resume.

   **Phase 1 is done when the §13 criteria pass.**

### Phase 2: hardening and Run (later sessions)

In rough priority order:

1. Unmake with layers, cascade, and strand recovery.
2. Paired baseline validation and manifest re-validation.
3. Two-slot atomic saves and the size guard.
4. Hang replay and the global performance budget.
5. The remaining API pieces: schedules, `tileData`, `suspend`, and events.
6. Whisper box and the Works list.
7. Instancing per part.
8. `FixtureProvider` and `?record=1`.
9. Run platform: SDK, `RunAiProvider`, `RunSaveStore`, deploy, and the §12 checks. This needs you to log in to the Run CLI yourself.
10. `LocalAnthropicProvider` (optional).

## 12. Verification items (Phase 2, on the deployed build)

| # | Question | Fallback if it fails |
|---|---|---|
| V1 | Does `import(blobUrl)` work inside a module worker in Run's iframe? | Classic blob worker that joins the sim bundle and module source (§4) |
| V2 | Does Run AI with `power` class return 5K-token code outputs within its timeout? | Use `standard`, and split implement into setup+visuals and behaviors+tests calls |
| V3 | Does `json_schema` output work reliably with long string fields? | Use `json_object`, or plain text with fenced code and a parser |
| V4 | Credit cost per feature (measured) | Lower the repair count, cache more, use `standard` for repair |
| V5 | appStorage round-trip of a ~150 KB world slot, plus the atomic commit order under a forced reload mid-save | Shrink the world encoding (e.g. drop RLE'd base tiles and regenerate them from the seed) |
| V6 | Do validator plus sim workers hold 60 fps on a mid-range laptop? (Phone is informational only.) | Run the validator soak in time slices, and lower the particle cap |
| V7 | Do the AST rules and the frozen built-ins survive Vite's production minification and Run's iframe? | Load the hardening as an unminified worker prelude |

## 13. Acceptance criteria for the MVP

**Phase 1 (proof of concept):** all of these pass locally with `ClaudeCodeProvider`.

1. A new island shows both villages living full day/night cycles with no AI involved, including at least one birth within 10 days.
2. AI-proposed omens appear. Picking one produces AI-written module code that passes validation and goes live at the first dawn after passing, with a reveal on its first visible effect. How long this takes doesn't matter.
3. At least one activated feature is behavior the code base didn't contain before the session: a new tile type, entity, or inhabitant behavior.
4. Reloading the page restores the world, its features, the chronicle, and any in-progress build.
5. A deliberately broken module (via `ManualProvider`) is caught by validation. A module that throws repeatedly in the live world is quarantined, and the island keeps running.

**Phase 2** adds:

6. Unmaking a feature returns the island to a playable state with no stranded inhabitants, and leaves other modules' changes intact.
7. A hanging module injected into the live world is recovered by the watchdog. Hang replay quarantines that module and no other, without losing the save.
8. Criteria 1, 2 and 4 pass again on the deployed Run build.

## 14. Answers to the brief's open questions (for this MVP)

| Brief question | MVP answer |
|---|---|
| What does the player do? | Picks one of three omens whenever the god is idle (the game pauses to choose), whispers suggestions, unmakes works they dislike, inspects inhabitants. |
| What guides the "entertainment" objective? | Observation signals (behavior histogram, recent events, stagnation), plus the player's picks, skipped omens, and unmakes as direct feedback. |
| One program or modules? | Modules with a fixed host API and per-module attribution. |
| How are changes validated? | A paired soak (with and without the candidate) from a dawn clone, with host-owned relative invariants, a visibility check, and a save round-trip, plus the module's own tests. Core rules relax only through an omen's player-approved `suspends`. |
| How is removal handled? | Every lasting change is a per-module layer, so Unmake removes exactly that module's effects, cascades to dependents, and recovers stranded inhabitants. |
| How are saves kept compatible? | Modules are additive and namespaced, with `define` re-run on load. Saves commit atomically through a head key. Only the core schema is versioned, and we write those migrations ourselves. |
| Offline development? | Out of scope. A validated build activates on return (§9). |
| Shared catalog, validation of others' packages? | Deferred. Module format, `requires`, and tests are already package-shaped for later. |
| Cost? | Capped per session and per day; measured in V4. |
