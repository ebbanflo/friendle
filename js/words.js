import { SOLUTIONS } from '../data/solutions.js';
import { GUESSES } from '../data/guesses.js';
import { WORD_LEN } from './config.js';

const GUESS_SET = new Set(GUESSES);

export function isValidGuess(word) {
  return typeof word === 'string' && word.length === WORD_LEN && GUESS_SET.has(word.toLowerCase());
}

// SOLUTIONS is ordered commonest-first. Squaring the random variate biases
// picks hard toward everyday words while the deep tail keeps marathon Royale
// sessions from ever repeating: ~10k words, tracked per session in `used`.
export function pickWord(used) {
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
