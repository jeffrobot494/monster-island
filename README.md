# Island Humans and Monsters

A mobile, real-time sandbox on an Iron Age island. You are the village's champion: you hunt six monsters in their
hidden lairs while they hunt your people. Each midnight, the god whose followers sacrificed more favor writes a new
**gameplay module** that permanently changes the world. The god runs on Claude, as in the `monster-island` prototype.

- Design: [`docs/design-doc.md`](docs/design-doc.md)
- Tech spec (with the adversarial-review revisions in §19): [`docs/tech-spec.md`](docs/tech-spec.md)

## Run it

```bash
npm install
dev/serve.sh            # Vite on :5200 (also on the LAN); the log prints a LAN token for the AI middleware
# desktop:  http://localhost:5200/
# phone:    http://<your-pc-ip>:5200/?token=<token from the log>
```

The dev server spawns `claude -p` for each god call (Sonnet decrees, Opus writes the module; override with
`CLAUDE_CODE_PROPOSE_MODEL` / `CLAUDE_CODE_IMPLEMENT_MODEL` in `.env.local`). Calls run as server-side jobs, so
closing the page doesn't waste a call. If the CLI is missing, the game falls back to a manual god.

## How to play

- **Tap** the ground to move. **Tap a monster** to attack. When a **red ring** flashes under it, it is winding up: tap
  away to dash out of the ring.
- A monster beaten to 20 % HP is **downed**. Tap it to **bind** it, then walk it home (villagers nearby help you drag).
  Burn it on the **altar** for favor equal to its full max HP. Or press **Finish** to kill it.
- At the altar you can offer lambs (+40), what you drag, or (forbidden) a villager, and **pray** for tonight's
  creation.
- **Judgment** falls at local midnight. The god with more favor adds a creation, at a scale set by its favor.
- Game time is real time. While you're away, the champion defends the village and the island is resolved hour by
  hour. A "While you were away" report greets you.
- The humans win when all six monsters are dead. The monsters win when no villager (besides the champion) is alive.

## URL parameters (dev)

| Param | Effect |
|---|---|
| `?slot=name` / `?fresh=1` / `?seed=N` | save slot / wipe it / island seed |
| `?timescale=N` | game clock runs N× real time (new islands only) |
| `?at=HH:MM` | new island starts at this local time |
| `?reveal=1` | no fog of war |
| `?god=1` | invincible champion |
| `?ai=manual`, `?manualsrc=war-hounds\|poison-fog` | manual god (optionally auto-answered with a reference creation) |
| `?nogod=1` | don't run the creation pipeline |
| `?judge=human:300` | force a Judgment at boot |
| `?devinstall=war-hounds\|poison-fog` | install a reference creation directly |
| `?script=fight\|downed\|drag\|carry` | dev scenario at boot (for screenshots) |
| `?cam=x,z,dist` | fixed camera |
| `?debug=1`, `?shot=ms` | on-page console; hold the load event (headless screenshots) |

The ⚙ tab also has dev buttons: force a Judgment, skip 8 hours away, install references, toggle fog.

## Code map

- `src/sim/`: deterministic simulation (no DOM). `sim.ts` (state, clock, movement, tick), `village.ts`,
  `monster-ai.ts`, `combat.ts` (zones, downed, death types, XP), `champion.ts`, `favor.ts` (offerings, Judgment),
  `vision.ts` (fog of war, lairs), `offline.ts` (away-time resolver), `island-gen.ts`, `monsters-gen.ts`,
  `module-runtime.ts` (the creation API), `validator.ts`.
- `src/workers/`: the sim worker, and a validator worker for candidate creations (both hardened).
- `src/god/`: decree → implement → validate → repair → install pipeline, prompts, reference creations.
- `src/render/`: three.js terrain (static geometry, fog as a texture, instanced decoration), shapes, rings,
  particles, sky.
- `src/ui/`: the mobile HUD and panels.

## Tests

```bash
npm test                      # generation, determinism, combat, capture loop, Judgment, away resolver, validator
TS=1 DAYS=2 npx vitest run test/smoke.test.ts   # balance: real-time days headless, no player
```
