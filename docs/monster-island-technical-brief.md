# Monster island: Game Vision and Technical Brief

*Working concept · Discussion recorded October 8, 2026*

## Vision

Build a browser game for the twenty-five-day **Monster Mash** game jam, published on **Run.world**.

The defining feature is a world that evolves through **AI-written executable code**. Gods observe the island, decide what would improve it, and commission agents to implement new mechanics.

The fantasy is that a player returns to discover that the game itself has changed: inhabitants can swim, rivers freeze, combat exists, or a new environmental system has appeared.

Selecting prebuilt features or adjusting numbers alone does not satisfy this vision. General infrastructure—movement, rendering primitives, storage, and testing—is acceptable, but the AI must be able to invent behavior that was not implemented beforehand.

The long-term goal is development while the player is away. Run support for that remains unresolved. The current working fallback is development during active play, with incomplete work saved and resumed next session.

## Initial simulation

The proof of concept begins with a small island rendered in simple, blocky 3D.

- Monsters occupy a village, with a house for each monster.
- Humans have a similar settlement.
- Humans are more numerous but individually weaker.
- Both populations have hunger.
- During the day, inhabitants wander and collect randomly spawning food.
- At night, inhabitants return home and sleep.
- Combat is optional and can be absent initially.

General 3D shapes and a particle-effect system provide the visual building blocks for generated mechanics.

Player interaction is still undefined. Initially, the experience may be primarily observational. We must decide whether the god optimizes for interesting events to watch, meaningful player decisions, or both.

## Gods and motivations

The MVP uses **one god**, motivated to make the island more entertaining for the player.

The god observes world state and recent events, proposes a change, and explains the intended benefit. “Entertaining” is a design hypothesis, not something automated correctness tests can establish.

Possible observations include repetitive behavior, resource abundance or scarcity, stalled inhabitants, faction activity, and recent surprises. Player feedback could inform later interventions.

Earlier possibilities remain optional future directions:

- Inhabitants submit prayers.
- Humans and monsters have rival patron gods.
- A higher god arbitrates between them.
- Divine intervention responds to conflict or maintains an interesting balance.

Constantly counteracting player success could feel punitive. A balance-seeking god should allow temporary victories.

## AI development pipeline

1. **Observe:** capture the world, recent events, current program, and installed features.
2. **Propose:** the god chooses an intervention.
3. **Specify:** an agent produces an implementation specification.
4. **Critique:** an adversarial reviewer identifies omissions, conflicts, and failure cases; revise the specification.
5. **Implement:** a coding agent writes or edits executable gameplay code and visual definitions.
6. **Validate:** run independent checks plus feature-specific tests against a copy of the world.
7. **Repair:** feed failures back to the coder within a bounded budget.
8. **Activate:** accept the candidate at a transition such as dawn; retain the previous working version.
9. **Persist:** save compatible code and world state together.

Development can run alongside play. A candidate created from an earlier snapshot must be checked against the latest save before activation.

A ten-minute session is a plausible target for a small intervention, not a verified guarantee. Changes spanning movement, navigation, combat, persistence, and graphics are less predictable.

## Runtime architecture

A stable host handles rendering, AI requests, storage, candidate activation, and recovery. Generated code controls evolving behavior and can describe new shapes, particles, and interactions.

A **blob URL** points to code held in browser memory. A **worker** executes code on a separate thread and communicates through messages. A stuck worker can be terminated without placing the same endless loop in the main interface thread.

Workers are not complete security sandboxes. Stronger restriction may require a bundled interpreter exposing deliberate game capabilities.

Controls should include simulation timeouts, object and particle limits, validation of worker messages, candidate world copies, and recovery checkpoints.

The saved artifact is the code—not its temporary blob URL. On reload, the game recreates the execution environment from saved code.

Daily changes do not require daily regeneration at login. The system can maintain one evolving program or a set of active modules. Historical versions are retained for recovery, not all executed.

## Shared library of invented features

Before writing a new mechanic, the god searches a shared catalog. It may reuse a feature, install its dependencies, adapt it, or create something new.

A feature package should include:

- Code and visual definitions.
- Description, version, and intended behavior.
- Dependencies and compatibility requirements.
- Tests and save-conversion procedures.
- Installation and, where supported, removal procedures.

Features need explicit dependencies; they need not be completely independent. Fishing can depend on water and inventories. Frozen rivers can interact with swimming.

Removal can be harder than installation: deleting swimming while a creature is in water requires recovery behavior. Some early changes may be permanent.

Reuse should reduce duplication, but divergent worlds may still require adaptation. Test imported code against each receiving world.

## Run.world: documented capabilities

These findings come from documentation reviewed during the discussion, not an end-to-end deployed test.

| Capability | Evidence and implication |
|---|---|
| Browser-based 3D games | Run provides an official 3D starter. [Getting started](https://series-1.gitbook.io/rundot-docs/readme/getting-started) |
| Runtime AI | Run offers hosted text generation, tool calling, and several model classes. It routes to provider models rather than one proprietary Run model. Actual availability must be queried. [AI API](https://series-1.gitbook.io/rundot-docs/readme/ai) |
| Generated script execution | Blob URLs are documented as supported for scripts and workers. [Runtime environment](https://series-1.gitbook.io/rundot-docs/readme/runtime-environment) |
| Saved player worlds | Per-player cloud storage is available through the SDK. [Runtime environment](https://series-1.gitbook.io/rundot-docs/readme/runtime-environment) |
| Cross-player feature catalog | The UGC API supports publication and discovery of arbitrary JSON up to 100 KB. Using it for code packages is our proposed application. [UGC API](https://github.com/series-ai/venus-sdk-docs/blob/main/rundot-developer-platform/api/UGC.md) |
| Larger shared packages | Files supports text/JSON uploads and cross-player reads of public files. Storage is creator-funded and quota-limited. [Files API](https://github.com/series-ai/venus-sdk-docs/blob/main/rundot-developer-platform/api/FILES.md) |
| Automated new builds | An external pipeline can deploy versioned builds using game-scoped credentials. [Deployment](https://series-1.gitbook.io/rundot-docs/readme/deploying-your-game) |
| Agent orchestration library | Run’s agent library provides tool loops, persistence, retries, and recovery. It does not establish hosted unattended execution. [Agent library](https://www.npmjs.com/package/@series-inc/rundot-agent) |

## Run constraints

- **External backends:** the browser game cannot directly contact arbitrary external servers, including our backend or outside AI APIs.
- **Allowed content:** the game can load its own hosted files, Google Fonts, and supported platform-managed content.
- **Storage:** browser storage facilities and service workers are unavailable inside the game iframe; use SDK services.
- **Dependencies:** bundle libraries or use supported embedded libraries.
- **Offline execution:** browser workers stop with the session. Persistent server rooms freeze when empty and resume on the next join; they do not continuously run without members. [Persistent rooms](https://github.com/series-ai/venus-sdk-docs/blob/main/rundot-developer-platform/api/ADVANCED-MULTIPLAYER.md)
- **Notifications:** web local notifications appear in Run’s bell inbox rather than as OS push notifications. Notification support does not provide background computation. [Notifications](https://series-1.gitbook.io/rundot-docs/readme/notifications)
- **Generated-code approval:** script support and public-content moderation do not establish approval, safety, or correctness of our specific design.

Keeping a fake player connected is not an established production solution. An authorized service client or always-active facility would require confirmation from Run.

## Costs and operational risks

Run uses platform credits and configurable usage budgets. We have not verified its model-specific credit rates or dollar conversion.

As a provider-only reference, Claude Sonnet 4.6 lists standard rates of $3 per million input tokens and $15 per million output tokens. These are **not confirmed Run rates**. [Provider pricing](https://platform.claude.com/docs/en/models/sonnet-4-6/overview)

Measure the entire pipeline, including repeated source context, critique, retries, and repairs.

Major risks include save incompatibility, interacting mechanics, performance degradation, visually invisible changes, untrustworthy shared packages, and passing tests that fail to reflect real gameplay. Combining code into one file does not eliminate accumulated complexity.

## Outstanding questions

1. Does Run provide background jobs or an approved external integration for offline development?
2. What outbound requests are permitted from custom server-side room code?
3. Does Run approve AI-generated executable gameplay and cross-player code sharing?
4. Which models, context/output limits, credit rates, and rate limits apply to this game?
5. What storage and file quotas apply, and how should versions be pruned?
6. Do blob workers, recovery, persistence, and imported packages work in the deployed web environment?
7. How will shared packages be validated, versioned, deduplicated, and withdrawn?
8. What does the player do, and what feedback guides the god’s entertainment objective?

## First proof to build

Deploy a minimal Run test that requests newly generated code, executes it in a worker, exchanges simulation and visual messages, terminates a stuck candidate, and saves/reloads an accepted program with its world.

Then demonstrate one genuinely new mechanic in the island simulation.

Finally, publish that mechanic through the shared catalog and retrieve, test, and install it in a second player’s world without regenerating it.

Success means visible new behavior, preserved world state, persistent changes after reload, and recovery from failure. Offline development remains a separate acceptance requirement until a supported execution route is established.
