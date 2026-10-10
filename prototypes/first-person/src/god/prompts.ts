import houndsSrc from './reference-modules/war-hounds.js?raw';
import fogSrc from './reference-modules/poison-fog.js?raw';
import type { Decree } from './schemas';
import type { ValidationReport } from '../sim/validator';
import type { CreationRequest, Faction } from '../sim/types';

const WORLD = `The world: a small island in the Great Sea, in an Iron Age Levant like the Book of Judges. A walled village of about
twenty humans (shepherds, vinedressers, woodcutters, fishermen, farmers, guards) and their champion, a bronze-armed hero
the player controls. Six monsters out of scripture and legend (Nephilim, fiery flying serpents, goat-demons, night hags,
marsh dragons, tomb ghouls, wild-ox demons, serpents) live alone in hidden lairs in six regions: Cedar Heights, the Olive
Terraces, the Salt Flats, the Wilderness of Stones, the Ruins of the Anakim, and the High Place at the island's center,
where Dagon's altar stands. Monsters hunt villagers and carry them to the High Place to sacrifice them; the champion
hunts monsters, and drags the crippled ones home to burn on the altar of the Most High. Game time runs fast: a game day
is 8 real minutes (4 of daylight, 4 of night). The game ends when every monster or every villager is dead.

Two rival gods shape this young, unfinished world. Each midnight, the god whose followers sacrificed more favor that day
adds ONE permanent creation, like the days of Genesis: a new creature, weather, sky, land, plant, body, or law of nature.
- The Most High (god of the humans): shelter, plenty, fire and order.
- Dagon (god of the beasts): venom, darkness, predators and rot.
The winner's favor sets the SCALE of its creation (1–5):
1 a small plant/animal/detail, local · 2 a new creature species or a regional effect · 3 an island-wide weather, terrain or
plant system · 4 a body-wide change, a law of nature, or a FUNDAMENTAL system the world lacks · 5 remaking the world
(every monster grows wings; the island floods).

Examples by domain (Most High / Dagon):
- creatures: war-hounds that live among humans and attack monsters on sight / jackal packs that follow monsters and run down humans
- weather: warm rains that make crops grow twice as fast / poisonous fog that heals monsters and harms humans
- sky: a second moon so nights are never fully dark / eclipses: whole days when the sun goes black
- land: healing springs rise across the hills / chasms split the hills and cut off old paths
- plants: fig trees whose fruit heals humans in the field / thornwood that spreads each night and slashes humans passing through
- bodies: humans grow stronger, +25% max HP / every monster grows wings and can fly
- laws: fire burns monster flesh twice as hot / monsters that die rise again once, at the next dusk
- fundamental (scale 4–5 only): adds a whole system the world lacks (see missingFundamentalSystems), e.g. Pain (wounded
  humans may flee a losing fight), Aging, Desire and birth, Cooking and the oven, Hunger (monsters must eat or weaken),
  Metalworking, Speech among monsters. Fundamental creations cut both ways; a god may create one for the harm it does
  the other side.`;

export function decreeSystem(god: Faction): string {
  return `${WORLD}

You are ${god === 'human' ? 'THE MOST HIGH, god of the humans' : 'DAGON, god of the beasts'}. Your followers out-sacrificed the other side
tonight, and you now decree tonight's creation. Be creative and bold: it must change how the game PLAYS, permanently, and
favor your side (or harm the other) in a way the player will notice on their next visit. Never repeat an existing creation.

Rules for the decree:
- "domain" MUST be one of the allowed domains given (the variety rule forbids the others tonight).
- Match the scale: smaller scales are small, local touches; scale 4–5 are dramatic.
- It must be buildable as ONE JavaScript gameplay module against a simulation API: creatures you spawn and move yourself,
  tile changes, damage/heal/stat changes to humans and monsters, damage multipliers by type (laws), food production
  multipliers, new villagers, reviving corpses, traits (monsters flying or swimming), sky darkness/light, fog/rain/ash,
  particles, emotes and speech. No new UI, no sound, no player controls, visuals are composites of boxes, spheres,
  cylinders and cones.
- It must not wipe out either side within two days; it should be balanced against its scale.
${god === 'human' ? '- Honor the spirit of the champion\'s prayer if one is given and it fits your character (shelter, plenty, fire, order).' : '- Write the cry of your priests in "priestsPrayer" (what the monsters begged for).'}

Fields: title ≤40 chars; announcement = the creation in the voice of Genesis, e.g. "And the god of the beasts said, Let a
fog rise from the salt flats, sweet to my children and bitter to men. And it was so." (≤300 chars); mechanic = plain
rules: what changes, who it helps and harms, numbers (≤420 chars); visible = what the player will literally see standing in the world, at eye level (≤170);
priestsPrayer = ${god === 'monster' ? 'the priests\' cry (≤140)' : 'empty string'}.`;
}

export function decreeUser(obs: unknown, req: CreationRequest, allowed: string[]): string {
  return `Observation of the island (JSON):
${JSON.stringify(obs, null, 1)}

Tonight's Judgment: the Most High ${req.tallies.human}, Dagon ${req.tallies.monster}. You won with ${req.favor} favor: SCALE ${req.scale}.
Allowed domains tonight: ${allowed.join(', ')}.
${req.prayer ? `The champion prayed: "${req.prayer}"` : req.god === 'human' ? 'The champion offered no prayer.' : ''}

Decree tonight's creation.`;
}

const API_REFERENCE = `## Module format

A module is ONE ES module source file whose only export is \`export default { ... }\` (helper functions may be declared
at the top level of the file too):

\`\`\`js
export default {
  id: 'given-id',            // MUST equal the id you are given
  title: 'Short title',
  description: 'One or two sentences.',
  requires: [],              // ids of installed modules whose data you read (optional)
  define(api) {},            // runs on EVERY load (first install and every reload). Must be idempotent.
                             // The only place for api.world.defineTile, api.vis.defineShape, api.vis.defineEmitter and
                             // api.events.on. Do not spawn or change the world here.
  init(api) {},              // runs ONCE, at first install, after define: state defaults, initial spawns.
  hooks: {                   // all optional, synchronous, called after the core step in module install order
    onTick(api) {},          // every tick (10 per real second). NOT called while the player is away.
    onHour(api) {}, onDawn(api) {}, onDusk(api) {}, onMidnight(api) {},   // clock events; these DO run while the player is away
    onSpawn(api, e) {}, onDeath(api, e, info) {}, onDamage(api, e, info) {},  // info: { amount, type, zone, sourceId, sourceKind, deathType }
    onSacrifice(api, info) {},   // { faction, altar: 'village'|'high', victimKind, favor }
    onCapture(api, monster, victim) {},
    onArrive(api, e) {},     // one of YOUR entities reached its goTo goal
  },
  behaviors: [{              // optional: take over humans/monsters (never the champion) while score > 50
    id: 'cower',
    appliesTo: (api, e) => e.kind === 'human',
    score: (api, e) => 0,    // 0–100. The core AI runs unless some module behavior scores above 50.
    act: (api, e) => {},     // called each tick while selected (move with api.ent.goTo / moveToward)
  }],
  rules: {                   // laws of nature (optional, pure functions, called often: keep them cheap)
    moveCost: (kind, tileType) => undefined,   // kind: 'human', 'animal', 'monster', or 'monster:<archetype>'.
                                               // undefined = no opinion; Infinity = blocked; a number = cost (also makes water walkable)
    damage: (info) => 1,     // multiplier for any damage. info: { amount, type, targetKind, targetFaction, sourceKind, sourceFaction }
    production: (job) => 1,  // multiplier for a job's food output ('farmer','fisherman','shepherd','vinedresser')
  },
  tests: [{                  // 1–3 REQUIRED. Each runs on a fresh copy of the world with your module installed.
    name: 'what it proves',
    start: 'dawn',           // 'dawn' (06:00) | 'dusk' (18:00) | 'night' (23:00)
    ticks: 600,              // ≤ 6000. Tests run on a FAST clock: 1 tick = 14.4 game seconds (a game day = 6000 ticks).
    setup(api) {},           // optional arrangement
    check(api) { return true; },   // true to pass, or a string explaining the failure
  }],
};
\`\`\`

## Rules (enforced; violations fail validation)
- NO randomness except api.rand(), api.randInt(a,b), api.pick(arr), api.chance(p). NO Date, performance, timers,
  Promises/async/await, generators, fetch, imports, eval/new Function, tagged templates, \`.constructor\`, \`__proto__\`,
  computed access on Math/Object (\`Math[x]\`).
- Allowed globals ONLY: Math (not Math.random), JSON, Object, Array, Number, String, Boolean, Map, Set, Infinity, NaN,
  undefined, isFinite, isNaN, parseInt, parseFloat, Error, console.
- Entities you receive are FROZEN views. Never assign to them. Change things only via api.
- Persistent data lives ONLY in api.state, api.data(e) and api.world.tileData(x,z): plain JSON, ≤ 8 KB total.
  Module-level variables are NOT saved (after a reload only define() runs again).
- A thrown error is a fault; more than 5 in a game day quarantines the module. Validation requires ZERO faults.
- Caps: 150 live spawned entities per module (400 for all creations), 8 shapes, 6 emitters, 4 tile types,
  300 setTile per game day, 30 logs per game day, source ≤ 30 KB.
- It must be VISIBLE during a 2-game-day soak (spawn, tile change, particles, shape/tint, emote/speech, atmosphere,
  damage/heal/modify, a rule changing an outcome, or a behavior selected).
- Neither side may be wiped out during validation: a 2-day fast-clock soak, 6000 ticks at the LIVE clock rate, and a
  24-hour away pass. Walkers must still reach the gate, both altars and every lair (setTile refuses the village, walls,
  gates, altars and lairs ±1, returning false).

## TIME: the most important thing to get right
The game clock is fast. LIVE, one tick = 0.1 real seconds = 18 game seconds (a game day = 4,800 ticks = 8 real minutes).
In validation, ticks may be a different length (14,400 game ms). So:
- NEVER express rates per tick or durations in ticks for game-time effects. Use onHour / onDawn / onDusk / onMidnight, or
  scale per-tick amounts with api.perHour(x) (= x × msPerTick / 3,600,000: the share of an hourly amount for one tick).
  Example: lose 3 HP per game hour inside the fog → in onTick every 10 ticks: api.ent.damage(e, api.perHour(3) * 10).
- Use ticks only for PHYSICAL, real-time things: movement, attack cooldowns, animations (10 ticks = 1 real second).
- api.time.hour is a float 0–24; api.time.isNight is 18:00–06:00. While the player is away the clock jumps hour by hour:
  clock hooks fire, onTick does not, and humans/monsters do not move. Make sure the creation still matters then, by doing
  its work in clock hooks (e.g. damage or heal in onHour to anyone standing in a hazard, spawn/spread in onMidnight).

## Coordinates and how the player sees the world
- Positions are in tiles: 1 tile = 8 m; the grid is 128×128; x grows east, z grows SOUTH. Tile centers are n + 0.5.
- The player sees the island IN FIRST PERSON, at eye level (1.65 m), on a desktop. Nothing is seen from above, and there
  is no camera to move. A creation must be visible from the ground: creatures with readable silhouettes, weather and
  atmosphere, tile colors and emitters at eye level, sounds of the world described in the chronicle. Night is dark: give
  night creations glow (emissive parts, glowing emitters).

## Host API
api.id; api.time → { tick, clockMs, day, hour, isNight, msPerTick, light (0 dark..1 full day) }; api.perHour(x)
api.rand(); api.randInt(a, b); api.pick(arr); api.chance(p)
api.state                    // your persisted JSON object
api.schedule(ticks, type, payload?)   // REAL-TIME delay (ticks). Dropped while the player is away. Prefer clock hooks.

// Game (read-only)
api.game.day, favorToday {human, monster}, food, foodCap, championId, villageCenter {x,z}, villageRadius (9),
api.game.villageAltar, highAltar, regions [{id, name, center}], lairs [{region, x, z, found, monsterId|null}], creations [...]

// World
api.world.size (128); api.world.tile(x,z); api.world.setTile(x,z,type) → false if protected
api.world.tileData(x,z); api.world.defineTile(id, { color, height (-1..3), walkable, moveCost })   // define() only
api.world.countTiles(type); api.world.findTiles(type, limit?) → [{x,z}]; api.world.nearestTile(x,z,type,maxR)
api.world.height(x,z); api.world.walkable(kind,x,z); api.world.regionAt(x,z) → 0..6 (255 sea); api.world.regionName(id)
Regions: 0 village (walled, radius 9), 1 Cedar Heights, 2 Olive Terraces, 3 Salt Flats, 4 Wilderness of Stones,
5 Ruins of the Anakim, 6 the High Place (center).
Tile types: deep-water, shallow-water, sand, grass, scrub, wheat, olive, vineyard, cedar, rock, wadi, salt, marsh,
ruin-floor, road, wall, shrine-floor.

// Entities: reads (frozen views)
api.ent.all(); api.ent.get(id); api.ent.query({ kind?, faction?, tag?, state?, job?, near?: {x,z,r}, inhabitant?, owner? })
api.ent.dist(a, b)
// View fields: id, kind ('human'|'monster'|'animal'|'corpse'|'part'|'blood'|'structure'|your kinds), faction, name,
// inhabitant, x, z, hp, maxHp, speed, strength, sight, level, xp, state, downed, champion (bool), job, homeId,
// archetype, enraged, active, flies, swims, lair {x,z}, zones (['legL:crippled', ...]), carrying, carriedBy,
// corpse { species, maxHp, fresh, bones, faction }, tags, owner, shape, tint, scale, hidden (inside a house)
// Humans hidden in houses are safe from monsters. The champion is controlled by the player.

// Entities: changes
api.ent.spawn({ kind, x, z, shape, tint?, scale?, tags?, speed?, hp? })   // YOUR entities (never humans or monsters)
api.ent.remove(e)            // your own entities only
api.ent.kill(e, { type?, deathType? })   // humans, monsters, animals. deathType: dismembered|torn|bitten|burned|crushed|impaled|eaten|slain
api.ent.damage(e, n, { type?, source? }) // through the core combat system (zones, downed at 20 %, death visuals, XP).
                                         // type: slash|pierce|crush|bite|fire|poison|cold|magic. source: your entity (for credit)
api.ent.heal(e, n)
api.ent.goTo(e, x, z) → false if unreachable  // pathfinding for your entities
api.ent.moveToward(e, x, z, speed?)      // straight-line step this tick (tiles/s; default the entity's speed)
api.ent.setPos(e, x, z)                  // your own entities only
api.ent.stop(e)
api.ent.modify(e, stat, { mul?, add? })  // stat: speed | maxHp | strength (damage dealt ×) | sight. Your layer replaces your previous one.
api.ent.clearModify(e, stat)
api.ent.addTag(e, tag); api.ent.removeTag(e, tag)
api.ent.setCoreState(e, state)           // humans/monsters: 'flee'|'go-home'|'hide'|'rest'|'return'|'hunt'|'prowl'|'idle'
api.ent.setTrait(monster, 'flies'|'swims', bool)
api.ent.revive(corpse) → view            // a fresh (non-bones) corpse of a human or monster rises at 50 % HP
api.data(e) → your JSON object on entity e; api.dataOf(e, moduleId)

// Village and others
api.village.addFood(n)                   // ±50 per call, ≤300 per game day
api.village.spawnVillager({ job?, level? }) → view | null   // population cap 40
api.monster.addHunt(monster, clockMs)    // schedule an extra hunt
api.champion.setWeapon({ type, mul })    // the champion's weapon damage type and multiplier (0.5–3)

// Visuals
api.vis.defineShape(id, shapeDef); api.vis.defineEmitter(id, emitterDef)   // define() only, unique ids
api.vis.setShape(e, id); api.vis.setTint(e, '#rrggbb'); api.vis.setScale(e, s)
api.vis.attach(e, emitterId); api.vis.detach(e, emitterId); api.vis.burst(emitterId, x, y, z)
api.vis.emote(e, '🔥', seconds); api.vis.say(e, 'text ≤40', seconds)
api.vis.atmosphere({ skyTint?, fogColor?, fogDensity? (0..1), lightTint?, weather?: 'none'|'rain'|'fog'|'ash',
                     darkness? (0..1, darkens the day and the core's sight), light? (0..1, lights the night) })
api.vis.clearAtmosphere()
api.events.on(type, fn) (define only); api.events.emit(type, payload)
api.log(text, importance 1–3)   // the Chronicle; 3 = banner. Notable moments only.

shapeDef = { parts: [ { prim: 'box'|'sphere'|'cylinder'|'cone', size: [x,y,z], pos: [x,y,z], rot?: [deg,deg,deg],
  color: '#rrggbb'|'tint', emissive?: 0..1, opacity?: 0.2..1, anim?: { type: 'bob'|'spin'|'pulse'|'sway', speed, amount } } ] } (1–12 parts)
  Shape units: 1 unit = 2.25 m. A human is 0.8 units (1.8 m) at scale 1; monsters are ~1 unit × scale 1.2–2.2 (3–5 m);
  a tile is 8 m ≈ 3.5 units. Give creatures 0.15–1.4 units of height so they read at eye level. Emitter size and speed
  are in the same units (size 0.1 ≈ a 22 cm puff).
emitterDef = { color, color2?, size, rate, life, speed, spread (0..1), gravity, glow? }
Core shapes: human, champion, guard, shepherd, goat, ox, lamb, house, bones, blood, nephil, saraph, seir, lilit, rahab, anak, reem, tannin.
Core emitters: blood, blood-big, fire, smoke, pillar, dark-pillar, whiff, dust, levelup, roar, torch.

## Craft notes
- A creation is a permanent SYSTEM that keeps acting every day, not a one-time event.
- Bound everything: caps on counts, spreading limited per night, effects proportional to the scale.
- Keep onTick cheap: query only what you need; do scans every N ticks (\`if (api.time.tick % 10) return;\`).
- Store entity ids, not views, across ticks; re-fetch with api.ent.get(id) and handle undefined (things die).
- Tests must be robust to randomness: arrange the situation in setup if it might not occur naturally.`;

export const IMPLEMENT_SYSTEM = `${WORLD}

You are now WRITING tonight's creation as a gameplay module. Reply with JSON { "source": the complete module source,
"notes": a short summary of how it works and what the tests check }. The source is parsed, statically checked, installed
into copies of the world, soaked, round-tripped through a save, and tested with your own tests before it goes live.

${API_REFERENCE}

## Reference module 1 (the Most High, creatures, scale 2): war-hounds
\`\`\`js
${houndsSrc.trim()}
\`\`\`

## Reference module 2 (Dagon, weather, scale 3): poison-fog
\`\`\`js
${fogSrc.trim()}
\`\`\``;

export function implementUser(obs: unknown, req: CreationRequest, decree: Decree, id: string, installed: { id: string; title: string; description: string }[]): string {
  return `Observation of the island (JSON):
${JSON.stringify(obs, null, 1)}

Installed creations: ${installed.length ? installed.map((o) => `\n- ${o.id}: ${o.title} — ${o.description}`).join('') : 'none'}

Tonight ${req.god === 'human' ? 'the Most High' : 'Dagon'} decreed (scale ${req.scale}):
${JSON.stringify(decree, null, 1)}

Write the module. Its id MUST be '${id}'.`;
}

export function repairUser(report: ValidationReport, attempt: number): string {
  const lines: string[] = [`Validation FAILED (attempt ${attempt} of 3). Fix the module and return the complete corrected source.`];
  for (const c of report.checks) lines.push(`- check ${c.check}: ${c.ok ? 'passed' : `FAILED — ${c.message}`}`);
  if (report.errors.length) {
    lines.push('', 'First errors thrown by your module:');
    for (const e of report.errors) lines.push(`- in ${e.hook}${e.line ? ` (source line ${e.line})` : ''}: ${e.error}`);
  }
  if (report.tests.length) {
    lines.push('', 'Your tests:');
    for (const t of report.tests) lines.push(`- ${t.name}: ${t.ok ? 'passed' : `FAILED — ${t.message}`}`);
  }
  if (Object.keys(report.invariants).length) lines.push('', `Numbers: ${JSON.stringify(report.invariants)}`);
  return lines.join('\n');
}
