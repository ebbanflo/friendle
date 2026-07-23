// TOWER mode rules: decree (constraint) generation + matching + RPG scoring.
// Pure functions over the guess dictionary - the engine (host) generates and
// judges; clients only render what they're told.

import { GUESSES } from '../data/guesses.js';
import { TOWER, LETTER_VALUES } from './config.js';

const VOWELS = ['a', 'e', 'i', 'o', 'u'];
const COMMON = 'etaoinshrdlcumwfgypb'; // top ~20 by in-dictionary frequency
const RARE = 'jqxzvk';                 // reserved for HARD - never in COMMON
const rand = (n) => Math.floor(Math.random() * n);
const pickFrom = (s) => s[rand(s.length)];
const uniqArr = (arr) => [...new Set(arr)];

// A decree: { req, reqAt, ban, rep, uniq, vmin, vmax, bookend, dvowel }.
// req: must contain these letters. reqAt: letter pinned to a slot.
// ban: must not contain these letters. rep: needs a repeated letter.
// uniq: all letters distinct. vmin/vmax: vowel-count bounds. bookend:
// first letter === last letter. dvowel: two vowels back to back somewhere.
export function matchesConstraint(word, c) {
  if (!c) return true;
  for (const ch of c.req || []) if (!word.includes(ch)) return false;
  for (const { i, ch } of c.reqAt || []) if (word[i] !== ch) return false;
  for (const ch of c.ban || []) if (word.includes(ch)) return false;
  const distinct = new Set(word).size === word.length;
  if (c.rep && distinct) return false;
  if (c.uniq && !distinct) return false;
  if (c.vmin != null || c.vmax != null) {
    const vc = [...word].filter((ch) => VOWELS.includes(ch)).length;
    if (c.vmin != null && vc < c.vmin) return false;
    if (c.vmax != null && vc > c.vmax) return false;
  }
  if (c.bookend && word[0] !== word[word.length - 1]) return false;
  if (c.dvowel) {
    let has = false;
    for (let i = 0; i < word.length - 1; i++) {
      if (VOWELS.includes(word[i]) && VOWELS.includes(word[i + 1])) { has = true; break; }
    }
    if (!has) return false;
  }
  return true;
}

export function countPossible(c, used) {
  let n = 0;
  for (const w of GUESSES) {
    if (!used.has(w) && matchesConstraint(w, c)) n++;
  }
  return n;
}

// Three hand-vetted difficulty pools (see tools/vet-decrees.mjs-style checks
// run against the real 14.8k-word GUESSES bank before these were tuned -
// every generator here reliably clears its pool's minWords floor below).
// EASY: always four-figure possible-word counts - never punishing.
const EASY = [
  () => ({ req: [pickFrom(COMMON)] }),
  () => ({ reqAt: [{ i: rand(5), ch: pickFrom(COMMON.slice(0, 12)) }] }),
  () => ({ vmin: 2 }),                         // at least 2 vowels
  () => ({ uniq: true }),                      // no repeated letters
  () => ({ ban: [pickFrom('jqxz')] }),         // one rare letter forbidden
];

// MEDIUM: real friction (dozens to low-thousands), never a coin-flip.
const MEDIUM = [
  () => ({ req: uniqArr([pickFrom(COMMON.slice(0, 14)), pickFrom(COMMON.slice(0, 14))]) }),
  () => {
    const i = rand(4);
    return { reqAt: [{ i, ch: pickFrom(COMMON.slice(0, 14)) }, { i: i + 1 + rand(4 - i), ch: pickFrom(COMMON.slice(0, 14)) }] };
  },
  () => ({ vmin: 1, vmax: 1 }),                 // exactly one vowel
  () => ({ rep: true }),                        // needs a double letter
  () => ({ dvowel: true }),                     // two vowels in a row
  () => ({ reqAt: [{ i: rand(5), ch: pickFrom(COMMON.slice(0, 14)) }], ban: [pickFrom(VOWELS)] }),
  () => ({ vmin: 3 }),                          // 3+ vowels
];

// HARD: brutal but never JUST "no vowels, minus more letters" - a rotating
// mix of structural, letter-count, and rare-letter twists. countPossible
// keeps every one of these honest at runtime (see genConstraint).
const HARD = [
  () => ({ bookend: true }),                                       // first == last letter
  () => ({ req: [pickFrom(RARE)] }),                                // a genuinely rare letter
  () => ({ ban: [...VOWELS] }),                                     // no vowels at all
  () => ({ ban: [...VOWELS, pickFrom('bcdfgkmpw')] }),              // no vowels + ONE extra ban (capped, not stacking)
  () => ({ ban: [...VOWELS], uniq: true }),                         // no vowels, no repeats either
  () => ({ vmin: 1, vmax: 1, reqAt: [{ i: rand(5), ch: pickFrom(COMMON.slice(0, 14)) }] }),
  () => ({ bookend: true, reqAt: [{ i: 1 + rand(3), ch: pickFrom(COMMON.slice(0, 16)) }] }),
  () => ({ req: uniqArr([pickFrom(COMMON.slice(0, 16)), pickFrom(COMMON.slice(0, 16)), pickFrom(COMMON.slice(0, 16))]) }),
];

function poolFor(difficulty, stage) {
  if (difficulty === 'easy') return EASY;
  if (difficulty === 'medium') return MEDIUM;
  if (difficulty === 'hard') return HARD;
  // 'ramp' (default): climbs easy -> medium -> hard as the tower grows, then
  // STAYS in hard - rotating through its varied generators for flavor -
  // instead of piling on ever more bans until only unrecognizable scraps
  // of the dictionary are left standing.
  if (stage <= 2) return EASY;
  if (stage <= 5) return MEDIUM;
  return HARD;
}

export function genConstraint(stage, used, difficulty = 'ramp', rampWords = 1) {
  const pool = poolFor(difficulty, stage);
  // A decree must be survivable: enough unused dictionary words must satisfy
  // it. Floor scales with the pool (hard is SUPPOSED to be cruel, easy never
  // should be) but never drops below rampWords itself - the team needs that
  // many DISTINCT legal words to ever clear the decree, so generating one
  // that can't mathematically supply that many would strand them for good.
  const poolFloor = pool === HARD ? TOWER.minWordsPerDecree
    : pool === MEDIUM ? TOWER.minWordsPerDecree * 10
      : TOWER.minWordsPerDecree * 40;
  const minWords = Math.max(poolFloor, rampWords);
  for (let tries = 0; tries < 40; tries++) {
    const c = pool[rand(pool.length)]();
    if (countPossible(c, used) >= minWords) return c;
  }
  // this pool is exhausted this deep into a long game (rare) - drop a notch
  // rather than serve something the team can no longer possibly satisfy
  if (pool === HARD) return genConstraint(stage, used, 'medium', rampWords);
  if (pool === MEDIUM) return genConstraint(stage, used, 'easy', rampWords);
  return { req: [pickFrom('east')] };
}

export function describeConstraint(c) {
  const parts = [];
  if (c.reqAt?.length) parts.push(c.reqAt.map(({ i, ch }) => `${ch.toUpperCase()} IN SLOT ${i + 1}`).join(' + '));
  if (c.req?.length) parts.push(`MUST USE ${c.req.map((x) => x.toUpperCase()).join(' + ')}`);
  if (c.ban?.length) {
    const isNoVowels = VOWELS.every((v) => c.ban.includes(v));
    const extras = c.ban.filter((ch) => !VOWELS.includes(ch));
    if (isNoVowels) parts.push('NO VOWELS' + (extras.length ? ` · NO ${extras.map((x) => x.toUpperCase()).join(' ')}` : ''));
    else parts.push(`FORBIDDEN: ${c.ban.map((x) => x.toUpperCase()).join(' ')}`);
  }
  if (c.bookend) parts.push('FIRST + LAST LETTER MATCH');
  if (c.rep) parts.push('NEEDS A DOUBLE LETTER');
  if (c.uniq) parts.push('NO REPEATED LETTERS');
  if (c.dvowel) parts.push('TWO VOWELS IN A ROW');
  if (c.vmin != null && c.vmin === c.vmax) parts.push(`EXACTLY ${c.vmin} VOWEL${c.vmin === 1 ? '' : 'S'}`);
  else if (c.vmin != null) parts.push(`${c.vmin}+ VOWELS`);
  else if (c.vmax != null) parts.push(`AT MOST ${c.vmax} VOWEL${c.vmax === 1 ? '' : 'S'}`);
  return parts.join(' · ') || 'ANY WORD';
}

// RPG numbers: big, stage-multiplied, combo-inflated.
export function wordPoints(word, stage, combo) {
  const letters = [...word].reduce((s, ch) => s + (LETTER_VALUES[ch] || 1), 0);
  const raw = (TOWER.base + letters * TOWER.perLetterValue) * stage * (1 + TOWER.comboPct * combo);
  return Math.round(raw / 10) * 10;
}
