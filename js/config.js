// Central configuration. The Supabase project is shared with the sibling game
// HMMM? (channel prefix `hmmm:`); FRIENDLE MUST keep its own `friendle:` prefix.
export const SUPABASE_URL = 'https://lapkrvmlmwfrwqmzxukt.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_M9Xu80-XQ1Vyjg55T-Cp8g_2EnL2_Mm';
export const CHANNEL_PREFIX = 'friendle:';

// Room codes: 4 chars, no lookalikes (O/0, I/1 excluded).
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 4;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const WORD_LEN = 5;
export const MAX_ROWS = 6;

// Photo-finish grace: after the first correct solve reaches the host, wait
// this long for competing solves, then the smallest client-reported elapsed
// wins - network lag never decides a close race.
export const GRACE_MS = 350;

export const COUNTDOWN_MS = 3000;   // "get ready" before each word unlocks
export const TIMER_SLACK_MS = 750;  // host waits this beyond the timer before calling time

export const SCORING = {
  base: 100,           // solver base
  perRowSaved: 20,     // * (6 - rowsUsed)
  speedMax: 50,        // Classic: decays to 0 over speedWindowMs
  speedWindowMs: 60000,
  latePct: 0.4,        // Classic: later solvers get this fraction of their formula
  // FRIEND: ranked by FEWEST guesses (not time); every solver gets the full
  // base + perRowSaved formula, and the setter earns per stumped guesser.
  setterPerStump: 100,
};

export const ROYALE = {
  startScore: 1000,
  antes: [25, 50, 100],
  duelMaxStake: 200,
};

export const SHOP = {
  peek:   { price: 75,  emoji: '\u{1F50D}', name: 'Peek',   desc: "Reveal one real letter from an opponent's latest guess", target: 'opponent' },
  freeze: { price: 100, emoji: '\u{1F9CA}', name: 'Freeze', desc: "Lock all opponents' keyboards for 5 seconds", target: null },
  hint:   { price: 75,  emoji: '\u{1F4A1}', name: 'Hint',   desc: 'Reveal one green letter in your own grid', target: null },
  smudge: { price: 100, emoji: '\u{1F5D1}️', name: 'Smudge', desc: "Un-gray one letter on an opponent's keyboard", target: 'opponent' },
  duel:   { price: 0,   emoji: '⚔️',  name: 'Duel',   desc: 'Stake points, alternate guesses on a fresh word (Classic & Royale)', target: 'opponent' },
  revive: { price: 5000, emoji: '✨', name: 'Revive', desc: 'TOWER only: solve a classic wordle to bring a fallen teammate back with 2 lives', target: 'downed' },
};
export const FREEZE_MS = 5000;

// TOWER mode (co-op, 1-4 players, endless): stack valid words under an
// escalating DECREE. Misses cost lives; the hunger clock keeps the team
// moving; scores are RPG-huge on purpose.
export const TOWER = {
  lives: 3,
  maxLives: 5,             // cap for bonus hearts (milestones/easter eggs)
  reviveCost: 5000,
  reviveLives: 2,          // a revived teammate comes back with 2
  // Words needed per decree before it escalates - host-set directly (see
  // RAMP_WORDS_MIN/MAX below), NOT tied to an easy/medium/hard label.
  // Counterintuitively, a LOW count plays easier: the team cycles to a
  // fresh (often gentler) constraint before their collective vocabulary for
  // any one decree runs dry; a HIGH count forces them to keep finding
  // distinct words under the SAME brutal constraint until they're stuck.
  defaultRampWords: 5,
  hungerMs: 35000,         // silence = everyone bleeds (flat, not difficulty-tied)
  base: 500,               // per-word base, before letter values and stage
  perLetterValue: 50,      // * scrabble-ish letter value
  comboPct: 0.1,           // * combo count, multiplicative
  minWordsPerDecree: 4,    // a decree must leave at least this many words possible
  heartEveryHeight: 10,    // team-wide bonus heart every N floors climbed
};
export const RAMP_WORDS_MIN = 2;
export const RAMP_WORDS_MAX = 10;
export const LETTER_VALUES = {
  a: 1, e: 1, i: 1, o: 1, u: 1, l: 1, n: 1, s: 1, t: 1, r: 1,
  d: 2, g: 2, b: 3, c: 3, m: 3, p: 3, f: 4, h: 4, v: 4, w: 4, y: 4,
  k: 5, j: 8, x: 8, q: 10, z: 10,
};

// FRIEND mode: the setter's heckling palette, one tap per guesser panel.
export const REACTIONS = ['\u{1F602}', '\u{1F525}', '\u{1F631}', '\u{1F440}', '\u{1F480}', '\u{1FAE0}', '\u{1F9E0}'];
export const REACT_COOLDOWN_MS = 600; // host-enforced spam brake

export const TIMER_CHOICES = [0, 60000, 90000, 120000]; // 0 = no timer
export const WORDS_CHOICES = [3, 5, 10];

// Word difficulty (Classic & Royale). 'standard' = the classic random-word
// experience over the full bank, ignoring difficulty classifications;
// 'ramp' climbs easy -> medium -> hard as the game progresses.
export const DIFFICULTY_CHOICES = ['standard', 'easy', 'medium', 'hard', 'ramp'];

export const DEFAULT_SETTINGS = {
  mode: 'classic',        // 'classic' | 'royale' | 'friend' | 'tower'
  words: 5,               // classic & friend
  ante: 50,               // royale
  difficulty: 'standard', // classic & royale, see DIFFICULTY_CHOICES
  rampWords: TOWER.defaultRampWords, // tower: words per decree, host-set 2-10
  timerMs: 0,             // 0 = none
  revealMs: 4000,         // interstitial between words (tests shrink it)
  countdownMs: COUNTDOWN_MS, // pre-word 3-2-1 (tests shrink it)
};

// Signature colors by join order (panel borders, stamps, labels).
export const PLAYER_COLORS = ['#ff4fd8', '#3ddcff', '#a6ff4f', '#ffb84f'];

// Presence timing (transport-level).
export const HEARTBEAT_MS = 800;       // LocalTransport heartbeat
export const PRESENCE_TIMEOUT_MS = 2600;
export const LEAVE_GRACE_MS = 8000;    // gone this long = treated as quit
                                       // (roomy: phone locks and radio blips
                                       //  make presence flap for seconds)

export const ERR_NAPPING =
  'The server is napping \u{1F634} — the owner can wake it in the Supabase dashboard.';
