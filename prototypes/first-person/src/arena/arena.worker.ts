// The arena's sim worker: the game's worker with the arena hooked in first. dev/arena-shadow.ts points
// src/sim-client.ts here. The order of these imports matters: the hooks must be in place before the game's worker
// starts listening.
import './arena-hooks';
import '../workers/sim.worker';
