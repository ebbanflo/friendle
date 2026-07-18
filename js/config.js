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
  base: 100,           // first solver base
  perRowSaved: 20,     // * (6 - rowsUsed)
  speedMax: 50,        // decays to 0 over speedWindowMs
  speedWindowMs: 60000,
  latePct: 0.4,        // later solvers get this fraction of their own formula
  setterPoints: 150,   // FRIEND: nobody solved -> setter scores
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
  duel:   { price: 0,   emoji: '⚔️',  name: 'Duel',   desc: 'Royale only: stake points, alternate guesses on a fresh word', target: 'opponent' },
};
export const FREEZE_MS = 5000;

// FRIEND mode: the setter's heckling palette, one tap per guesser panel.
export const REACTIONS = ['\u{1F602}', '\u{1F525}', '\u{1F631}', '\u{1F440}', '\u{1F480}', '\u{1FAE0}'];
export const REACT_COOLDOWN_MS = 600; // host-enforced spam brake

export const TIMER_CHOICES = [0, 60000, 90000, 120000]; // 0 = no timer
export const WORDS_CHOICES = [3, 5, 10];

export const DEFAULT_SETTINGS = {
  mode: 'classic',        // 'classic' | 'royale' | 'friend'
  words: 5,               // classic & friend
  ante: 50,               // royale
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
