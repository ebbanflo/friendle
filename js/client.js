// Mirror: the client-side state EVERY peer renders from (host included - the
// host's own UI listens to its engine's broadcasts through the same path).
// Handles every host broadcast in protocol.js EV.* - asserted at startup so a
// new host event can never be silently ignored by guests (the classic bug).

import { WORD_LEN, MAX_ROWS, COUNTDOWN_MS } from './config.js';
import { EV, IN, HOST_BROADCASTS } from './protocol.js';
import { isValidGuess } from './words.js';
import { obf, now } from './util.js';

export class Mirror {
  constructor(net, code, selfId) {
    this.net = net;
    this.code = code;
    this.selfId = selfId;
    this.listeners = [];

    // lobby/global
    this.hostId = null;
    this.players = [];
    this.settings = null;
    this.started = false;
    this.over = false;
    this.joinError = null;
    this.roomDead = false;

    // per-round
    this.round = null;      // see resetRound()
    this.input = '';        // letters typed in the active row
    this.pendingRow = -1;   // row submitted, awaiting RESULT/BAD_GUESS
    this.myWords = {};      // row -> letters I typed (for rendering own grid)
    this.frozenUntil = 0;
    this.hints = {};        // col -> letter (from HINT)
    this.peeks = [];        // {target,row,col,letter} (from PEEK)
    this.kbOverride = {};   // letter -> rowCount at smudge time
    this.duel = null;
    this.reveal = null;     // last REVEAL payload (for the interstitial)
    this.gameover = null;
    this.toast = null;

    const H = {
      [EV.LOBBY]: (d) => this.onLobby(d),
      [EV.JOIN_ERR]: (d) => { if (d.to === selfId) { this.joinError = d.reason; this.fire('joinerr', d); } },
      [EV.START]: (d) => this.onStart(d),
      [EV.WORD]: (d) => this.onWord(d),
      [EV.RESULT]: (d) => this.onResult(d),
      [EV.BAD_GUESS]: (d) => this.onBadGuess(d),
      [EV.SET_ERR]: (d) => { if (d.to === selfId) { this.setterBusy = false; this.showToast(d.reason); this.fire('seterr', d); } },
      [EV.TIME_UP]: (d) => this.onTimeUp(d),
      [EV.REVEAL]: (d) => this.onReveal(d),
      [EV.SCORES]: (d) => this.onScores(d),
      [EV.SHOP_ERR]: (d) => { if (d.to === selfId) { this.showToast(d.reason); this.fire('shoperr', d); } },
      [EV.FREEZE]: (d) => this.onFreeze(d),
      [EV.HINT]: (d) => { if (d.to === selfId) { this.hints[d.col] = d.letter; this.fire('hint', d); } },
      [EV.PEEK]: (d) => { if (d.to === selfId) { this.peeks.push(d); this.fire('peek', d); } },
      [EV.SMUDGE]: (d) => this.onSmudge(d),
      [EV.DUEL_START]: (d) => this.onDuelStart(d),
      [EV.DUEL_ROW]: (d) => this.onDuelRow(d),
      [EV.DUEL_END]: (d) => this.onDuelEnd(d),
      [EV.RESUME]: (d) => this.onResume(d),
      [EV.PLAYER_LEFT]: (d) => this.onPlayerLeft(d),
      [EV.GAME_OVER]: (d) => this.onGameOver(d),
      [EV.ROOM_DEAD]: () => { this.roomDead = true; this.fire('roomdead', {}); },
      [EV.RESYNC]: (d) => { if (d.to === selfId) this.applySnapshot(d.snapshot); },
    };

    // TRAP GUARD: every host broadcast type must be wired here.
    for (const t of HOST_BROADCASTS) {
      if (!H[t]) throw new Error(`Mirror is missing a handler for host event '${t}'`);
      net.on(t, H[t]);
    }
  }

  // ---------- pub/sub ----------
  onChange(fn) { this.listeners.push(fn); }
  fire(type, d = {}) { for (const fn of this.listeners) fn(type, d); }
  showToast(msg) { this.toast = msg; this.fire('toast', { msg }); }

  me() { return this.players.find((p) => p.id === this.selfId); }
  player(id) { return this.players.find((p) => p.id === id); }
  isHost() { return this.hostId === this.selfId; }
  amSetter() { return this.round && this.round.setterId === this.selfId; }
  amSpectator() {
    const me = this.me();
    return !me || me.spectator || !me.alive;
  }
  amGuesser() {
    return this.started && !this.over && this.round && !this.amSpectator() && !this.amSetter();
  }

  // ---------- handlers ----------
  onLobby(d) {
    this.hostId = d.hostId;
    this.players = d.players;
    this.settings = d.settings;
    this.started = d.started;
    if (!d.started) { this.over = false; this.gameover = null; this.round = null; this.reveal = null; }
    this.fire('lobby', d);
  }

  onStart(d) {
    this.settings = d.settings;
    for (const sp of d.players) {
      const p = this.player(sp.id);
      if (p) Object.assign(p, sp);
    }
    this.started = true;
    this.over = false;
    this.gameover = null;
    this.reveal = null;
    this.fire('start', d);
  }

  resetRound(d) {
    this.round = {
      no: d.no, total: d.total, phase: d.phase, setterId: d.setterId || null,
      timerMs: d.timerMs || 0, pot: d.pot || 0, anted: d.anted || 0,
      unlockAt: 0, grids: {}, done: {}, suspended: false, timeUp: false,
    };
    this.input = '';
    this.pendingRow = -1;
    this.myWords = {};
    this.frozenUntil = 0;
    this.hints = {};
    this.peeks = [];
    this.kbOverride = {};
    this.setterBusy = false;
  }

  onWord(d) {
    if (!this.round || this.round.no !== d.no || d.phase === 'set') this.resetRound(d);
    const r = this.round;
    r.phase = d.phase;
    r.setterId = d.setterId || r.setterId;
    r.pot = d.pot ?? r.pot;
    r.anted = d.anted ?? r.anted;
    if (d.scores) this.applyScores(d.scores);
    if (d.phase === 'play') r.unlockAt = now() + (this.settings?.countdownMs ?? COUNTDOWN_MS);
    this.reveal = null;
    this.fire('word', d);
  }

  myRows() { return (this.round && this.round.grids[this.selfId]) || []; }

  onResult(d) {
    const r = this.round;
    if (!r || d.no !== r.no) return;
    const rows = r.grids[d.pid] || (r.grids[d.pid] = []);
    const entry = { colors: d.colors, solved: d.solved };
    if (d.pid === this.selfId) {
      entry.word = this.myWords[d.row] || '';
      if (this.pendingRow === d.row) { this.pendingRow = -1; this.input = ''; }
    }
    rows[d.row] = entry;
    if (d.done) r.done[d.pid] = d.solved ? 'solved' : 'failed';
    this.fire('result', d);
  }

  onBadGuess(d) {
    if (d.to !== this.selfId) return;
    if (this.pendingRow >= 0) {
      // restore the letters so the player can edit instead of retyping
      this.input = this.myWords[this.pendingRow] || '';
      delete this.myWords[this.pendingRow];
      this.pendingRow = -1;
    }
    this.showToast(d.reason === 'frozen' ? 'Frozen! \u{1F9CA}' : 'Not a valid word');
    this.fire('badguess', d);
  }

  onTimeUp(d) {
    const r = this.round;
    if (!r || d.no !== r.no) return;
    r.timeUp = true;
    for (const p of this.players) {
      if (!r.done[p.id] && p.id !== r.setterId) r.done[p.id] = 'timeout';
    }
    this.fire('timeup', d);
  }

  onReveal(d) {
    this.reveal = d;
    this.lastReveal = d; // kept after the overlay clears (tests + late joins)
    this.applyScores(d.scores);
    for (const pid of d.eliminated || []) {
      const p = this.player(pid);
      if (p) { p.alive = false; p.spectator = true; }
    }
    if (this.round) this.round.pot = d.pot;
    this.fire('reveal', d);
  }

  onScores(d) { this.applyScores(d.scores); this.fire('scores', d); }

  applyScores(scores) {
    for (const [pid, s] of Object.entries(scores || {})) {
      const p = this.player(pid);
      if (p) p.score = s;
    }
  }

  onFreeze(d) {
    if (d.from !== this.selfId && this.amGuesser() && !this.round.done[this.selfId]) {
      this.frozenUntil = now() + d.ms;
    }
    this.fire('freeze', d);
  }

  onSmudge(d) {
    if (d.to !== this.selfId) return;
    // Forget everything past guesses said about this letter; a later guess
    // that uses it will re-establish the truth.
    this.kbOverride[d.letter] = this.myRows().length;
    this.fire('smudge', d);
  }

  onDuelStart(d) {
    this.duel = { a: d.a, b: d.b, stake: d.stake, rows: [], turn: d.a, over: false, result: null };
    if (this.round) this.round.suspended = true;
    this.fire('duelstart', d);
  }

  onDuelRow(d) {
    if (!this.duel) return;
    this.duel.rows[d.row] = { pid: d.pid, word: d.word, colors: d.colors, solved: d.solved };
    this.duel.turn = d.pid === this.duel.a ? this.duel.b : this.duel.a;
    if (this.duel.turn === this.selfId) this.input = '';
    this.fire('duelrow', d);
  }

  onDuelEnd(d) {
    if (this.duel) { this.duel.over = true; this.duel.result = d; }
    this.lastDuel = { rows: this.duel ? this.duel.rows.map((r) => ({ ...r })) : [], result: d };
    this.applyScores(d.scores);
    for (const pid of d.eliminated || []) {
      const p = this.player(pid);
      if (p) { p.alive = false; p.spectator = true; }
    }
    this.fire('duelend', d);
    // keep the result on screen briefly; RESUME clears it
  }

  onResume(d) {
    this.duel = null;
    if (this.round) {
      this.round.suspended = false;
      if (d.remainingMs > 0) this.round.unlockAt = now() - (this.round.timerMs - d.remainingMs);
    }
    this.input = '';
    this.fire('resume', d);
  }

  onPlayerLeft(d) {
    const p = this.player(d.pid);
    if (p) p.connected = false;
    this.fire('left', d);
  }

  onGameOver(d) {
    this.over = true;
    this.gameover = d;
    this.round = null;
    this.duel = null;
    this.fire('gameover', d);
  }

  applySnapshot(s) {
    this.hostId = s.hostId;
    this.settings = s.settings;
    this.started = s.started;
    this.over = s.over;
    this.players = s.players;
    if (s.round) {
      this.resetRound(s.round);
      const r = this.round;
      r.pot = s.pot;
      r.suspended = s.round.suspended;
      r.done = s.round.done || {};
      if (s.round.phase === 'play') {
        r.unlockAt = now() - 1; // already unlocked; timer display uses remainingMs
        if (s.round.timerMs) r.unlockAt = now() + s.round.remainingMs - s.round.timerMs;
      }
      for (const [pid, rows] of Object.entries(s.round.grids || {})) {
        r.grids[pid] = rows.map((row) => ({ colors: row.colors, solved: row.solved, word: row.word }));
        if (pid === this.selfId) rows.forEach((row, i) => { this.myWords[i] = row.word || ''; });
      }
    } else {
      this.round = null;
    }
    if (s.duel) {
      this.duel = { a: s.duel.a, b: s.duel.b, stake: s.duel.stake, turn: s.duel.turn, over: false, result: null, rows: s.duel.rows.map((x) => ({ ...x })) };
    }
    this.fire('resync', s);
  }

  // ---------- keyboard state (own letters only) ----------
  keyboardState() {
    const rank = { g: 3, y: 2, x: 1 };
    const best = {};
    const rows = this.myRows();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.word) continue;
      for (let j = 0; j < row.word.length; j++) {
        const L = row.word[j];
        if ((this.kbOverride[L] ?? -1) > i) continue; // smudged: ignore older evidence
        const c = row.colors[j];
        if ((rank[c] || 0) > (rank[best[L]] || 0)) best[L] = c;
      }
    }
    return best;
  }

  frozen() { return this.frozenUntil > now(); }

  inputLocked() {
    if (this.duel && !this.duel.over) return this.duel.turn !== this.selfId;
    if (!this.round) return true;
    if (this.round.phase === 'set') return !this.amSetter() || this.setterBusy;
    if (this.round.suspended || this.round.timeUp) return true;
    if (this.amSetter() || this.amSpectator()) return true;
    if (this.round.done[this.selfId]) return true;
    if (this.pendingRow >= 0) return true;
    if (now() < this.round.unlockAt) return true;
    return this.frozen();
  }

  // ---------- intents ----------
  type(letter) {
    if (this.inputLocked() || this.input.length >= WORD_LEN) return false;
    this.input += letter.toLowerCase();
    this.fire('type', { letter });
    return true;
  }

  backspace() {
    if (this.inputLocked() || this.input.length === 0) return false;
    this.input = this.input.slice(0, -1);
    this.fire('type', { back: true });
    return true;
  }

  enter() {
    if (this.inputLocked()) return false;
    if (this.duel && !this.duel.over) return this.submitDuelGuess();
    if (this.round.phase === 'set') return this.submitSecret();
    return this.submitGuess();
  }

  submitGuess() {
    const word = this.input;
    if (word.length !== WORD_LEN) { this.fire('shake', {}); return false; }
    if (!isValidGuess(word)) { this.showToast('Not in dictionary'); this.fire('shake', {}); return false; }
    const row = this.myRows().length;
    if (row >= MAX_ROWS) return false;
    this.myWords[row] = word;
    this.pendingRow = row;
    const elapsed = Math.max(0, now() - this.round.unlockAt);
    this.net.emit(IN.GUESS, { no: this.round.no, row, word, elapsed });
    this.fire('submit', { row, word });
    return true;
  }

  submitSecret() {
    const word = this.input;
    if (word.length !== WORD_LEN) { this.fire('shake', {}); return false; }
    if (!isValidGuess(word)) { this.showToast('Not in dictionary'); this.fire('shake', {}); return false; }
    this.setterBusy = true; // until SET_ERR or WORD(play)
    this.input = '';
    this.net.emit(IN.SECRET, { x: obf(word, this.code) });
    this.fire('secretsent', {});
    return true;
  }

  submitDuelGuess() {
    const word = this.input;
    if (word.length !== WORD_LEN) { this.fire('shake', {}); return false; }
    if (!isValidGuess(word)) { this.showToast('Not in dictionary'); this.fire('shake', {}); return false; }
    this.net.emit(IN.DUEL_GUESS, { word });
    this.fire('submit', { duel: true, word });
    return true;
  }

  buy(item, target, stake) {
    this.net.emit(IN.BUY, { item, target, stake });
  }

  join(name) {
    this.net.emit(IN.JOIN, { name });
  }

  quit() {
    this.net.emit(IN.QUIT, {});
  }
}
