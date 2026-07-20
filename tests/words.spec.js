// Word-list policy tests (no browser needed - pure data checks against the
// generated bank). Regression coverage for a real bug: an earlier profanity
// filter matched by 4-5 letter STEM against a generic third-party list
// (LDNOOBW), which silently blocked ~130 ordinary words as guesses -
// "whore" (an exact-listed word, not even a stem victim, caught because the
// filter applied to the whole guess dictionary) plus collateral damage like
// "spice"/"grope"/"sucks"/"butte" (blocked only because they share a 4-letter
// prefix with an unrelated flagged word). See tools/build-words.mjs for the
// three-tier fix: SLURS (blocked everywhere), CRUDE (guessable, never an
// auto-picked solution), everything else fully restored.
import { test, expect } from '@playwright/test';
import { GUESSES } from '../data/guesses.js';
import { SOLUTIONS } from '../data/solutions.js';
import { EASY, MEDIUM, HARD } from '../data/tiers.js';

const guessSet = new Set(GUESSES);
const solutionSet = new Set(SOLUTIONS);

test.describe('word lists', () => {
  test('basic integrity: sizes, five-letter, unique, solutions ⊆ guesses', () => {
    expect(GUESSES.length).toBeGreaterThan(14000);
    expect(SOLUTIONS.length).toBeGreaterThan(10000);
    expect(GUESSES.every((w) => /^[a-z]{5}$/.test(w))).toBe(true);
    expect(SOLUTIONS.every((w) => /^[a-z]{5}$/.test(w))).toBe(true);
    expect(new Set(GUESSES).size).toBe(GUESSES.length);
    expect(new Set(SOLUTIONS).size).toBe(SOLUTIONS.length);
    expect(SOLUTIONS.every((w) => guessSet.has(w))).toBe(true);
  });

  test('the reported bug: "whore" and its siblings are valid guesses', () => {
    // real, crude, mainstream English words - guessable, matching what the
    // actual official Wordle valid-guess list allows
    const crude = ['whore', 'bitch', 'pussy', 'penis', 'horny', 'kinky',
      'vulva', 'semen', 'panty', 'boobs', 'busty', 'titty', 'dildo'];
    for (const w of crude) {
      expect(guessSet.has(w), `${w} should be a valid guess`).toBe(true);
      // crude words are real but never an auto-picked, publicly-revealed answer
      expect(solutionSet.has(w), `${w} should never be an auto-picked solution`).toBe(false);
    }
  });

  test('no stem-matching collateral damage: ordinary words a stem filter would wrongly eat', () => {
    // each of these shares a 4-5 letter prefix with a flagged/crude word but
    // is itself an unrelated, perfectly ordinary word
    const ordinary = ['spice', 'spicy', 'grope', 'sucks', 'tushy', 'fecal',
      'skeet', 'dummy', 'butte', 'butts', 'cocky', 'dicky', 'booby', 'nudes'];
    for (const w of ordinary) {
      expect(guessSet.has(w), `${w} should be a valid guess (not stem-collateral-damage)`).toBe(true);
    }
  });

  test('genuine slurs stay blocked everywhere, guesses and solutions alike', () => {
    const slurs = ['coons', 'nigga', 'negro', 'pikey', 'honky', 'kraut',
      'squaw', 'injun', 'chink', 'kikes', 'gooks', 'fagot', 'spick', 'spics',
      'cholo', 'munts', 'kafir', 'cooly', 'sambo'];
    for (const w of slurs) {
      expect(guessSet.has(w), `${w} must not be a valid guess`).toBe(false);
      expect(solutionSet.has(w), `${w} must not be a solution`).toBe(false);
    }
  });

  test('difficulty tiers stay disjoint subsets of the solution bank', () => {
    const all = [...EASY, ...MEDIUM, ...HARD];
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((w) => solutionSet.has(w))).toBe(true);
  });
});
