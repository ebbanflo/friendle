#!/usr/bin/env node
// Generator for data/solutions.js, data/guesses.js and data/tiers.js.
//
// The scrabble-legal 5-letter English lexicon tops out around 15k (the Wordle
// valid-guess list already subsumes ENABLE and SOWPODS), so a ~20k bank is
// built from: the full curated Wordle list + every dictionary word (dwyl,
// wordnik) that is corpus-attested or agreed on by both dictionaries -
// name-filtered, profanity-filtered, and evidence-ranked commonest-first.
//
// Difficulty tiers (easy/medium/hard) are score-ordered slices: score =
// commonness percentile + structural penalties (duplicate letters, rare
// letters), so "jazzy" lands harder than its frequency alone suggests. The
// deepest tail stays unclassified - only `standard` mode (full bank, biased
// toward the front) ever serves it.
//
// Inputs (downloaded separately, see INSTRUCTIONS.md):
//   wordle-all.txt   - full Wordle valid-guess list (tabatkins/wordle-list)
//   sgb-words.txt    - Knuth's 5757 common five-letter words (curated)
//   en_full.txt      - hermitdave/FrequencyWords en 2018 (subtitles corpus)
//   gbooks.txt       - hackerb9/gwordlist frequency-alpha-alldicts.txt
//   words_alpha.txt  - dwyl/english-words (370k dictionary spellings)
//   wordnik.txt      - wordnik/wordlist (quoted, one word per line)
//   firstnames.txt   - smashew/NameDatabases US first names
//   surnames.txt     - smashew/NameDatabases US surnames
//   badwords.txt     - LDNOOBW English profanity list
// Usage: node tools/build-words.mjs <srcdir> <outdir> [targetSolutions=20000]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [srcDir, outDir, targetArg] = process.argv.slice(2);
const TARGET = Number(targetArg || 20000);
const TIER_SIZES = { easy: 3000, medium: 4000, hard: 5000 };
const read = (f) => readFileSync(join(srcDir, f), 'utf8').split(/\r?\n/);
const five = (w) => /^[a-z]{5}$/.test(w);
const norm = (lines) => lines.map((w) => w.trim().toLowerCase());

const valid = new Set(norm(read('wordle-all.txt')).filter(five));
const sgb = new Set(norm(read('sgb-words.txt')).filter(five));
const dict = new Set(norm(read('words_alpha.txt')).filter(five));
const wordnik = new Set(norm(read('wordnik.txt')).map((w) => w.replace(/"/g, '')).filter(five));
// Scrabble dictionaries admit NO proper nouns - the perfect referee for
// "name that is also a real word" (smith, maria) vs list pollution (patel).
const scrab = new Set([
  ...norm(read('enable1.txt')).filter(five),
  ...norm(read('sowpods.txt')).filter(five),
]);
const names = new Set([
  ...norm(read('firstnames-all.txt')),  // worldwide first names (smashew all.txt)
  ...norm(read('surnames-all.txt')),    // worldwide surnames
].filter(five));

// Word-safety policy, tiered and EXACT-MATCH ONLY (no prefix/stem matching -
// an earlier version matched by 4-5 letter stem, e.g. "spic"->blocks
// "spice"/"spicy"/"spica", "butt"->blocks "butte"/"butty", "bust"->blocks
// "busty"/"bustle"'s cousins - it silently ate ~100 ordinary words, "whore"
// among the casualties despite being an EXACT-list entry, not a stem victim,
// because the guess dictionary applied this same over-broad filter to the
// full valid-guess list too. Lesson: exact match is precise and auditable;
// stem matching against a generic third-party list is not. See git history
// for the audit that produced these three lists.
//
// SLURS: excluded from BOTH the guess dictionary and solutions. Being wrong
// in the "too permissive" direction here is a real harm, unlike ordinary
// profanity, so this stays a small, deliberately hand-reviewed list rather
// than anything derived from a generic word-filter corpus.
const SLURS = new Set(['spick', 'spics', 'spiks', 'dagos', 'dagoe', 'sambo', 'zambo',
  'zambos', 'boong', 'gippo', 'gyppo', 'gyppy', 'lezzy', 'lezza', 'micks', 'honky',
  'cholo', 'munts', 'kafir', 'cooly', 'squaw', 'injun', 'kraut', 'hymie', 'wetba',
  'darki', 'darky', 'boche', 'polak', 'jiggs', 'niggs', 'coons', 'nigga', 'negro',
  'pikey', 'fagot', 'kikes', 'gooks', 'chink', 'abbos']);
// CRUDE: real dictionary words - fully valid GUESSES (this is what the
// actual official Wordle valid-guess list allows; a word game shouldn't
// second-guess a player's correct answer just because it's vulgar) but
// never the auto-picked, publicly-revealed SOLUTION.
const CRUDE = new Set(['asses', 'bitch', 'whore', 'penis', 'boner', 'semen', 'prick',
  'pussy', 'twats', 'cunts', 'dicks', 'cocks', 'titty', 'boobs', 'queef', 'shits',
  'turds', 'dildo', 'gonad', 'pubes', 'pubic', 'rapes', 'raped', 'raper', 'nazis',
  'homos', 'dykes', 'wanks', 'wanky', 'spunk', 'horny', 'nonce', 'pedos', 'paedo',
  'porno', 'porns', 'sperm', 'vulva', 'labia', 'anals', 'feces', 'urine', 'bimbo',
  'hussy', 'jizzy', 'jizzs', 'busty', 'felch', 'panty', 'kinky']);
// SOFT_BAD: dual-use words with an innocent primary meaning we'd still
// rather not have the game randomly announce as "today's word".
const SOFT_BAD = new Set(['spook', 'dinge', 'swart', 'moola', 'wench',
  'lynch', 'slave', 'harem', 'biddy', 'hoors', 'negus',
  'jihad', 'aryan', 'allah', 'nazes', 'fatwa', 'shoah']);
// Guesses are filtered by SLURS only - a real word game doesn't second-guess
// a technically-correct, merely-vulgar guess. Candidates (solutions) also
// exclude CRUDE and SOFT_BAD; see their admission filter below.
const isBad = (w) => SLURS.has(w);

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

const attested = (w) => gbRank.has(w) || subCount.has(w);
// A name-list hit only survives if Scrabble (or Knuth) says it's a real word.
const nameBlocked = (w) => names.has(w) && !scrab.has(w) && !sgb.has(w);

// Universe:
//  - Wordle-legal words backed by at least one other source (drops the NYT
//    list's oddities like "bilal" that no dictionary recognizes), plus
//  - extras beyond the Wordle list: wordnik entries with corroboration.
// NOTE: dwyl/words_alpha-ONLY words are deliberately excluded even when
// corpus-attested - that pool is dominated by place names, brands,
// contractions and non-English ("italy", "kodak", "thats", "bueno").
// This universe is effectively the entire clean 5-letter English lexicon;
// there is no honest source of further growth.
const universe = new Set([
  ...[...valid].filter((w) => scrab.has(w) || sgb.has(w) || wordnik.has(w) || dict.has(w)),
  ...sgb,
  ...[...wordnik].filter((w) => dict.has(w) || scrab.has(w) || attested(w)),
]);
// Admission requires Wordle- or Scrabble-legality. sgb stays an evidence
// boost only - Knuth's list carries corpus informalities ("thats", "legos").
// Solutions get the full three-tier filter (SLURS + CRUDE + SOFT_BAD) since
// this is the pool that gets randomly picked AND publicly revealed; GUESSES
// (below) only excludes SLURS.
const candidates = [...universe].filter(
  (w) => (valid.has(w) || scrab.has(w))
    && !isBad(w) && !CRUDE.has(w) && !SOFT_BAD.has(w) && !nameBlocked(w)
);

// Evidence score: independent attestations stack, so real words rise and
// single-corpus noise (OCR errors, dialect spellings) sinks.
const evidence = (w) => {
  let ev = 0;
  if (sgb.has(w)) ev += 6;
  if (valid.has(w)) ev += 2;
  if (dict.has(w)) ev += 1.5;
  if (wordnik.has(w)) ev += 1.5;
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

candidates.sort((a, b) => evidence(b) - evidence(a) || tiebreak(a) - tiebreak(b) || (a < b ? -1 : 1));
// IMPORTANT: solutions stay sorted commonest-first; standard mode biases
// random picks toward the front so everyday words dominate casual play.
const solutions = candidates.slice(0, Math.min(TARGET, candidates.length));

// ---- difficulty tiers ---------------------------------------------------
// score = commonness percentile (position in the evidence ranking) plus
// structural penalties; lower = easier to guess.
const RARE = new Set(['j', 'q', 'x', 'z']);
const structural = (w) => {
  let pen = 0;
  if (new Set(w).size < w.length) pen += 8;           // duplicate letters
  const rare = [...w].filter((ch) => RARE.has(ch)).length;
  pen += Math.min(12, rare * 6);                       // rare letters
  return pen;
};
const scored = solutions.map((w, i) => ({
  w,
  score: (i / solutions.length) * 100 + structural(w),
}));
scored.sort((a, b) => a.score - b.score || (a.w < b.w ? -1 : 1));
const easy = scored.slice(0, TIER_SIZES.easy).map((x) => x.w);
const medium = scored.slice(TIER_SIZES.easy, TIER_SIZES.easy + TIER_SIZES.medium).map((x) => x.w);
const hard = scored
  .slice(TIER_SIZES.easy + TIER_SIZES.medium, TIER_SIZES.easy + TIER_SIZES.medium + TIER_SIZES.hard)
  .map((x) => x.w);

// Guess dictionary: the standard Wordle valid list plus every solution.
// Only SLURS are stripped - crude-but-real words (the CRUDE tier) stay
// guessable, matching the actual official Wordle valid-guess list. A
// FRIEND-mode setter can still choose any guessable word as their secret
// (including CRUDE ones - a knowing human choice, unlike an auto-pick).
const guesses = [...new Set([...valid, ...solutions])].filter((w) => !isBad(w)).sort();

mkdirSync(outDir, { recursive: true });
const pack = (name, words) =>
  `export const ${name} = ${JSON.stringify(words.join(''))}.match(/.{5}/g);\n`;
const header = '// Generated by tools/build-words.mjs - do not edit by hand.\n';
writeFileSync(join(outDir, 'solutions.js'), header + pack('SOLUTIONS', solutions));
writeFileSync(join(outDir, 'guesses.js'), header + pack('GUESSES', guesses));
writeFileSync(
  join(outDir, 'tiers.js'),
  header
  + '// Score-ordered difficulty slices of SOLUTIONS (see build-words.mjs).\n'
  + pack('EASY', easy) + pack('MEDIUM', medium) + pack('HARD', hard)
);
console.log(`pool: ${candidates.length}  solutions: ${solutions.length}  guesses: ${guesses.length}`);
console.log(`tiers: easy ${easy.length}  medium ${medium.length}  hard ${hard.length}`);
console.log('easy sample:', easy.slice(0, 12).join(' '), '|', easy.slice(-6).join(' '));
console.log('medium sample:', medium.slice(0, 6).join(' '), '|', medium.slice(-6).join(' '));
console.log('hard sample:', hard.slice(0, 6).join(' '), '|', hard.slice(-6).join(' '));
console.log('deep tail:', solutions.slice(-12).join(' '));
