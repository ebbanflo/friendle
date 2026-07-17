// THE single registry of broadcast event types. Every message on the wire is
// the envelope {t, from, d} sent under the one broadcast event name 'game'.
//
// TRAP GUARD: `HOST_BROADCASTS` lists every event type the host can emit.
// Client.js asserts at startup that it has a handler for each one - adding a
// host event here without wiring a guest handler throws immediately instead
// of guests silently ignoring it.

export const EVENT_NAME = 'game';

// ---- intents: player -> host -------------------------------------------
export const IN = {
  JOIN: 'join',         // {name}
  GUESS: 'guess',       // {no, row, word, elapsed}
  SECRET: 'secret',     // FRIEND setter -> host {x: obfuscated word}
  BUY: 'buy',           // {item, target?, stake?}
  DUEL_GUESS: 'dguess', // {word}
  QUIT: 'quit',         // {} (sender leaves; host handles + mirrors)
  RESYNC: 'resyncreq',  // {} ask host for a full snapshot
};

// ---- broadcasts: host -> everyone (or addressed via d.to) ----------------
export const EV = {
  LOBBY: 'lobby',        // {players, settings, hostId, started}
  JOIN_ERR: 'joinerr',   // {to, reason}
  START: 'start',        // {settings, players}
  WORD: 'word',          // {no, total, phase:'set'|'play', setterId?, timerMs, pot, scores, anted?}
  RESULT: 'result',      // {pid, no, row, colors, solved, done}
  BAD_GUESS: 'badguess', // {to, no, reason}
  SET_ERR: 'seterr',     // {to, reason}   FRIEND: setter word rejected
  TIME_UP: 'timeup',     // {no}
  REVEAL: 'reveal',      // {no, word, winner, deltas, scores, pot, eliminated, reason}
  SCORES: 'scores',      // {scores, buyer?, item?}
  SHOP_ERR: 'shoperr',   // {to, reason}
  FREEZE: 'freeze',      // {from, ms}
  HINT: 'hint',          // {to, col, letter}
  PEEK: 'peek',          // {to, target, row, col, letter}
  SMUDGE: 'smudge',      // {to, letter}
  DUEL_START: 'duelstart', // {a, b, stake}
  DUEL_ROW: 'duelrow',   // {pid, row, word, colors, solved}
  DUEL_END: 'duelend',   // {winner, loser, stake, draw, word, scores, eliminated}
  RESUME: 'resume',      // {no, remainingMs} word continues after a duel
  PLAYER_LEFT: 'left',   // {pid}
  GAME_OVER: 'gameover', // {standings, winner, reason}
  ROOM_DEAD: 'roomdead', // {} host is closing the room
  RESYNC: 'resync',      // {to, snapshot}
};

export const HOST_BROADCASTS = Object.values(EV);
export const INTENTS = Object.values(IN);

const all = [...HOST_BROADCASTS, ...INTENTS];
if (new Set(all).size !== all.length) {
  throw new Error('protocol.js: duplicate event type in registry');
}
