// Mirror: the client-side state EVERY peer renders from (host included - the
// host's own UI listens to its engine's broadcasts through the same path).
// Handles every host broadcast in protocol.js EV.* - asserted at startup so a
// new host event can never be silently ignored by guests (the classic bug).

import { WORD_LEN, MAX_ROWS, COUNTDOWN_MS } from './config.js';
import { EV, IN, HOST_BROADCASTS } from './protocol.js';
import { isValidGuess } from './words.js';
import { obf, deobf, now } from './util.js';

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
    this.oppWords = {};     // FRIEND setter only: pid -> {row: word}
    this.reactions = [];    // {from, target, emoji, at}, capped
    this.duel = null;
    this.tower = null;      // TOWER mode mirror: see onTower()
    this.pendingTower = 0;  // timestamp of an unanswered tower submit
    this.reveal = null;     // last REVEAL payload (for the interstitial)
    this.gameover = null;
    this.toast = null;

    const H = {
      [EV.LOBBY]: (d) => this.onLobby(d),
      [EV.JOIN_ERR]: (d) => { if (d.to === selfId) { this.joinError = d.reason; this.fire('joinerr', d); } },
      [EV.START]: (d) => this.onStart(d),
      [EV.WORD]: (d) => this.onWord(d),
      [EV.RESULT]: (d) => this.onResult(d),
      [EV.SETTER_LETTERS]: (d) => this.onSetterLetters(d),
      [EV.REACTION]: (d) => this.onReaction(d),
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
      [EV.TOWER]: (d) => this.onTower(d),
      [EV.TOWER_WORD]: (d) => this.onTowerWord(d),
      [EV.TOWER_MISS]: (d) => this.onTowerMiss(d),
      [EV.TOWER_HUNGER]: (d) => this.onTowerHunger(d),
      [EV.TOWER_REVIVE]: (d) => this.onTowerRevive(d),
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
    if (!d.started) {
      this.over = false; this.gameover = null; this.round = null;
      this.reveal = null; this.tower = null; this.duel = null;
    }
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
    this.tower = null;
    this.pendingTower = 0;
    this.fire('start', d);
  }

  resetRound(d) {
    this.round = {
      no: d.no, total: d.total, phase: d.phase, setterId: d.setterId || null,
      timerMs: d.timerMs || 0, pot: d.pot || 0, anted: d.anted || 0, tier: d.tier || null,
      unlockAt: 0, grids: {}, done: {}, suspended: false, timeUp: false,
    };
    this.input = '';
    this.pendingRow = -1;
    this.myWords = {};
    this.frozenUntil = 0;
    this.hints = {};
    this.peeks = [];
    this.kbOverride = {};
    this.oppWords = {};
    this.setterBusy = false;
  }

  onWord(d) {
    if (!this.round || this.round.no !== d.no || d.phase === 'set') this.resetRound(d);
    const r = this.round;
    r.phase = d.phase;
    r.setterId = d.setterId || r.setterId;
    r.pot = d.pot ?? r.pot;
    r.anted = d.anted ?? r.anted;
    r.tier = d.tier ?? r.tier;
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
    } else if (this.oppWords[d.pid]?.[d.row]) {
      entry.word = this.oppWords[d.pid][d.row]; // setter's live letter feed
    }
    rows[d.row] = entry;
    if (d.done) r.done[d.pid] = d.solved ? 'solved' : 'failed';
    this.fire('result', d);
  }

  // FRIEND: addressed to the setter - actual letters of a rival's guess.
  onSetterLetters(d) {
    if (d.to !== this.selfId) return;
    const r = this.round;
    if (!r || d.no !== r.no) return;
    let word = '';
    try { word = deobf(d.x, this.code).toLowerCase(); } catch { return; }
    (this.oppWords[d.pid] || (this.oppWords[d.pid] = {}))[d.row] = word;
    const entry = r.grids[d.pid]?.[d.row];
    if (entry) entry.word = word; // RESULT usually lands first; attach either way
    this.fire('sletters', { pid: d.pid, row: d.row });
  }

  onReaction(d) {
    this.reactions.push({ from: d.from, target: d.target, emoji: d.emoji, at: now() });
    if (this.reactions.length > 50) this.reactions.shift();
    this.fire('reaction', d);
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

  // ---------- TOWER ----------
  onTower(d) {
    const t = this.tower || (this.tower = { rows: [], revives: {} });
    t.stage = d.stage;
    t.constraint = d.constraint;
    t.height = d.height;
    t.combo = d.combo;
    t.hungerMs = d.hungerMs;
    t.lives = d.lives;
    t.hungerAt = now() + d.hungerMs;
    this.applyScores(d.scores);
    this.fire('tower', d);
  }

  onTowerWord(d) {
    const t = this.tower;
    if (!t) return;
    t.rows.push({ pid: d.pid, word: d.word, points: d.points });
    if (t.rows.length > 60) t.rows.shift();
    t.height = d.height;
    t.combo = d.combo;
    t.stage = d.stage;
    t.hungerAt = now() + t.hungerMs;
    const p = this.player(d.pid);
    if (p) p.score += d.points; // lean protocol: deltas, not snapshots
    if (d.pid === this.selfId) this.pendingTower = 0;
    this.fire('towerword', d);
  }

  onTowerMiss(d) {
    const t = this.tower;
    if (!t) return;
    t.lives = d.lives;
    t.combo = 0;
    if (d.pid === this.selfId) {
      this.pendingTower = 0;
      this.showToast(`\u{1F494} "${d.word.toUpperCase()}" — ${d.reason}`);
    }
    this.fire('towermiss', d);
  }

  onTowerHunger(d) {
    const t = this.tower;
    if (!t) return;
    t.lives = d.lives;
    t.combo = 0;
    t.hungerAt = now() + t.hungerMs;
    this.showToast('\u{1F480} THE TOWER HUNGERS — everyone bleeds!');
    this.fire('towerhunger', d);
  }

  onTowerRevive(d) {
    const t = this.tower;
    if (!t) return;
    if (d.phase === 'start') {
      t.revives[d.reviver] = { target: d.target, rows: [] };
      if (d.reviver === this.selfId) { this.input = ''; this.pendingTower = 0; }
    } else if (d.phase === 'row') {
      const rev = t.revives[d.reviver];
      if (rev) rev.rows[d.row] = { word: d.word, colors: d.colors };
      if (d.reviver === this.selfId) { this.input = ''; this.pendingTower = 0; }
    } else if (d.phase === 'end') {
      delete t.revives[d.reviver];
      if (d.lives) t.lives = d.lives;
      if (d.reviver === this.selfId) this.pendingTower = 0;
    }
    this.fire('towerrev', d);
  }

  myRevive() {
    return (this.tower && this.tower.revives[this.selfId]) || null;
  }

  myTowerLives() {
    return this.tower ? (this.tower.lives[this.selfId] ?? 0) : 0;
  }

  submitTower() {
    const word = this.input;
    if (word.length !== WORD_LEN) { this.fire('shake', {}); return false; }
    if (this.myRevive()) {
      // the rescue wordle is classic rules - typos are free here
      if (!isValidGuess(word)) { this.showToast('Not in dictionary'); this.fire('shake', {}); return false; }
    }
    // tower words are NOT pre-checked: the host judges, misses cost a life
    this.pendingTower = now();
    this.input = '';
    this.net.emit(IN.GUESS, { x: obf(word, this.code) });
    this.fire('submit', { tower: true, word });
    return true;
  }

  onDuelStart(d) {
    this.duel = { a: d.a, b: d.b, stake: d.stake, rows: [], turn: d.a, over: false, result: null };
    if (this.round) this.round.suspended = true;
    this.input = ''; // leftover mid-word typing must not bleed into the duel row
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
        r.grids[pid] = rows.map((row) => {
          let word;
          if (row.xword) { try { word = deobf(row.xword, this.code).toLowerCase(); } catch { /* skip */ } }
          return { colors: row.colors, solved: row.solved, word };
        });
        if (pid === this.selfId) {
          r.grids[pid].forEach((row, i) => { this.myWords[i] = row.word || ''; });
        } else {
          r.grids[pid].forEach((row, i) => {
            if (row.word) (this.oppWords[pid] || (this.oppWords[pid] = {}))[i] = row.word;
          });
        }
      }
    } else {
      this.round = null;
    }
    if (s.duel) {
      this.duel = { a: s.duel.a, b: s.duel.b, stake: s.duel.stake, turn: s.duel.turn, over: false, result: null, rows: s.duel.rows.map((x) => ({ ...x })) };
    }
    if (s.tower) {
      this.tower = {
        stage: s.tower.stage, constraint: s.tower.constraint,
        height: s.tower.height, combo: s.tower.combo,
        hungerMs: s.tower.hungerMs, lives: { ...s.tower.lives },
        hungerAt: now() + s.tower.hungerMs,
        rows: s.tower.rows.map((r) => ({ ...r })),
        revives: Object.fromEntries((s.tower.reviving || []).map((r) => [
          r.reviver, { target: r.target, rows: r.rows.map((x) => ({ ...x })) },
        ])),
      };
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
    if (this.settings?.mode === 'tower') {
      if (!this.started || this.over || !this.tower) return true;
      if (this.myRevive()) return false;          // typing the rescue wordle
      if (this.myTowerLives() <= 0) return true;  // downed players watch
      return this.pendingTower > 0 && now() - this.pendingTower < 1500;
    }
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
    if (this.settings?.mode === 'tower') return this.submitTower();
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
    this.net.emit(IN.GUESS, { no: this.round.no, row, x: obf(word, this.code), elapsed });
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
    this.net.emit(IN.DUEL_GUESS, { x: obf(word, this.code) });
    this.fire('submit', { duel: true, word });
    return true;
  }

  buy(item, target, stake) {
    this.net.emit(IN.BUY, { item, target, stake });
  }

  react(emoji, target) {
    if (!this.amSetter() || !this.round || this.round.phase !== 'play') return false;
    this.net.emit(IN.REACT, { emoji, target });
    return true;
  }

  join(name) {
    this.net.emit(IN.JOIN, { name });
  }

  quit() {
    this.net.emit(IN.QUIT, {});
  }
}
