// TOWER mode rules: decree (constraint) generation + matching + RPG scoring.
// Pure functions over the guess dictionary - the engine (host) generates and
// judges; clients only render what they're told.

import { GUESSES } from '../data/guesses.js';
import { TOWER, LETTER_VALUES } from './config.js';

const VOWELS = ['a', 'e', 'i', 'o', 'u'];
const COMMON = 'etaoinshrdlcumwfgypb';
const rand = (n) => Math.floor(Math.random() * n);
const pickFrom = (s) => s[rand(s.length)];

// A decree: { req: ['b'], reqAt: [{ i: 3, ch: 'b' }], ban: ['q', 'z'] }
export function matchesConstraint(word, c) {
  if (!c) return true;
  for (const ch of c.req || []) if (!word.includes(ch)) return false;
  for (const { i, ch } of c.reqAt || []) if (word[i] !== ch) return false;
  for (const ch of c.ban || []) if (word.includes(ch)) return false;
  return true;
}

export function countPossible(c, used) {
  let n = 0;
  for (const w of GUESSES) {
    if (!used.has(w) && matchesConstraint(w, c)) n++;
  }
  return n;
}

// Escalation tiers. 1: use a letter -> 2: use two -> 3: letter in a slot ->
// 4: use three -> 5: two slotted letters -> 6: banned letters ->
// 7: slot + bans -> 8: NO VOWELS -> 9+: rotating brutality with extra bans.
function candidate(stage) {
  const tier = Math.min(stage, 8);
  const uniq = (arr) => [...new Set(arr)];
  switch (tier) {
    case 1: return { req: [pickFrom(COMMON)] };
    case 2: return { req: uniq([pickFrom(COMMON), pickFrom(COMMON.slice(0, 12))]) };
    case 3: return { reqAt: [{ i: rand(5), ch: pickFrom(COMMON) }] };
    case 4: return { req: uniq([pickFrom(COMMON), pickFrom(COMMON), pickFrom(COMMON)]) };
    case 5: {
      const i = rand(4);
      return { reqAt: [{ i, ch: pickFrom(COMMON) }, { i: i + 1 + rand(4 - i), ch: pickFrom(COMMON) }] };
    }
    case 6: return { ban: uniq([pickFrom(COMMON.slice(0, 10)), pickFrom(COMMON.slice(0, 10)), pickFrom(VOWELS)]) };
    case 7: return {
      reqAt: [{ i: rand(5), ch: pickFrom(COMMON) }],
      ban: uniq([pickFrom(VOWELS), pickFrom('bcdfghjklm')]),
    };
    default: { // 8+: no vowels, then pile on extra banned consonants
      const extra = [];
      for (let k = 8; k < stage; k++) extra.push(pickFrom('bcdfgkmpw'));
      return { ban: [...new Set([...VOWELS, ...extra])] };
    }
  }
}

export function genConstraint(stage, used) {
  // A decree must be survivable: enough unused dictionary words must satisfy
  // it. Falling tolerance with stage - late towers are SUPPOSED to be cruel.
  const minWords = stage >= 8 ? TOWER.minWordsPerDecree : TOWER.minWordsPerDecree * 4;
  for (let tries = 0; tries < 40; tries++) {
    const c = candidate(stage);
    if (countPossible(c, used) >= minWords) return c;
  }
  // everything this brutal is exhausted - fall back down a stage
  return stage > 1 ? genConstraint(stage - 1, used) : { req: [pickFrom('east')] };
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
  return parts.join(' · ') || 'ANY WORD';
}

// RPG numbers: big, stage-multiplied, combo-inflated.
export function wordPoints(word, stage, combo) {
  const letters = [...word].reduce((s, ch) => s + (LETTER_VALUES[ch] || 1), 0);
  const raw = (TOWER.base + letters * TOWER.perLetterValue) * stage * (1 + TOWER.comboPct * combo);
  return Math.round(raw / 10) * 10;
}
