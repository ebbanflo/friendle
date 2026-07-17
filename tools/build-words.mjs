#!/usr/bin/env node
// One-off generator for data/solutions.js and data/guesses.js.
//
// There are only ~6-7k genuinely common five-letter English words, so a ~10k
// solutions list is built by evidence-stacking: every candidate is scored by
// how many independent sources attest it (two curated lists, a dictionary,
// two frequency corpora) and how strongly. The top of the list is everyday
// vocabulary; the bottom is crossword-grade but still real and guessable.
//
// Inputs (downloaded separately, see INSTRUCTIONS.md):
//   wordle-all.txt   - full Wordle valid-guess list (tabatkins/wordle-list, ~14.8k)
//   sgb-words.txt    - Knuth's 5757 common five-letter words (curated)
//   en_full.txt      - hermitdave/FrequencyWords en 2018 ("word count" lines, subtitles)
//   gbooks.txt       - hackerb9/gwordlist frequency-alpha-alldicts.txt (Google Books)
//   words_alpha.txt  - dwyl/english-words (370k dictionary spellings)
//   badwords.txt     - LDNOOBW English profanity list
// Usage: node tools/build-words.mjs <srcdir> <outdir> [targetSolutions=10000]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [srcDir, outDir, targetArg] = process.argv.slice(2);
const TARGET = Number(targetArg || 10000);
const read = (f) => readFileSync(join(srcDir, f), 'utf8').split(/\r?\n/);
const five = (w) => /^[a-z]{5}$/.test(w);
const norm = (lines) => lines.map((w) => w.trim().toLowerCase());

const valid = new Set(norm(read('wordle-all.txt')).filter(five));
const sgb = new Set(norm(read('sgb-words.txt')).filter(five));
const dict = new Set(norm(read('words_alpha.txt')).filter(five));

// Profanity: LDNOOBW plus manual additions; block exact matches and any word
// extending a 4+ letter bad stem (fuck->fucks, cunt->cunty, shit->shite).
const EXTRA_BAD = ['asses', 'bitch', 'whore', 'penis', 'boner', 'semen', 'prick',
  'pussy', 'twats', 'cunts', 'dicks', 'cocks', 'titty', 'boobs', 'queef', 'shits',
  'turds', 'dildo', 'gonad', 'pubes', 'pubic', 'rapes', 'raped', 'raper', 'nazis',
  'negro', 'spick', 'spics', 'homos', 'dykes', 'fagot', 'kikes', 'gooks', 'chink',
  'wanks', 'wanky', 'spunk', 'horny', 'nonce', 'pedos', 'paedo', 'porno', 'porns',
  'sperm', 'vulva', 'labia', 'anals', 'enema', 'feces', 'urine', 'bimbo', 'hussy',
  'darky', 'gyppo', 'abbos', 'coons', 'jizzy', 'jizzs',
  // slurs (incl. plurals/variants) found by manual scan of the candidate pool
  'spiks', 'dagos', 'sambo', 'zambo', 'boong', 'gippo', 'lezzy', 'lezza', 'micks',
  'honky', 'cholo', 'munts', 'kafir', 'cooly', 'squaw', 'injun', 'gyppy', 'kraut',
  'hymie', 'shiks', 'wetba'];
// Excluded from solutions only (never the revealed answer) but still typeable:
// dual-use words with an innocent primary meaning, plus NYT-style removals.
const SOFT_BAD = new Set(['spook', 'dinge', 'swart', 'moola', 'goyim', 'wench',
  'lynch', 'slave', 'harem', 'biddy', 'hoors', 'negus', 'fatso', 'dummy']);
const badAll = norm(read('badwords.txt')).concat(EXTRA_BAD).filter((w) => /^[a-z]{3,5}$/.test(w));
const badExact = new Set(badAll.filter(five));
const badStems = [...new Set(badAll.filter((w) => w.length === 4 || w.length === 5))];
const isBad = (w) => badExact.has(w) || badStems.some((b) => w.startsWith(b));

// Subtitle-corpus counts (conversational English).
const subCount = new Map();
for (const line of read('en_full.txt')) {
  const sp = line.indexOf(' ');
  if (sp < 0) continue;
  const w = line.slice(0, sp);
  if (five(w) && !subCount.has(w)) subCount.set(w, Number(line.slice(sp + 1)));
}

// Google Books rank (literary English).
const gbRank = new Map();
for (const line of read('gbooks.txt')) {
  const m = line.match(/^\s*(\d+)\s+(\S+)/);
  if (!m) continue;
  const w = m[2].toLowerCase();
  if (five(w) && !gbRank.has(w)) gbRank.set(w, Number(m[1]));
}

// Evidence score: independent attestations stack, so real words rise and
// single-corpus noise (OCR errors, dialect spellings) sinks.
const evidence = (w) => {
  let ev = 0;
  if (sgb.has(w)) ev += 6;
  if (valid.has(w)) ev += 2;
  if (dict.has(w)) ev += 2;
  const g = gbRank.get(w);
  if (g !== undefined) ev += g <= 20000 ? 6 : g <= 50000 ? 5 : g <= 100000 ? 4 : g <= 150000 ? 2.5 : g <= 200000 ? 1 : 0.5;
  const c = subCount.get(w) ?? 0;
  ev += c >= 1000 ? 6 : c >= 100 ? 5 : c >= 20 ? 4 : c >= 5 ? 2.5 : c >= 2 ? 1 : c >= 1 ? 0.5 : 0;
  return ev;
};
const NEVER = 50_000_000;
const subRank = new Map(
  [...subCount.entries()].sort((a, b) => b[1] - a[1]).map(([w], i) => [w, i])
);
const tiebreak = (w) => Math.min(gbRank.get(w) ?? NEVER, (subRank.get(w) ?? NEVER) * 12);

// Universe: the curated Wordle-legal list (no proper nouns by design), plus
// Knuth's curated common words as a safety net. Every candidate must also be
// a dictionary spelling and attested by at least one frequency corpus.
const universe = new Set([...valid, ...[...sgb].filter((w) => dict.has(w))]);
const candidates = [...universe].filter(
  (w) => !isBad(w) && !SOFT_BAD.has(w) && (dict.has(w) || sgb.has(w)) && (gbRank.has(w) || subCount.has(w))
);
candidates.sort((a, b) => evidence(b) - evidence(a) || tiebreak(a) - tiebreak(b) || (a < b ? -1 : 1));
// IMPORTANT: solutions stay sorted commonest-first; the game biases random
// picks toward the front so everyday words dominate actual play.
const solutions = candidates.slice(0, Math.min(TARGET, candidates.length));

// Guess dictionary: the standard Wordle valid list plus every solution.
// Profanity is stripped here too: FRIEND-mode setters pick their secret from
// this dictionary and it gets revealed to the whole room at the end.
const guesses = [...new Set([...valid, ...solutions])].filter((w) => !isBad(w)).sort();

mkdirSync(outDir, { recursive: true });
const pack = (name, words) =>
  `// Generated by tools/build-words.mjs - do not edit by hand.\n` +
  `export const ${name} = ${JSON.stringify(words.join(''))}.match(/.{5}/g);\n`;
writeFileSync(join(outDir, 'solutions.js'), pack('SOLUTIONS', solutions));
writeFileSync(join(outDir, 'guesses.js'), pack('GUESSES', guesses));
console.log(`pool: ${candidates.length}  solutions: ${solutions.length}  guesses: ${guesses.length}`);
console.log('rank ~9900-9950:', candidates.slice(9900, 9950).join(' '));
