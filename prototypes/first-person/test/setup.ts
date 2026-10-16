import { beforeEach } from 'vitest';
import { DECK } from '../src/sim/events/defs';
// Long-running legacy tests opt out of curses; event tests explicitly choose their deck.
beforeEach(() => { DECK.order = []; });
