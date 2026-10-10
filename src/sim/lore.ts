// Names and bios (§5.1, §6.1). All randomness comes from the sim's Rng.
import type { Rng } from './rng';

const MALE = ['Elah', 'Gera', 'Abner', 'Ehud', 'Tola', 'Jair', 'Ibzan', 'Elon', 'Abdon', 'Manoah', 'Othniel', 'Shamgar', 'Barak', 'Gideon', 'Joash', 'Purah', 'Zebul', 'Gaal', 'Micah', 'Jether', 'Asher', 'Heber', 'Kenaz', 'Caleb', 'Phinehas', 'Eli', 'Hophni', 'Boaz', 'Obed', 'Jesse', 'Nahshon', 'Salmon', 'Amram', 'Hur', 'Uri', 'Bezalel', 'Ahiezer', 'Zuar', 'Helon', 'Igal'];
const FEMALE = ['Noa', 'Milcah', 'Hoglah', 'Tirzah', 'Adah', 'Zillah', 'Naamah', 'Deborah', 'Jael', 'Achsah', 'Delilah', 'Orpah', 'Ruth', 'Naomi', 'Hannah', 'Peninnah', 'Abigail', 'Zeruiah', 'Merab', 'Michal', 'Rizpah', 'Shiphrah', 'Puah', 'Serah', 'Jochebed', 'Basemath', 'Keturah', 'Bilhah', 'Zilpah', 'Dinah'];

const TRAITS = [
  'sings to the flock at dusk', 'never lost a lamb to a wolf', 'laughs louder than anyone at the harvest',
  'carves little oxen out of olive wood', 'swears the hills whisper at night', 'is the best swimmer in the harbor',
  'knows every spring between here and the salt', 'still limps from a fall in the wadi', 'prays before every meal, twice',
  'trades jokes with the guards at the gate', 'can smell rain a day before it comes', 'keeps a pet crow',
  'is saving silver for a bronze knife', 'tells the children stories of the giants', 'has never once been sick',
  'cannot sleep without a lamp burning', 'once saw a winged serpent and lived', 'brews the sourest wine on the island',
];
const TIES_M = ['His daughter {k} tends the fold.', 'His wife {k} weaves by the gate.', 'His old mother {k} waits for him each night.', 'His brother {k} works the same fields.', 'His son {k} wants to be a guard.'];
const TIES_F = ['Her daughter {k} tends the fold.', 'Her husband {k} mends nets in the harbor.', 'Her old father {k} waits for her each night.', 'Her sister {k} works the same terraces.', 'Her son {k} wants to be a guard.'];

export interface Person {
  name: string;
  male: boolean;
  bio: string;
}

export function makePerson(rng: Rng, jobLabel: string): Person {
  const male = rng.chance(0.55);
  const given = rng.pick(male ? MALE : FEMALE)!;
  const father = rng.pick(MALE)!;
  const name = `${given} ${male ? 'son' : 'daughter'} of ${father}`;
  const trait = rng.pick(TRAITS)!;
  const kin = rng.pick(rng.chance(0.5) ? MALE : FEMALE)!;
  const tie = rng.pick(male ? TIES_M : TIES_F)!.replace('{k}', kin);
  const bio = `A ${jobLabel} who ${trait}. ${tie}`;
  return { name, male, bio };
}

export function givenName(full: string): string {
  return full.split(' ')[0];
}

const M_A = ['Ga', 'Ra', 'Sha', 'Zu', 'Ka', 'Mo', 'A', 'Te', 'Ba', 'Ne', 'Gol', 'Ash', 'Ur', 'Kh'];
const M_B = ['ash', 'hab', 'zar', 'loth', 'mek', 'nun', 'ziz', 'rath', 'bal', 'goth', 'ram', 'dun', 'sek', 'mot'];
const EPITHETS = ['the Hill-Breaker', 'the Devourer', 'Who Walks at Dusk', 'the Bone-Gnawer', 'the Hollow-Eyed', 'the Unclean', 'Lord of the Wadi', 'the Skin-Taker', 'the Black-Winged', 'the Screamer', 'Who Drinks the Salt', 'the Many-Toothed', 'the Grinning', 'Old Thunder'];

export function makeMonsterName(rng: Rng): { name: string; epithet: string } {
  return { name: rng.pick(M_A)! + rng.pick(M_B)!, epithet: rng.pick(EPITHETS)! };
}
