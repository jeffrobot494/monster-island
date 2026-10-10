# Island Humans and Monsters — MVP Game Design Doc

Oct 9, 2026 · @Bo Banducci

## Overview

The MVP is a small mobile sandbox simulation on an island in a biblical, swords-and-sandals world, where the player, as his village's champion, hunts down mythical monsters in their lairs while the monsters hunt his people, and two rival gods, fed by their followers' sacrifices, shape the young world in their own image, night after night. It ends only when one side has killed every member of the other.

**Pitch.** You are the champion of a small Iron Age village on an island in the Great Sea: bronze swords, leather sandals, sheepfolds and olive presses. The hills are haunted by creatures out of scripture and ancient legend: Nephilim giants, fiery flying serpents, goat-demons of the wilderness. They live alone in caves, tombs and ruins, but they know each other, visit each other and share one goal: to wipe your people off the island.

Two rival gods watch over this young, unfinished world, one for the humans and one for the monsters. Both sides earn their god's favor the same way: sacrifice. The monsters drag villagers to their altar on the High Place; you bring lambs, goats and, if you can, the monsters themselves to yours. Each night, the god whose followers offered more favor shapes the world in its own image, adding something permanent: a new creature, a new kind of weather, a new law of nature.

### Setting and tone

- **Era:** an Iron Age Levant in the spirit of the Book of Judges. No kings yet, only champions, elders and tribes.
- **Look:** linen tunics, sandals, bronze and early iron, mudbrick and dressed stone, cedar, olive and vine.
- **Creatures:** drawn from the Hebrew Bible and ancient Near Eastern myth, then pushed toward the horrifying.
- **Sound:** lyres, frame drums, chanted laments, and the shofar as the village's alarm.
- **Tone:** grim and epic, sacred and brutal, like the stories of Samson, Gideon and David and Goliath.

### Design pillars

1. **Hunt and be hunted.** While you are out hunting a monster, other monsters may be hunting your villagers.
2. **The world is still being made.** Every night a god adds something permanent to it. No two islands end up alike.
3. **Everything with hit points is currency.** Favor comes from sacrifice, and sacrifice is scaled by HP, from goats to giants to your own villagers.
4. **Spectacular violence.** Deaths are visceral, specific and spectacular.

### MVP goals

- Prove the core loop (explore, find lair, kill monster) is fun across a full game, played over about two weeks of real time.
- Prove the nightly creations make the island grow in surprising directions that players look forward to each night.

### Out of scope for MVP

- Multiplayer (either faction played by another human).
- Monster "special occasion" gatherings beyond the lair-visit system.
- More than one island or biome set.
- Console builds and controller-first UI.
- Prompt-driven villager behavior (talking to a villager and typing a new behavior for him), planned for a later release.

## Platform

The game is mobile only. The camera is top-down, and the player taps to move. Combat is core to the game and has to be fun; its design comes later.

## Core loop and session structure

A game has no day limit: the humans win when every monster is dead, and the monsters win when every villager is dead. Game time is real time: a game day is a real day, and Judgment falls at midnight in the player's time zone.

### Core loop

1. **Explore** the island from the village outward, revealing terrain, resources and monster lairs.
2. **Find a lair**. Lairs are hidden until the player stumbles on one.
3. **Kill the monster**, ideally alone, before a neighbor visits.
4. **Sacrifice it:** drag the carcass, or better the crippled monster itself, home to your altar. Sacrifice is the only way to earn favor.
5. **Defend and manage** the village between hunts: rescue kidnapped villagers, reassign jobs.

### Real-time days

The game clock is the real clock. Anything can happen at any hour.

- **Monster hours:** each monster keeps its own habits: day hunters, night hunters, dusk-and-dawn stalkers, and restless ones that strike at any time. Learning a monster's hours is part of hunting it.
- **Villager routines:** villagers work by daylight and sleep at night by default, but shepherds, fishermen and guards are always out somewhere.
- **Light matters:** night cuts visibility and makes torches and fire count.
- **Judgment at midnight:** the only fixed moment of the day. The new creation is waiting the next time the player opens the game.
- **While the player is away:** the champion stays in the village and defends it.
- **Checking in:** players drop in a few times a day to hunt, rescue captives and make sacrifices.

### Win, loss and pacing

- **Humans win:** every monster on the island is dead.
- **Monsters win:** every villager is dead, whether slain or sacrificed. The champion cannot hold the island alone, and with no villagers left, no one can take up the role if he falls.
- **No stalemates:** every day a game runs, monsters grow bolder: they roam farther, they raid more often and they stay active for more hours. Pressure keeps rising until one side is wiped out.
- **Champion death:** the champion is dead for good. A villager is chosen at random to become the new champion, and the player takes control of him at the next dawn.
- **Target pacing (a guide, not a rule):** first lair found on Day 1 or 2, first kill by Day 3, a typical game decided within 10 to 15 days.

## Player: the Village Leader

The player directly controls the champion and oversees the village without micromanaging it.

The hero never eats, farms or builds. His jobs are hunting monsters, protecting villagers and making the calls only a leader makes: who goes where, what gets sacrificed, what to pray for.

### Experience and levels

Every human and every monster earns XP and levels up. A level raises max HP, and a monster that levels up also grows physically bigger.

|  | Humans (champion and villagers) | Monsters |
| --- | --- | --- |
| Earn XP by | Damaging and killing monsters, surviving each day | Damaging, capturing and killing humans, sacrificing captives at the High Place |
| Gain per level | More max HP | More max HP and a bigger body: taller, heavier, longer reach |
| Starting values for tuning | 60 HP at level 1, +20 per level | Base HP and size set by the monster generation system, +10% HP and +5% scale per level |

- The champion levels like any villager. When a new champion is chosen at random, he keeps his own level, so losing a veteran champion hurts.
- Because sacrifice favor equals max HP, levels raise the stakes on both sides: a veteran villager is a richer offering, and a monster left alive too long grows into a bigger threat and a bigger prize.

## Human village sim

The village runs itself so that villagers are constantly spread across the island, and every one of them out past the fences is a target.

### Villagers

- **Start:** 20 villagers. Population cap 40.
- **Stats:** HP (by level), job, home, name. Each villager has a short generated bio so losses feel personal.
- **Levels:** villagers earn XP and level up (see Experience and levels). Higher level = more HP, and a bigger prize for monster sacrifice.
- **Growth:** one new villager every 2 days if the food store is above 50% of capacity.

### Jobs and risk

| Job | Works where | Output | Risk |
| --- | --- | --- | --- |
| Shepherd | Hills and wilderness, follows the flock to pasture | Wool, milk, lambs for offerings | High: ranges farthest, often out at dusk |
| Vinedresser | Olive terraces and vineyards | Olives, wine, oil for lamps and balm | Medium |
| Woodcutter | Cedar heights | Timber for walls and crafting | Medium |
| Fisherman | Harbor and shoreline | Fish | Medium: the shore runs past the salt flats |
| Farmer | Wheat and barley fields beside the village | Grain | Low, unless fields expand outward |
| Guard | Assigned post on the walls | Slows raids, sounds the shofar | Varies |

Food is the only economy the player must watch. As pasture and fields near the village are exhausted, shepherds and vinedressers travel farther, which is the pressure that drags villagers into monster territory.

## Monsters

Each game has six monsters, each living alone in a hidden lair, each tied to the others by a friendship graph that drives visits, ambushes and revenge.

### Lairs

- One lair per island region (see World). Each holds a sleeping spot, a bone pile and a food cache.
- Lairs are hidden in caves, tombs and ruins until the player finds them by exploring.
- A dead monster's lair stays empty for the rest of the game.

### Social graph and visits

- Every monster has 2 to 3 "neighbors" it visits. On any given day, each monster has a 30% chance to visit a neighbor at some point in the day.
- A monster in combat roars. Any neighbor within 400 m who hears it comes running, arriving in 30 to 90 seconds.
- When a monster dies, its neighbors become **enraged** for 2 days: +25% damage, and they raid the village directly instead of picking off stragglers.
- This makes kill order a strategic choice: kill isolated monsters first, or cut the hub of the graph and face a furious island.

### Hunting and sacrifice behavior

1. During its active hours, each monster picks a hunting ground weighted toward where villagers are working.
2. It stalks, then grabs a lone or slow villager (a grab is a capture, not a kill, unless the villager fights back).
3. It carries the captive toward the **High Place at the island's center**. Carry speed is 70% of normal, and the captive's screams are audible to the hero within 150 m.
4. If it reaches the altar, it performs the sacrifice: favor equal to the captive's max HP goes to the monster faction.
5. If the hero intercepts, the monster drops the captive to fight or flees.

Monsters also sacrifice goats and wild animals when no villager is available, at a lower favor value. They prefer high-level villagers and will target the hero if he is weakened (hero max HP = big favor).

### Monster generation

Monsters are created by a monster generation system.

## Favor, sacrifice and the two gods

The island is young and still being made. Two rival gods are shaping it, one for the humans and one for the monsters, and every night the god whose followers offered more favor that day adds something permanent to the world; if the totals are tied, both gods rest.

Sacrifice is the only source of favor.

### The two gods

|  | Human god | Monster god |
| --- | --- | --- |
| Working name | The Most High | Dagon |
| Altar | The village altar | The High Place |
| Who prays | The player, in free text at the altar | The monsters' priests |
| Character of their creations | Shelter, plenty, fire and order | Venom, darkness, predators and rot |

### Earning favor

Favor is tallied per faction per day and resets to 0 after Judgment. A sacrifice is worth the victim's **max HP**, so bigger is better.

- **Live creature at an altar:** 100% of its max HP.
- **Fresh carcass (died today):** 50% of its max HP.

Reference HP values: lamb or goat 40, wild ox 80; humans and monsters by level (see Experience and levels).

### What each side offers

- **Humans, lambs and goats:** the everyday burnt offering, cheap, safe and low value. The village sheepfold holds 6 animals and regrows 1 per day.
- **Humans, monsters:** the jackpot. A live, crippled monster is worth its full HP; netting a giant and dragging it to the altar in chains is the highest-skill play in the game. Nearby villagers pitch in to drag it faster.
- **Humans, their own villagers:** allowed, but treated as the forbidden offering: the village elder publicly condemns the champion. This is the desperate option, not the default.
- **Monsters, villagers:** their main offering. They prefer high-level villagers, who are worth more.
- **Monsters, the champion:** a champion beaten down but not yet dead can be dragged to the altar alive, worth his full max HP. His sacrifice is his death, and a new champion is chosen as usual.
- **Monsters, beasts:** lambs, goats and wild animals when no villager is in reach.

### Judgment rules

1. Judgment falls at midnight each day. Play does not pause.
2. The two factions' favor totals for that day are compared.
3. The higher total wins: that faction's god adds a new creation to the world, shaped by its prayer.
4. An exact tie, including 0 to 0, means both gods rest and nothing is added.
5. Both totals reset to 0.
6. **Variety rule:** a god may not shape the same domain (the rows of the creation examples table) twice within 3 nights, so the island keeps growing in new directions instead of piling up weapons.

### Shaping the world

A creation is a permanent addition to how the world works, like the days of Genesis: new creatures, new weather, new land, new laws of nature. Each one changes the game itself, so the gods should be creative and bold.

Each creation is announced in the voice of Genesis, for example: "And the god of the beasts said, Let a fog rise from the salt flats, sweet to my children and bitter to men. And it was so."

### Creation examples

| Domain | Human god | Monster god |
| --- | --- | --- |
| Creatures | War-hounds that live among humans and attack monsters on sight | Jackal packs that follow monsters and run down humans |
| Weather | Warm rains that make crops grow twice as fast | Poisonous fog joins the weather cycle: it heals monsters and harms humans |
| Sky | A second moon, so nights are never fully dark | Eclipses join the cycle: whole days when the sun goes black |
| Land and water | Healing springs rise across the hills | Chasms split the hills and cut off old paths |
| Plants | Fig trees whose fruit heals humans in the field | Thornwood that spreads each night and slashes any human passing through |
| Bodies | Humans grow stronger: +25% max HP at every level | Every monster grows wings and can fly |
| Laws of nature | Fire burns monster flesh twice as hot | Monsters that die rise again once, at the next dusk |

### Fundamental creations

The deepest creations do not add a thing to the world; they add a whole system the game did not have before. A creature that cannot feel pain learns to; a people who cannot bear children gain the urge and the means; an island floating in emptiness gains a sea.

| Creation | What changes in play | The double edge |
| --- | --- | --- |
| Desire and birth | Humans want to pair off and can bear children; the village can grow on its own | Couples linger at home, and children are helpless and must be guarded |
| Pain | Wounded humans feel it and may break off a losing fight and run | Fewer deaths, but fighters abandon the champion when it gets bad |
| Aging | Humans grow from child to elder and die of old age | Elders are frail, and the old die off |
| The ocean | The emptiness around the island fills with sea | Shorelines, fishing and boats become possible, and so do things that live in the deep |
| Cooking and the oven | Humans can build ovens and cook food | Cooked food feeds more and heals; ovens also start fires |
| Night | A world of endless light gains darkness | Visibility, torches and night hunters all become possible |
| Hunger | Monsters must eat or weaken | They hunt more often, but a starving monster can be outlasted |
| Sleep | Every creature must sleep | Both the village and the lairs gain hours of real vulnerability |
| Metalworking | Humans can smelt bronze and iron | Better weapons, but mines and forges pull people far from home |
| Speech among monsters | Monsters can talk to each other | Coordinated raids and calls for help across the island |

Many fundamental creations cut both ways, and a god may create one for the harm it does the other side. Pain could be the monster god's gift, meant to make humans flee; it is also what keeps them alive. Fundamental creations sit at the top of the scale (4 or 5), so a god only creates one after a night of heavy sacrifice.

### The unfinished world

For the gods to add fundamental systems, the starting world must lack them. The MVP island begins without some of the things players take for granted, and each night may fill one of those gaps. Which systems start missing is a choice still to make; each choice reshapes other parts of this doc, such as villager population growth or the fishermen and harbor.

**Scale of creation.** The winning god's favor total that night sets how big its creation is, on a scale of 1 to 5, from a small new detail to a remaking of the world. A lamb on the altar buys a new kind of weed; a giant and a veteran champion on the altar in one night can give every monster wings.

| Favor that night (starting values) | Scale | Example |
| --- | --- | --- |
| Under 100 | 1 | A new plant or small animal |
| 100 to 299 | 2 | A new predator species |
| 300 to 599 | 3 | Poisonous fog joins the weather cycle |
| 600 to 999 | 4 | Humans learn to feel pain |
| 1,000 or more | 5 | Every monster grows wings; an ocean fills the emptiness |

## When the game ends

When one side is wiped out, the game is over. A new game starts on a new island: a fresh world, new monsters and an empty Book of Creation.

## Violent death system

Deaths are built from a hit-zone damage model plus a library of death types, so the same system handles a villager torn apart by a monster and a monster's leg taken off by the hero's axe.

### Damage model

- Every humanoid and monster has zones: head, torso, and each limb (monsters add their signature limb).
- Each zone has its own HP. A zone at 0 is **crippled**; a zone taking a heavy hit while crippled is **severed** or **destroyed**.
- Damage types: slash, pierce, crush, bite, fire. Each type leaves its own kind of wound.
- Severed parts stay where they fall for the rest of the day, then rot down to bones.

### Death types (MVP set)

| Death type | Trigger | Visual result |
| --- | --- | --- |
| Dismemberment | Slash or heavy hit on a crippled limb | Limb severs, blood spray, victim may keep crawling briefly |
| Torn apart | Grapple kill by large monster | The monster rips the body in two at the torso |
| Bitten | Bite damage | A chunk torn out of the body, leaving a bite-shaped wound |
| Burned alive | Fire damage over time | Panic run, blackening skin, collapse, smoking corpse |
| Crushed | Crush damage over threshold | Body flattened, limbs bent the wrong way |
| Impaled | Pierce from blade limbs or spears | Victim lifted on blade, then thrown |
| Eaten | Monster feeds on a downed body | Body visibly consumed over 20 seconds; partial remains |

## World

The MVP island, set in the Great Sea, is about 1 km across, split into seven regions, six of which hold a lair, so a full traverse takes roughly 2 minutes at a sprint.

### The island

| Region | Terrain | Lair | Village risk |
| --- | --- | --- | --- |
| Village and harbor | Mudbrick houses, walls, wheat fields, sheepfold | None (human altar here) | Safe by day |
| Cedar Heights | Cedar forest on steep hills | Cave beneath the roots of a giant cedar | High (woodcutters, shepherds) |
| Olive Terraces | Olive groves, vineyards, wine presses | Abandoned wine-press cave | Medium (vinedressers) |
| Salt Flats | Salt marsh, pillars of salt, tidal pools | Sunken cistern | Low traffic, deadly |
| Wilderness of Stones | Dry wadis, cliffs, rock-cut tombs | Cliff tomb | Medium (shepherds in the dry season) |
| Ruins of the Anakim | Fallen city walls, giant-sized stones | Ruined giant's hall | Low |
| The High Place | Hilltop shrine and altar, sacred grove | Catacomb under the shrine | Captives pass through |
