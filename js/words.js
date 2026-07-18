import { SOLUTIONS } from '../data/solutions.js';
import { GUESSES } from '../data/guesses.js';
import { EASY, MEDIUM, HARD } from '../data/tiers.js';
import { WORD_LEN } from './config.js';

const GUESS_SET = new Set(GUESSES);
export const TIERS = { easy: EASY, medium: MEDIUM, hard: HARD };
const TIER_SETS = { easy: new Set(EASY), medium: new Set(MEDIUM), hard: new Set(HARD) };

export function isValidGuess(word) {
  return typeof word === 'string' && word.length === WORD_LEN && GUESS_SET.has(word.toLowerCase());
}

export function tierOf(word) {
  for (const t of ['easy', 'medium', 'hard']) if (TIER_SETS[t].has(word)) return t;
  return null; // unclassified deep tail - standard-mode-only territory
}

function uniformFrom(list, used) {
  for (let tries = 0; tries < 500; tries++) {
    const w = list[Math.floor(Math.random() * list.length)];
    if (!used.has(w)) return w;
  }
  const fresh = list.filter((w) => !used.has(w));
  return fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : null;
}

// tier: 'easy' | 'medium' | 'hard' picks uniformly inside that band (widening
// to its neighbors, then the full bank, if a marathon drains it).
// tier null/'standard': the classic experience - SOLUTIONS is ordered
// commonest-first and squaring the random variate biases picks hard toward
// everyday words, while the deep tail keeps long sessions from repeating.
export function pickWord(used, tier = null) {
  if (tier && TIERS[tier]) {
    const widen = { easy: ['easy', 'medium', 'hard'], medium: ['medium', 'hard', 'easy'], hard: ['hard', 'medium', 'easy'] };
    for (const t of widen[tier]) {
      const w = uniformFrom(TIERS[t], used);
      if (w) return w;
    }
    // all 12k tiered words used in one session - fall through to the bank
  }
  for (let tries = 0; tries < 500; tries++) {
    const r = Math.random();
    const idx = Math.floor(r * r * SOLUTIONS.length);
    const w = SOLUTIONS[idx];
    if (!used.has(w)) return w;
  }
  // biased picks kept colliding - fall back to a uniform scan
  const fresh = SOLUTIONS.filter((w) => !used.has(w));
  if (fresh.length === 0) { used.clear(); return SOLUTIONS[0]; }
  return fresh[Math.floor(Math.random() * fresh.length)];
}

// Standard Wordle scoring with duplicate handling. Returns e.g. 'gyxxg'
// (g=green, y=yellow, x=gray).
export function scoreGuess(guess, secret) {
  const g = guess.toLowerCase(), s = secret.toLowerCase();
  const colors = Array(WORD_LEN).fill('x');
  const remaining = {};
  for (let i = 0; i < WORD_LEN; i++) {
    if (g[i] === s[i]) colors[i] = 'g';
    else remaining[s[i]] = (remaining[s[i]] || 0) + 1;
  }
  for (let i = 0; i < WORD_LEN; i++) {
    if (colors[i] === 'x' && remaining[g[i]] > 0) {
      colors[i] = 'y';
      remaining[g[i]]--;
    }
  }
  return colors.join('');
}

export const solutionCount = SOLUTIONS.length;
export const guessCount = GUESSES.length;
