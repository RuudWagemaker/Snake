// Nickname cleanup for a public game: allowed characters only, and no slurs or
// obvious abuse (English and Dutch). Not perfect, but it stops the worst.
const BLOCKED = [
  // Plain substrings, so keep out words that hide inside normal names
  // (e.g. "cock" in Hitchcock, "rape" in grape, "tering" in catering).
  'nigger', 'nigga', 'neger', 'faggot', 'retard', 'kanker', 'hitler', 'nazi', 'hoer',
  'kut', 'cunt', 'whore', 'slut', 'tyfus', 'mongool', 'fuck', 'shit', 'bitch', 'pussy',
  'penis', 'vagina', 'porn', 'kys',
];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };

/** Lower case, look-alike digits as letters, no spaces or punctuation, repeats collapsed. */
function squash(s) {
  return s.toLowerCase()
    .replace(/[0134578@$!]/g, (c) => LEET[c])
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1');
}
const BLOCKED_SQUASHED = [...new Set(BLOCKED.map(squash))];

export function isOffensive(name) {
  const s = squash(name);
  return BLOCKED_SQUASHED.some((w) => s.includes(w));
}

export function cleanName(s) {
  const n = String(s ?? '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!n || isOffensive(n)) return 'Player';
  return n;
}
