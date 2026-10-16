# Night events: implementation notes

Implemented the five-event deck from [the plan](night-events-plan.md): Long Night, Jackal Escort, Frenzy, Turncoats, Ascension. Monster victories draw; human victories and ties do not. The sequential deck loops, with shuffle order persisted when shuffle mode is selected.

- Surviving turncoats surrender at or below 20% HP; lethal hits still kill. Offline turncoats remain on the monster team, cannot be monster prey, and do not produce food. They still eat and count as villagers for game over.
- Event tags track multiple owners independently from core tags. Refresh extends the existing instance without applying its effects again.
- Entity effects, targets, escort state, history, and deck position/order survive saves. Schema 4 deliberately starts a new island for older saves.
- Clock-rate changes affect live ticks and production/healing rates. The abstract offline resolver uses undilated clock time. Countdown estimates include already armed Long Nights.
- Jackals share one event-wide theft allowance. They cannot gain levels or be downed, and their corpses provide no altar favor. Offline expiry removes them directly; live expiry scatters them for five seconds.
- Turncoat guards retain their spears but use melee only. Twilight sky colors still follow clock time, as accepted in the plan.
- The LLM pipeline, generated-module runtime, validator, providers, prayer UI, and acorn dependency are removed. Terrain tooling retains its localhost/LAN gate and screenshot delay endpoint. The reachability check formerly housed in the validator is retained as a standalone helper.
- Arena synchronization preserves the existing sandbox raid and guard-follower changes.

Tune events and units in `src/sim/events/defs.ts`. Use `?event=long-night`, `?event=jackals`, `?event=frenzy`, `?event=turncoats`, or `?event=ascension`. Console controls are `__hm.events.fire(id)`, `__hm.events.end(iid)`, and `__hm.events.list()`.

Validation: game and arena typechecks and production builds; 122 game tests and 125 arena tests passing (4 and 1 existing skips respectively), using one worker and a 30-second timeout to avoid baseline resource-contention timeouts. Sixteen event tests cover lifecycle, refresh, shuffle persistence, stacking, reloads, clock rates, theft limits, hostile targeting, spear hits, surrender, death, and offline cleanup. Browser smoke checks exercised all five event URLs, the Omens journal, combat, lighting, and natural deck advancement. One development-server HMR websocket warning occurred; game and worker execution continued.

The implementation was integrated and checked as a whole rather than recorded as seven intermediate commits. Long-session balance tuning and visual polish remain playtesting work.
