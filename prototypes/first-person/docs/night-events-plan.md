# Night events: implementation plan (revised after review)

Replaces the LLM creation system ("god pipeline") with a fixed, data-driven set of **night events**. When Dagon wins
the midnight Judgment, the next event in a deck fires. When the Most High wins, or it's a tie, nothing happens.

Written to be built from a fresh context. Claims about the code were checked against the source on 2026-10-15; line
numbers are approximate (`~`). Re-check any line before editing it. The plan was then attacked by a separate
reviewer. Its findings (5 blocking, 12 should-fix, a handful of nits) are folded in below. The review itself is not
needed to build this.

**Definition of green for every step:** `npm run typecheck`, `npm test`, `npm run arena:sync` (if `arena:status`
reports drift) then `npm run arena:typecheck` and `npm run arena:test`, a short play of the change, and a commit.

## Goals and non-goals

- **Goal:** five events (The Long Night, Jackal Escort, Frenzy, Turncoats, Ascension) defined as **data** over a small
  library of coded **effect primitives**, so new events are usually new data, not new code.
- **Goal:** easy tuning: fire any event from the URL or the console, see what's active in the HUD, one smoke test
  per event.
- **Goal:** remove the LLM pipeline and the sandboxed module runtime entirely (last step).
- **Non-goal:** human-side events. The hook takes a winner, but the human list is empty.
- **Non-goal:** a live editor for event data. Event defs are TypeScript data; Vite hot reload is the editor.

## Defaults assumed for open design questions

These are the defaults the plan builds. Each one is a single value in `src/sim/events/defs.ts` or one branch of code,
so it's cheap to change later.

| Question | Default |
|---|---|
| When events start | Long Night: next day at 14:00 (darkness falls by 16:00). The other four start at once, at midnight. |
| After the fifth event | `onExhausted: 'loop'`. A second Ascension picks the strongest monster that isn't ascended yet. |
| Turncoats and game over | Turncoats still count as villagers for game over (they're coming back). |
| Turncoat end state | Survivors revert at dawn. A turncoat beaten to 20 % surrenders and reverts on the spot. |
| Long Night length | Darkness plus a slower clock (see Step 3). Clock hours are never remapped. |
| Overlap | Events may overlap. The same event firing again while active → `refresh` (extend to the new end). |
| `stacking: 'skip'` | The draw is spent: the deck advances even when the event is skipped. |
| Old saves | Bump `SCHEMA_VERSION` to 4. Old saves (which may contain LLM modules) start a fresh island. |
| The Ascended on the altar | Worth its full (×10) HP in favor. Its limbs scale ×10 too (`rescaleZones`), so it's very hard to sever. Both intended for now: a big risk with a big reward. Revisit in play. |
| Burning a turncoat | Still a villager: the elder condemns it (`condemn`), as for any villager. |

## Facts about the current code this plan relies on (verified)

- **Judgment.** `judgment()` (`src/sim/favor.ts:~121`) runs from `Sim.midnight()` (`sim.ts:~606`), which is called on
  every midnight hour boundary, **live or offline**. It compares `favor.human` vs `favor.monster`. When one god wins
  and `sim.judgmentEnabled`, it pushes a `CreationRequest` onto `sim.pendingCreations` (capped at 3). Then it resets
  favor and the prayer. Midnight order: `judgment` → `villageMidnight` → `monsterMidnight` (which calls `rollHunts`
  for every monster) → `listeners.onMidnight`. Tests run with `judgmentEnabled = true`, and monster sacrifices
  feed Dagon, so **multi-day tests will start firing events** unless the test deck is empty (Step 1).
- **Clock.** `advanceClock(ms, live)` walks hour boundaries. `onHourBoundary` runs `villageHour` and `raidHour`
  always. Listener hooks (`onHour`, `onDawn`, `onDusk`) fire only when `live`. The offline resolver
  (`src/sim/offline.ts:~119`) calls `sim.advanceClock(step)` hour by hour with the default `live = true`, but
  doesn't tick entities. `clockMs` is anchored to wall time only when the island is created. After that, the
  worker's `catchUp` advances by `realGap × timescale` (`sim.worker.ts:~450`), so a slower clock just falls behind,
  harmlessly. The away summary keeps only some chronicle kinds (`offline.ts:~157–160`).
- **Time-rate code.** `sim.msPerTick` (game ms per tick) is used for rates in `village.ts:~275` (healing),
  `village.ts:~384` (`foodTick` dt), and `monster-ai.ts:~390` (lair healing). The worker sets `msPerTick` from
  the timescale (`sim.worker.ts:~499`).
- **Light.** `Sim.computeLight()` = `baseLight(hour) × (1 − atmosphere.darkness) + atmosphere.light × (1 − L)`.
  The renderer's sky draws `light − clockLight(hour)` as extra darkening (`render/sky.ts:~288`). Fog distance
  shrinks with low light and with `atmosphere.fogDensity` (`sky.ts:~318–320`). `sim.atmosphere` reaches the
  client in frames when `sim.out.atmosphereDirty` is set (`sim.worker.ts:~358`).
- **Night logic is mostly driven by light:** night-hour monsters are active when `light < 0.3`, day monsters rest
  when `light <= 0.4` (`monster-ai.ts:~138`), monster sight is 7 vs 10 tiles by light, and the champion's and
  villagers' vision is light-based (`vision.ts`). Hour windows are used by `monsterWindows` (`monster-ai.ts:~23`,
  feeding `monsterActive` and `rollHunts`) and villager shifts (`village.ts:~50`).
- **Teams.** Every human and monster gets `e.faction` at spawn (`populate.ts:~78, ~115`). Hostility is nevertheless
  decided by `kind` almost everywhere (`kind === 'human'` / `'monster'`, ~80 sites in `src/sim`, many of which are
  about bodies, not teams). Already faction-based: XP in `applyDamage` (`combat.ts:~161`).
  **Corpses copy their faction** (`combat.ts:~320`) and every spawn starts at `hp: 1` (`sim.ts:~241`), so
  `faction` alone doesn't mean "alive and fighting": always pair it with `e.inhabitant`.
  Each site filters states its own way: `nearestThreat` skips only `downed`/`bound` (a monster in `carry` is still
  a threat), and `champion.ts:~643` also skips `rest`. `LOCKED_STATES` (`sim.ts:~27`) is broader
  (`captive`, `downed`, `bound`, `carry`, `sacrifice`, `dead`).
- **Levels.** `levelUp` (`combat.ts:~505`) rewrites `base.maxHp` (mods survive), **resets a monster's `e.scale`**
  to `ARCH.scale × 1.05^(level−1)`, gives non-monsters `base.maxHp = humanMaxHp(level)`, and calls
  `rescaleZones` (`combat.ts:~30`), which sizes zones from the mod-inclusive `maxHp`. Any `inhabitant` with a
  faction earns XP for cross-faction damage.
- **Stat mods.** `e.mods[stat][source] = { mul, add }`, effective = `base × Πmul + Σadd` (`Sim.stat`). Monster
  damage is `M.dmg × stat('strength')` (`monster-ai.ts:~841, ~1007`). Monster speed is `stat('speed')` × factors
  (`monsterSpeed`). Mods are saved with the entity.
- **Tags.** `e.tags` plus `e.tagOwners`, saved with the entity. `'hittable'` makes a non-monster entity a valid
  target for champion attacks and spears (`champion.ts:~424`, `spears.ts:~140, ~167`).
- **Downing.** Any `inhabitant` dropping below 20 % HP is downed (`combat.ts:~173`). A downed monster flees after
  `DOWNED_TICKS` (`monster-ai.ts:~300`). A fighting monster flees below 30 % HP unless its target is the champion
  (`monster-ai.ts:~343`). `hunt()` walks to `M.ground` until `M.huntUntil` (`monster-ai.ts:~409, ~628`).
- **Behavior override.** `Sim.moduleBehavior(e)` (`sim.ts:~790`) lets a scored `BehaviorEntry` take over a human or
  monster for one tick, **except in `LOCKED_STATES`** (so never while downed). It's only called from the `human`
  and `monster` cases of `step()`. Unknown kinds fall to `default:` and only advance a path if they have an `owner`.
- **Rendering entities.** Frames pack entities into a `Float32Array` (`ENT_STRIDE = 18`, layout `O` in
  `protocol.ts:~13–15`). The only consumers are the worker packer and `render/entities.ts`. A view is rebuilt
  whenever its key (`shape|tint|flags`) changes or a model finishes loading, and destroyed when the entity leaves
  the frame (`entities.ts:~104, ~172–175`). Human rigs pick their job look from the tint (`JOB_BY_TINT`,
  `rigs.ts:~220`). ⇒ Changing `e.tint` rebuilds the rig and can change a villager's clothes. It's not a usable
  "red tint". Events need their own visual channel, re-applied after every rebuild.
- **What the client may target.** Sword and spear aim (`main.ts:~836, ~889`) accept only `F_MONSTER | F_HITTABLE`
  and skip `F_DOWNED`. The worker sets `F_HITTABLE` from the `'hittable'` tag (`sim.worker.ts:~175`). Sim-side,
  `spears.ts hittable(sim, e, spear)` (`~167`) excludes `kind === 'human'` outright.
- **What the client may see.** The worker's `rendered()` (`sim.worker.ts:~96–107`) limits only `kind === 'monster'`
  by light and sight. Everything else is sent out to 80 tiles. Names: `titleOf` (`~145`) and the monster roster
  (`~313`, names cached once).
- **Shapes.** Prim-built `ShapeDef`s (`CORE_SHAPES` in `core-defs.ts`, rendered by `render/shapes.ts`) are core,
  not module-only. The `goat` shape is in `CORE_SHAPES`.
- **Village.** `nearestThreat(sim, e, r)` (`village.ts:~83`) is what makes workers flee and guards fight. It only
  considers `kind === 'monster'`. `guardFight(sim, e, m)` (`~348`) is generic melee against any entity with HP.
  Food is the global `sim.food`, the fold is `sim.fold` (lamb count), and stores sit at `sim.layout.granary` and
  `sim.layout.fold`.
- **Game over** (`Sim.checkGameOver`) counts `kind === 'human'` (minus the champion) and `kind === 'monster'`.
- **Saves.** `SCHEMA_VERSION = 3` (`serialize.ts:~11`). `main.ts:~135` discards a world whose `core.v !== 3`.
  `SavedWorld = { core, modules, manifest }` (`island.ts`).
- **Arena sandbox.** `src/arena/sandbox/sim/monster-ai.ts` and `.../village.ts` hold **unpromoted** edits (a raid
  fix and guard followers) that stand in for the game files in the arena. This plan edits both game files. The
  arena doesn't just drift: once a new file imports a new export from `village.ts` (`meleeFight`, `leaveHouse`), the
  arena build and `arena:typecheck` fail until `arena:sync` brings the export into the sandbox copy. Hence the
  definition of green above. `arena-sim.ts` sets `judgmentEnabled = false`. `arena-hooks.ts` builds
  `new Island(sim, opts)` and calls the 4-argument `Island.load`.
- **LLM-system tendrils outside `src/god`.** `dev/terrain-middleware.ts:~7` imports `allowed` from
  `claude-code-middleware.ts`. Both `vite.config.ts` and `vite.arena.config.ts` load `claudeCodePlugin`. The
  terraformer's `?shot=` uses the middleware's `/dev-ai/delay` endpoint (`src/terraformer/main.ts:~12`).
  `src/platform.ts` imports the god providers and `main.ts` uses `platform.provider`. `ui.ts:~6` imports types from
  `god/pipeline`. About 10 test files call `Island.create(seed, START, ts, { now })`. `test/game.test.ts:~122–135`
  asserts `pendingCreations.length === 3`. `test/old` is already excluded by `vite.config.ts`.

---

## Architecture

```
src/sim/events/
  types.ts       EventDef, DeckDef, Selector, Duration, Start, EffectSpec, EventInstance, EventState
  defs.ts        THE DATA: EVENTS (the five events), DECK, UNITS (jackal)
  director.ts    EventDirector: deck, verdict, lifecycle, globals, save/restore, away resolution
  select.ts      resolveSelector(sim, sel, rng) → entity ids
  primitives.ts  the effect registry (statMod, tag, fx, scale, rename, healFull, darkness, clockRate,
                 atmosphere, windowBonus, spawnEscort, convert)
  units.ts       spawnUnit, stepUnit (brain dispatch), the 'pack-raider' brain
  turncoat.ts    the 'turncoat' behavior (registered through the kept behavior hook)
src/sim/night.ts  one definition of night: darkness ramp, clock rate, window bonus (read by sim + monster-ai)
src/sim/team.ts   hostile(a, b)
```

### Data shapes (`types.ts`)

```ts
export interface Selector {
  kind?: string;                     // 'monster' | 'human' | unit kind
  faction?: Faction;
  jobs?: Job[]; excludeJobs?: Job[];
  withTag?: string; withoutTag?: string;
  includeChampion?: boolean;         // default false
  includeIncapacitated?: boolean;    // default false: skips downed/bound/captive/carried
  includeHidden?: boolean;           // default false (villagers inside houses are hidden)
  pick?: 'all' | 'random' | 'strongest';   // default 'all'
  count?: number | [number, number];
  fraction?: number | [number, number];
  min?: number;                      // with fraction: at least this many
}
export type Start = 'now' | { atHour: number };            // next occurrence of that clock hour
export type Duration = { until: 'dawn' } | { untilHour: number } | { hours: number } | 'permanent';
export interface EffectSpec { type: string; who?: string; [param: string]: unknown }
export interface EventDef {
  id: string;
  title: string;
  armText?: string;                  // alert + chronicle at the verdict, for events that start later (Long Night)
  announce: string;                  // alert + chronicle when it starts
  endText?: string;                  // chronicle when it ends
  start: Start;
  duration: Duration;                // measured from the start
  stacking: 'refresh' | 'stack' | 'skip';
  targets?: Record<string, Selector>; // named sets, resolved ONCE at start; effects refer to them by `who`
  effects: EffectSpec[];
}
export interface DeckDef { order: string[]; mode: 'sequential' | 'shuffle'; onExhausted: 'loop' | 'repeatLast' | 'stop' }
export interface EventInstance {
  iid: number;                       // unique per island
  def: string;
  phase: 'armed' | 'active';
  startAt: number;                   // clockMs
  endAt: number | null;              // clockMs; null = permanent (resolved when it starts)
  targets: Record<string, number[]>; // resolved entity ids
  state: Record<string, unknown>[];  // per effect index, JSON-safe
}
export interface EventState { deckPos: number; nextIid: number; active: EventInstance[]; history: { def: string; day: number; endedDay?: number }[] }
```

`targets` are resolved once and stored, so `remove` touches exactly the entities that got the effect, and a save
mid-event restores correctly. A selector that matches nobody gives an empty set. An event whose every target set is
empty and that has no global effects logs "Dagon's curse finds no one" and is archived. **The deck still advances.**

### Primitives (`primitives.ts`)

```ts
interface Ctx { sim: Sim; inst: EventInstance; i: number /* effect index */; key: string /* `event:${iid}` */; rng: Rng }
interface Primitive<P> {
  parse(spec: EffectSpec): P;                         // throws on bad params (run on every def in a test)
  apply?(ctx: Ctx, p: P, ids: number[]): void;        // at start
  tick?(ctx: Ctx, p: P, ids: number[]): void;         // every tick while active
  remove?(ctx: Ctx, p: P, ids: number[]): void;       // at end (not for permanent events)
  global?(ctx: Ctx, p: P, g: NightMods): void;        // contributes to the derived globals every tick
  away?(ctx: Ctx, p: P, hours: number, sum: AwaySummary): void;  // abstract offline resolution
}
```

Rules every primitive follows:
1. **Entity changes are keyed by `ctx.key`.** Stat mods go under `e.mods[stat][key]`, tags get `tagOwners[t] = key`,
   and fx entries carry the key. `remove` deletes by key only. Two overlapping events never undo each other.
2. **Global changes are never written in place.** `global()` adds into a fresh `NightMods` every tick. The director
   turns the sum into `sim.atmosphere` and `sim.night`. Ending, loading or stacking can't leave a stray change behind.
3. **Skip dead ids silently.** Targets can die mid-event.
4. **Use `ctx.rng`** (`sim.rng`) for randomness, never `Math.random`, so tests stay deterministic.

| Primitive | Params | Notes |
|---|---|---|
| `statMod` | `who, stat, mul?, add?` | `e.mods[stat][key]`. For `maxHp`: raise `hp` by the same ratio, then call `rescaleZones`. |
| `tag` | `who, tag` | Generic flag. `'no-retreat'` is read by monster AI. |
| `fx` | `who, fx` | Visual aura id. See "Visual channel". |
| `scale` | `who, mul` | Keyed multipliers: `e.scaleMods[key] = mul`, and `e.scale` is recomputed. `levelUp` multiplies them in too (it resets `e.scale` today). |
| `rename` | `who, pattern` | `'{name} the Ascended'`. Permanent-only (no remove). |
| `healFull` | `who` | `hp = maxHp`, zones restored to `ok`. |
| `darkness` | `ramp: [hour, amount][]` | Piecewise-linear over clock hours, wrapping midnight. → `NightMods.darkness` (max). |
| `clockRate` | `from, to, rate` | Clock hours window. → `NightMods.clockRate` (min). |
| `atmosphere` | `fogDensity?, fogColor?, weather?` | → `NightMods.atmosphere` (max / last wins). |
| `windowBonus` | `hours, reroll?` | → `NightMods.windowBonus` (max). `reroll` re-rolls hunts at start. |
| `spawnEscort` | `leaders: who, unit, count, maxFood` | Spawns units per leader. `maxFood` caps food stolen by the **whole event**, in instance state. `remove` sends survivors fleeing, then despawns them. |
| `convert` | `who, to: Faction, brain, fx` | Flips `faction`, tags `'turncoat'` and `'hittable'`, wakes hidden ones. `remove` reverts survivors. |

### The director (`director.ts`)

`sim.events: EventState` (saved) plus `sim.director: EventDirector` (not saved; rebuilt on load).

- `onVerdict(winner: Faction | null)`: called by `judgment()` in place of the `pendingCreations` push, and only
  when `sim.judgmentEnabled`. For `'monster'`: draw the next def from `sim.deck` (an instance field defaulting to
  `DECK`; tests replace it), apply `stacking`, create an `armed` instance with `startAt`, show `armText` if any,
  then call `update()` (so `'now'` starts immediately, before `monsterMidnight`). An empty or exhausted deck is a
  no-op with a chronicle line.
- `update()`: called at the end of `Sim.step()` **and** from `onHourBoundary` (so offline catch-up, which doesn't
  tick entities, still starts and ends events on time). It (1) starts armed instances whose `startAt ≤ clockMs`:
  resolve targets, `apply`, announce, compute `endAt`; (2) ends active instances whose `endAt ≤ clockMs`:
  `remove` in reverse effect order, log `endText`, archive; (3) runs `tick` for active instances (live only: pass a
  flag; skip in the hour-boundary call); (4) recomputes `NightMods` from all active instances and writes
  `sim.night` and `sim.atmosphere`, setting `atmosphereDirty` only when the value changed.
- `fire(defId)` / `end(iid)` / `list()`: dev. `fire` ignores the deck and `judgmentEnabled`.
- `resolveAway(hours, sum)`: called by `resolveAway` once per hour step. Calls `away` on active primitives.
- `restore()`: after `deserializeCore`, recompute globals. Entity mods, tags, fx and units are already in the save.

**Time math:** `'now'` = clockMs. `{ atHour: h }` = the next clockMs at that hour (strictly after now).
`{ until: 'dawn' }` = the next 06:00 after start. `{ untilHour: h }` = the next h:00 after start. `{ hours }` =
start + n × HOUR_MS. Helpers go in `clock.ts` (`nextHour(clockMs, h)`).

**Deck:** `deckPos` indexes `DECK.order`. `'shuffle'` shuffles with `sim.rng` each time the deck wraps.
`'repeatLast'` sticks on the last entry. `'stop'` makes `onVerdict` a no-op once exhausted.

### Visual channel

Add one slot to the entity frame: `ENT_STRIDE` 18 → 19, `O.fx = 18`. The value is an index into a shared
`FX = ['', 'frenzy', 'turncoat', 'ascended']` table in `protocol.ts`. On the sim side, add `Entity.fx?: { id: string;
key: string }[]` (a stack, so overlapping events restore correctly). The packed value is the top entry.
In the renderer (`render/entities.ts`): keep the fx on the view, and apply it **after every `build()`** as well as
when the value changes (views are rebuilt on key changes and model loads, and recreated when an entity comes back
into the frame). Applying means walking the rig's meshes and setting an emissive color and intensity (`frenzy` red
`#c02020` 0.6, `turncoat` sickly `#4a6a2a` 0.4, `ascended` gold `#d0a030` 0.5). Clone materials the first time
(rigs may share materials). Rough first: emissive only, no shader work.

---

## Steps

Each step ends green (see the definition at the top: game and arena typecheck and tests, a short play, a commit).

### Step 1: Director skeleton, switch off the LLM, schema bump

1. Add `src/sim/events/{types,defs,director,select,primitives}.ts`. `primitives.ts` starts empty. `defs.ts` holds all
   five `EventDef`s from the "Event data" section below and `DECK`, but **`DECK.order` starts empty**. Each later step
   adds its event to the order when its primitives land. The "every def parses" test (below) checks only defs in
   `DECK.order`, so defs whose primitives don't exist yet don't fail it.
2. `Sim`: add `events: EventState`, `director`, `night: NightMods` (Step 3 fills it; default identity values).
   Call `director.update()` at the end of `step()` (before `checkGameOver`) and in `onHourBoundary` (after
   `villageHour`).
3. `favor.ts judgment()`: replace the `pendingCreations` push and cap with
   `if (sim.judgmentEnabled) sim.director.onVerdict(h === m ? null : god)`. Keep the logs. Change the judgment text
   to say what happens ("Dagon prevails. A curse falls on the island." / "The Most High prevails. The night passes
   in peace."). Drop `prayer` from the verdict.
4. Serialization: add `events` to `SavedCore`. Bump `SCHEMA_VERSION` to 4 and the `main.ts:~135` check with it.
   Keep the old LLM fields in the save for now (deleted in Step 7).
5. Switch off the pipeline: in `main.ts`, don't construct `CreationPipeline` or call `kick()` (leave the import
   until Step 7 if that's simpler). Remove the god-status widget updates.
6. HUD and UI: `Hud.events: { title: string; phase: 'armed' | 'active'; at: number | null }[]` from the worker.
   One HUD line per event: armed ones show their start ("The Long Night · falls at 14:00"), active ones their end
   ("The Long Night · until 09:00"). Add `'omen'` to the chronicle kinds the away summary keeps
   (`offline.ts:~157–160`). Rename the "Book of Creation" tab to **Omens** and list
   `events.history`. Hide the **Gods** tab and the prayer box. Add `'omen'` to `Alert['kind']` and give it the
   judgment alert's styling.
7. Dev: worker message `{ type: 'devEvent'; op: 'fire' | 'end' | 'list'; id?: string; iid?: number }`.
   `window.__hm.events = { fire, end, list }` in `main.ts`. URL `?event=<id>` fires once after load.
8. Update the intro text (`main.ts:~244`): "Judgment falls at midnight: if Dagon's followers offered more, a curse
   falls on the island."

9. Tests: existing tests must not start firing events as the deck fills up. The shared test setup sets
   `sim.deck = { order: [] , … }` unless a test opts in. Rewrite `test/game.test.ts:~122–135` (it asserts
   `pendingCreations.length === 3`) to assert that monster verdicts advance the deck instead.

**Tests** (`test/events.test.ts`) use **test-only defs** registered with a test primitive (`{ type: 'mark' }`, which
sets a flag on apply and clears it on remove), so Step 1 has something to fire. They cover: a monster verdict arms
the first deck entry, a human verdict and a tie do nothing, an empty deck is a no-op, the deck advances and loops,
`'skip'` still advances the deck, an armed `{atHour: 14}` event starts at 14:00 the next day through
`advanceClock` (including when the clock jumps there through `resolveAway`), it ends at its `untilHour`, and
`events` survives serialize → deserialize while armed and while active.

### Step 2: Frenzy and Ascension (entity primitives + fx)

1. Primitives: `statMod`, `tag`, `fx`, `scale`, `rename`, `healFull`.
2. The fx slot (see "Visual channel"): `protocol.ts`, worker packing (`sim.worker.ts:~159–200`), and the renderer.
3. `'no-retreat'` tag in `monster-ai.ts`:
   - the flee check below 30 % HP (`~343`): skip when tagged;
   - downed recovery (`~300`): when tagged, set `M.prey` to the nearest human (`findPrey`, falling back to the
     nearest one anywhere) and go to `'stalk'` instead of `'flee'`. Don't go to `'hunt'`: it walks to a stale
     `M.ground` and may give up at once on a passed `huntUntil`. If there's no human at all, flee as today;
   - `ignoreChampUntil` give-up: skip setting it when tagged.
   Downing at 20 % stays. A frenzied monster can still be bound and dragged.
4. Ascension's "strongest" = highest `sim.maxHp(e)`, then `level`, then lowest id. Exclude `withoutTag: 'ascended'`.
5. Scale: add `Entity.scaleMods?: Record<string, number>` and a `scaleMul(e)` helper (product of the values).
   `levelUp` (`combat.ts:~510`) becomes `e.scale = ARCH.scale × 1.05^(level−1) × scaleMul(e)`. The `scale`
   primitive sets or deletes its key and recomputes `e.scale` the same way. Without this, the boss's ×1.4 is lost on
   its first level-up (and a ×10 boss earns XP fast).
6. Zones: `statMod` on `maxHp` calls `rescaleZones` after changing the mod. `levelUp` already keeps `mods`, so the
   ×10 survives level-ups.
7. Names: when `rename` changes a monster's name, invalidate the worker's cached monster roster
   (`sim.worker.ts:~313`) so the monster cards show "the Ascended".
8. `DECK.order = ['frenzy', 'ascension']` for now.

**Tests:** Frenzy: monster speed and strength are ×1.5 while active and back to exact base after dawn, `'no-retreat'`
monsters don't flee at 25 % HP and stalk a human after being downed, fx is set and cleared. Ascension: picks the
strongest, ×10 maxHp at full HP with zones rescaled, scale survives a level-up, name set, survives save/load, and a
second Ascension picks a different monster. Two overlapping Frenzies
(`stacking: 'stack'` in a test-only def) remove cleanly in either order.

### Step 3: One definition of night, then The Long Night

1. `src/sim/night.ts`:
   ```ts
   export interface NightMods { darkness: number; clockRate: number; windowBonus: number; atmosphere: Atmosphere }
   export const NO_NIGHT_MODS: NightMods = { darkness: 0, clockRate: 1, windowBonus: 0, atmosphere: {} };
   ```
   `sim.night` holds the director's current sum.
2. Light: `computeLight()` uses `max(atmosphere.darkness, night.darkness)`. Simplest is for the director to write the
   merged value into `sim.atmosphere.darkness` (rule 2: `sim.atmosphere` is now fully derived; no module writes it
   after Step 1 switched the pipeline off). The renderer already draws `darkness` and `fogDensity`.
3. Clock rate: in `step()`, `const dt = this.msPerTick * this.night.clockRate; this.dtMs = dt; advanceClock(dt)`.
   Initialize `dtMs = msPerTick` (in `generate`, on deserialize, and wherever the worker changes `msPerTick`),
   since it's read before the first step.
   Replace the three rate uses of `msPerTick` with `sim.dtMs` (`village.ts:~275, ~384`, `monster-ai.ts:~390`).
   Leave `msPerTick` itself (timescale) alone. The worker's `catchUp` keeps using `msPerTick` (away time is never
   dilated; document this in `night.ts`).
4. Windows: `monsterWindows()` widens every window by `sim.night.windowBonus` hours (on top of `boldness`).
   **Cap the total widening.** `inWindow` wraps modulo 24, so today's `w = min(6, boldness × 0.5)` plus 2 more hours
   turns a night window `[19−8, 5+8]` into `[11, 13]` (a midday window) from about day 12. Day windows break the
   same way. When a widened window would reach 24 hours or more, return `[[0, 24]]` (always active); `inWindow`
   with `a === b` already means "always", so use `[0, 0]`. Add a test for day 20 with the bonus.
   `windowBonus` with `reroll: true` calls `rollHunts` for every monster when the instance starts.
5. Primitives: `darkness`, `clockRate`, `atmosphere`, `windowBonus`. `DECK.order` gains `'long-night'` (first).
6. HUD clock: the "judgment in" countdown (`sim.worker.ts:~292`) divides by timescale. Replace it with
   `director.realMsUntil(nextMidnight)`, which integrates the clock-rate windows of active instances between now and
   midnight (the same integral the editor mockup uses).

**Why not remap hours** (dusk at 16:00 on the clock): the sky's color keyframes, villager shifts, `championDawn`
at hour 6, `raidHour`, hunt rolls and the dawn/dusk listeners all key on clock hours. Moving them all is the big
refactor. Darkness plus a slower clock gives the same play: dark by 16:00 with workers still in the fields, and a
night that takes twice the real time. The sky goes dark through the light channel. Its twilight hues still come at
the usual hours; accept that for the rough first pass.

**Tests:** the darkness ramp gives `light ≈ 0` at 17:00 on a Long Night day, the clock advances at the slowed rate in
the window and normally outside it, food production per clock hour is unchanged under dilation, the window bonus
widens `monsterWindows`, and globals are back to identity after the event ends and after save/load mid-event.

### Step 4: Teams by faction (refactor; no behavior change)

1. `src/sim/team.ts`:
   ```ts
   /** both are living fighters on opposite teams (corpses copy their faction, so `inhabitant` is required) */
   export const hostile = (a: Entity, b: Entity) =>
     a.inhabitant && b.inhabitant && !!a.faction && !!b.faction && a.faction !== b.faction;
   ```
   There is deliberately **no shared state filter**. Each site keeps its own (`nearestThreat` skips only
   `downed`/`bound`, so a monster carrying a villager stays a threat; the champion's scan at `~643` also skips
   `rest`). Swap only the `kind` test.
2. Go through every `kind === / !== 'human' | 'monster'` in `src/sim` and sort each into **BODY** (rig, zones,
   corpse shape, sounds, capture/bind/sacrifice mechanics, anything that dereferences `e.monster!`/`e.human!`:
   keep `kind`) or **TEAM** (who threatens whom, who may be targeted: switch to `hostile`/`faction`). The test:
   *would a turncoat (a human body on the monster team) or a jackal (a non-monster on the monster team) change the
   answer?* Known TEAM sites:
   - `village.ts nearestThreat` (~86): `hostile(m, e)` instead of `kind === 'monster'`, same state filter. Workers
     then flee from jackals and turncoats, and guards fight them.
   - `monster-ai.ts preyScore/findPrey` (~241–258), the "lone" check, `pickGround` (~271) and `raid()` target
     choice (~526, it reads `sim.humans()`): only `faction === 'human'` humans. Keep `kind === 'human'` too
     (monsters only carry off human bodies).
   - `monster-ai.ts` fight-target check (~337 `t.kind === 'human'`): `hostile(m, t)`.
   - `champion.ts`: attack target (`~424 hittable`), swing fallback (`~443`), threat scans (`~643, ~654`),
     `holdGround` (`~676`), autopilot attack orders (`~721`): any entity hostile to the champion, each with its own
     state filter. Bind/finish/drag (`~535, ~549, ~759`) stay monster-only (BODY).
   - `spears.ts`: target pick (`~140`) and `hittable(sim, e, spear)` (`~167`). The latter gets the spear, not the
     thrower, and excludes humans outright: look up `spear.spear!.thrower` and use `hostile(thrower, e)`, keeping
     the `'hittable'` tag path for non-inhabitants.
   - `vision.ts ~63`: only `faction === 'human'` villagers give the player vision. **`~69` stays
     `kind === 'monster'`**: its body dereferences `m.monster!` (`~74–83`).
   - `combat.ts ~124` (champion hurt flash), `~162`, `~261`, `~276` (kill credit and XP): by faction.
   - Client targeting needs no change: `convert` adds the `'hittable'` tag, so the worker sets `F_HITTABLE`.
   BODY sites stay as they are (zones, corpse parts, roars, bind/finish/drag/offer, `checkGameOver`, minimap).
   Leave `offline.ts` as is.
3. Today `faction` and `kind` agree for every entity, so **this step must change nothing.** Run the full suite
   before and after with no test edits. If a test changes, a site was misclassified.

### Step 5: Jackal Escort

1. `Entity.unit?: { type: string; leader: number; iid: number; mode: string; until: number; stolen: number }`.
2. `UNITS` in `defs.ts`:
   ```ts
   jackal: { kind: 'jackal', title: 'jackal', shape: 'jackal', tint: '#a8865a', scale: 0.8, radiusM: 0.35,
             hp: 20, speed: 1.4, faction: 'monster', tags: ['hittable'], brain: 'pack-raider',
             params: { leash: 6, raidRadius: 10, fearRadius: 3.5, foodBite: 8, biteCooldownTicks: 30, lambChance: 0.15 } }
   ```
   Add a `jackal` `ShapeDef` to `CORE_SHAPES` (boxes, like the old war-hound reference module).
3. `units.ts spawnUnit(sim, type, x, z, leader, iid)`: spawns with `inhabitant = true` (so it separates and
   `hostile()` sees it) and `faction`. Then make units simple:
   - **No downing:** skip the 20 % downing branch (`combat.ts:~173`) when `e.unit`, so a unit dies at 0 HP. (Downed
     units would be untargetable on the client, which skips `F_DOWNED`, and the champion can't finish them.)
   - **No XP or levels:** skip `gainXp` for `e.unit` (otherwise `levelUp`'s non-monster branch makes a jackal an
     80-HP `humanMaxHp` beast).
   - **Body radius:** `bodyR` (`body.ts:~29`) uses `UNITS[type].radiusM` instead of the human fallback.
   - **Names:** `titleOf` and inspect (`sim.worker.ts:~145, ~417`) use `UNITS[type].title`.
   - **Seen like monsters:** the worker's `rendered()` (`~96–107`) applies the monster light and sight limit to
     units too. Otherwise jackals drawn out to 80 tiles give away every hidden monster at night.
   - **Not eaten:** a jackal corpse is fine as a corpse, but keep jackal corpses out of monster feeding
     (`nearestCorpse`) and altar offerings (worth 0) to avoid odd interactions. Check bind/drag stay monster-only.
4. `Sim.step()` `default:` branch: `if (e.unit) stepUnit(this, e)`. `stepUnit` looks up the brain by name.
5. The `pack-raider` brain, run every tick, cheap first:
   - **leader gone** (missing, dead, or not `kind === 'monster'`) → `mode = 'scatter'`: run away from the village for
     5 s, then `sim.remove`. Same when the event ends.
   - **threatened**: a guard or the champion within `fearRadius` → run to the leader.
   - **raid**: within `raidRadius` of the jackal *and* within `leash × 2` of the leader, pick the nearest of:
     a non-guard human outside a house, the granary, the fold. At a worker: `applyDamage` 2 (a nip; enough to make
     them flee through `nearestThreat`). At the granary: every `biteCooldownTicks`, `sim.food -= foodBite`, capped
     by the event's `maxFood` (one shared total in instance state, not per jackal: 24 jackals × a per-jackal cap
     would empty the granary, `foodCap` 500, and start starvation damage at `village.ts:~400`); burst and emote. At the fold: a `lambChance` roll to take a lamb
     (`sim.fold--`), then return to the leader.
   - **else follow**: hold a slot `leash × 0.5` behind the leader.
   - Movement: `moveToward` with a `walkableFor` check first; call `goTo` only when blocked
     (`MAX_REPATHS_PER_TICK = 4` is shared by everyone, and 6 monsters × 4 jackals = 24 units).
   - **Leaders that fly or swim:** jackals can't follow. When the leader is `alt > 3` or on water, hold at the
     nearest walkable spot and raid from there.
6. Primitive `spawnEscort`: per leader, `count` units in a ring around it. Store the ids and food stolen in `state`.
   `remove` → `mode = 'scatter'`. `away`: steal `awayFoodPerHour` per hour while jackals live, within the same
   `maxFood` total. `DECK.order` gains `'jackals'`.

**Tests:** 2–4 jackals per monster, a jackal near the granary lowers `sim.food` and the event total respects
`maxFood`, a guard attacks a jackal, workers near a jackal flee, a jackal dies at 0 HP without being downed and
gains no XP, killing the leader scatters and despawns the pack within ~10 s, all jackals are gone after dawn, and a
save mid-event restores the pack.

### Step 6: Turncoats

1. Keep the behavior hook. Rename `moduleBehavior` → `overrideBehavior` and `CORE_BASELINE` → keep. It stays
   available to humans and monsters. Register `sim.behaviors.push(turncoatBehavior)` in the `Sim` constructor.
2. `turncoat.ts`, applies to `e.tags.includes('turncoat') && e.faction === 'monster'`, score 100:
   - if hidden in a house (the away resolver puts villagers to bed as `'sleep'`), call `leaveHouse` first;
   - export `guardFight` from `village.ts` (rename `meleeFight`) and use it against the nearest entity hostile to it
     within 8 tiles (the champion included);
   - else follow the nearest monster at ~3 tiles; if none within 30, walk out of the walls toward the nearest lair.
3. Primitive `convert`: selector default `{ kind: 'human', faction: 'human', pick: 'random', fraction: [0.10, 0.15],
   min: 1, includeHidden: true }`. For each: `faction = 'monster'`, tag `'turncoat'`, fx `'turncoat'`, and if hidden,
   bring them out of their house (export `leaveHouse` from `village.ts`). Log by name.
   `remove`: survivors get `faction = 'human'`, untag, clear fx, `state = 'idle'`, `stop()`, emote 🙏.
4. Surrender: the behavior can't see it (the behavior hook never runs in `LOCKED_STATES`, and `downed` is one).
   Instead, in the downing branch of `applyDamage` (`combat.ts:~173`): when the target is tagged `'turncoat'`, call
   `surrender(sim, e)` from `turncoat.ts` **instead of** downing it. `surrender` reverts it at once (same as `remove`
   for that one) and logs "X throws down their tools and begs forgiveness." It must work offline too, so it can't
   be a live-only listener.
5. Check: guards turned turncoat keep their spears. `guardThrow` isn't used by the turncoat behavior. Fine for
   now; note it. `DECK.order` gains `'turncoats'`, completing the five.

**Tests:** 10–15 % of villagers convert (at least 1, never the champion), guards attack a turncoat, monsters don't hunt
or raid turncoats, the champion's spear can hit a turncoat, a turncoat damages a villager, a turncoat beaten to 20 %
surrenders instead of being downed, survivors revert at dawn, and game over doesn't fire while turncoats are the
only villagers left.

### Step 7: Delete the LLM system

- Delete: `src/god/**`, `src/sim/module-runtime.ts`, `src/sim/validator.ts`, `src/sim/ast-check.ts`,
  `src/workers/validator.worker.ts`, `rundot/textGen.config.json` (check that nothing else reads it),
  `test/modules.test.ts`, `test/old/` (already excluded from vitest), the `acorn` dependency.
- `dev/claude-code-middleware.ts`: **don't just delete it.** Move what other dev tools use into a small kept
  `dev/dev-middleware.ts`: `allowed`/`LAN_TOKEN` (imported by `dev/terrain-middleware.ts:~7`) and the
  `/dev-ai/delay` endpoint (the terraformer's `?shot=`, `src/terraformer/main.ts:~12`; rename the path if you like
  and update the caller). Update both `vite.config.ts` and `vite.arena.config.ts`.
- `src/platform.ts`: drop the god providers and `provider`; update `main.ts` (`~117, ~757`).
- `src/ui/ui.ts`: drop the `god/pipeline` type import and the Gods tab code.
- `src/arena/arena-hooks.ts`: update for the new `Island` constructor and `Island.load` signature (`~5, ~18, ~34`).
- Tests: every `Island.create(seed, START, ts, { now })` call (about 10 test files) and `test/helpers.ts`.
- `src/workers/harden.ts`: drop the `harden()` call in `sim.worker.ts`. Keep the `host*` exports (`hostPost` is used by
  `arena-hooks.ts` and the worker), or inline `postMessage` and delete the file.
- `island.ts`: `Island` becomes Sim + save (`SavedWorld = { core }`), no runtime or manifest.
- `protocol.ts`: drop `install`, `creationFailed`, module status messages, `ModuleStat`, `pendingCreations`,
  `creations`, `prayer`. `sim.worker.ts`: drop the matching handlers and HUD fields (`~146–147, ~247, ~285–286,
  ~417–419, ~436–461, ~551–578`).
- `main.ts`: drop the pipeline, `runValidation`, the reference-module imports, `install()`, `showCreation`,
  `readyCreation`, `godLog`, the manual-god panel (`ui.ts:~496`), and the watchdog's "culprit" module logic
  (`~726`). Keep the watchdog itself if it also guards sim stalls.
- `Sim`/types: drop `pendingCreations`, `domainHistory`, `creations`, `missingSystems`, `prayer`,
  `CreationRequest`, `CreationRecord`, `ruleFns`/`damageRules`/`productionRules` (check that they're empty
  everywhere first), `defsVersion` if unused. `favor.ts`: drop `setPrayer`, `allowedDomains`, `DOMAINS`, `scaleFor`
  if unused. Keep `BehaviorEntry` and `behaviors` (Step 6 uses them).
- `test/helpers.ts`: remove the module loader bits.
- Keep: `CORE_SHAPES` and `ShapeDef` rendering, emitters, `listeners`.
- Docs: add a line at the top of `docs/tech-spec.md` and `docs/design-doc.md` saying the creation system was
  replaced by this plan.

**Tests:** the whole suite. Grep for `god/`, `module-runtime`, `pendingCreations` and `creations` and get no hits
outside docs.

---

## Event data (`defs.ts`)

```ts
export const EVENTS: EventDef[] = [
  {
    id: 'long-night', title: 'The Long Night',
    armText: 'Dagon swallows the sun. Tomorrow the dark comes early, and it will not hurry.',
    announce: 'The sun sickens in the sky. The long night is coming.',
    endText: 'The long night ends at last.',
    start: { atHour: 14 }, duration: { untilHour: 9 }, stacking: 'refresh',
    effects: [
      { type: 'darkness', ramp: [[14, 0], [16, 0.95], [6, 0.95], [8.5, 0]] },
      { type: 'clockRate', from: 16, to: 6, rate: 0.6 },   // 14 clock h at 0.6 ≈ 7.8 real min vs 4 for a normal night
      { type: 'atmosphere', fogDensity: 0.08, fogColor: '#1a1f2a' },
      { type: 'windowBonus', hours: 2, reroll: true },
    ],
  },
  {
    id: 'jackals', title: 'Jackal Escort',
    announce: 'Jackals come yipping out of the dark, running at the heels of every beast.',
    endText: 'The jackals slink away at dawn.',
    start: 'now', duration: { until: 'dawn' }, stacking: 'refresh',
    targets: { leaders: { kind: 'monster' } },
    effects: [{ type: 'spawnEscort', who: 'leaders', unit: 'jackal', count: [2, 4], maxFood: 150, awayFoodPerHour: 10 }],
  },
  {
    id: 'frenzy', title: 'Frenzy',
    announce: 'Dagon drinks deep. The monsters go mad with blood.',
    endText: 'The frenzy breaks with the dawn.',
    start: 'now', duration: { until: 'dawn' }, stacking: 'refresh',
    targets: { monsters: { kind: 'monster' } },
    effects: [
      { type: 'statMod', who: 'monsters', stat: 'speed', mul: 1.5 },
      { type: 'statMod', who: 'monsters', stat: 'strength', mul: 1.5 },
      { type: 'fx', who: 'monsters', fx: 'frenzy' },
      { type: 'tag', who: 'monsters', tag: 'no-retreat' },
    ],
  },
  {
    id: 'turncoats', title: 'Turncoats',
    announce: 'Some in the village hear Dagon whisper, and answer.',
    endText: 'With the dawn the turncoats come back to themselves.',
    start: 'now', duration: { until: 'dawn' }, stacking: 'skip',
    targets: { traitors: { kind: 'human', faction: 'human', pick: 'random', fraction: [0.10, 0.15], min: 1, includeHidden: true } },
    effects: [{ type: 'convert', who: 'traitors', to: 'monster', brain: 'turncoat', fx: 'turncoat' }],
  },
  {
    id: 'ascension', title: 'Ascension',
    announce: 'Dagon lays a hand on the mightiest of his children.',
    start: 'now', duration: 'permanent', stacking: 'stack',
    targets: { boss: { kind: 'monster', pick: 'strongest', withoutTag: 'ascended', count: 1 } },
    effects: [
      { type: 'statMod', who: 'boss', stat: 'maxHp', mul: 10 },
      { type: 'healFull', who: 'boss' },
      { type: 'scale', who: 'boss', mul: 1.4 },
      { type: 'rename', who: 'boss', pattern: '{name} the Ascended' },
      { type: 'tag', who: 'boss', tag: 'ascended' },
      { type: 'fx', who: 'boss', fx: 'ascended' },
    ],
  },
];
export const DECK: DeckDef = { order: ['long-night', 'jackals', 'frenzy', 'turncoats', 'ascension'], mode: 'sequential', onExhausted: 'loop' };
```

A test parses every `EventDef` in `DECK.order` through its primitives' `parse`, so a typo in data fails `npm test`,
not the game. (Defs outside the order are checked once their step adds them.)

## Risks

- **Turncoat misclassification (Step 4).** The kind → faction sort is the step most likely to cause subtle bugs. It's
  protected by "no behavior change" plus the full suite, but tests don't cover every site. Play a raid after Step 4.
- **Jackal pathing cost.** 24 extra walkers sharing four repaths per tick. Straight-line movement first. Profile if
  it stutters.
- **Ascension HP on zones.** See Step 2, item 5.
- **Long Night sky.** Twilight colors stay on the clock. Accepted for now.
- **Arena breakage.** Steps 2–6 edit `monster-ai.ts` and `village.ts`, which have sandbox copies, and Step 6 adds
  exports other files import. `arena:sync` + `arena:typecheck` + `arena:test` are part of every step's green.
- **Late-game windows.** The `windowBonus` cap (Step 3) is easy to get subtly wrong. Test it at day 20.
