import type { Rng } from './rng';
import type { Faction } from './types';

const SYL: Record<Faction, [string[], string[]]> = {
  monster: [['Gro', 'Mog', 'Bub', 'Zug', 'Kra', 'Ug', 'Snar', 'Blo', 'Thok', 'Grum'], ['nk', 'gle', 'bo', 'rax', 'th', 'ub', 'oo', 'zz', 'mash', 'lump']],
  human: [['El', 'Ma', 'Tom', 'Ro', 'Lin', 'Wil', 'Ha', 'Pe', 'Ada', 'Bry'], ['a', 'ric', 'ny', 'sie', 'bert', 'dle', 'ton', 'ra', 'lin', 'my']],
};

export function makeName(rng: Rng, faction: Faction): string {
  const [a, b] = SYL[faction];
  return rng.pick(a)! + rng.pick(b)!;
}
