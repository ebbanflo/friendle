// Host-authoritative game engine. Runs ONLY in the host's browser: it owns
// the secret words, validates every guess and purchase, arbitrates who solved
// first (with a grace window so lag never decides a photo finish), and keeps
// all scores and pots. Guests only send intents (protocol.js IN.*) and mirror
// the host's broadcasts (EV.*).
//
// Secrets never appear in any broadcast until the round's REVEAL - only
// color-result strings and score deltas go over the wire.

import {
  MAX_PLAYERS, MIN_PLAYERS, MAX_ROWS, GRACE_MS, COUNTDOWN_MS, TIMER_SLACK_MS,
  SCORING, ROYALE, SHOP, FREEZE_MS, DEFAULT_SETTINGS, PLAYER_COLORS, LEAVE_GRACE_MS,
} from './config.js';
import { EV, IN } from './protocol.js';
import { pickWord, scoreGuess, isValidGuess } from './words.js';
import { deobf, now } from './util.js';

const SET_TIMEOUT_MS = 75000; // FRIEND: setter stalls -> rotate onward

export class Engine {
  constructor(net, code, host) {
    this.net = net;
    this.code = code;
    this.hostId = host.id;
    this.players = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.started = false;
    this.over = false;
    this.usedWords = new Set();
    this.round = null;
    this.duel = null;
    this.frozenUntil = {};
    this.missingSince = new Map();
    this.everSeen = new Set(); // peers confirmed via presence at least once
    this.timers = {};
    this.setterCursor = -1;

    this.addPlayer(host.id, host.name);

    net.on(IN.JOIN, (d, from) => this.onJoin(d, from));
    net.on(IN.GUESS, (d, from) => this.onGuess(d, from));
    net.on(IN.SECRET, (d, from) => this.onSecret(d, from));
    net.on(IN.BUY, (d, from) => this.onBuy(d, from));
    net.on(IN.DUEL_GUESS, (d, from) => this.onDuelGuess(d, from));
    net.on(IN.QUIT, (_d, from) => this.onLeave(from, 'quit'));
    net.on(IN.RESYNC, (_d, from) => this.sendResync(from));

    net.transport.onPresence((present) => this.onPresence(present));
    // A live intent from a "disconnected" player proves they're back (their
    // socket blipped, presence lagged, phone woke up) - reinstate + resync.
    net.onAny((env) => {
      if (!env || env.t === IN.QUIT) return;
      const p = this.player(env.from);
      if (p && !p.connected && this.started && !this.over) {
        p.connected = true;
        this.missingSince.delete(p.id);
        this.broadcastLobby(); // roster refresh; guests keep their game screens
        this.sendResync(p.id);
      }
    });
    this._sweep = setInterval(() => this.sweepMissing(), 1000);
  }

  // ---------- lobby ----------
  addPlayer(id, name) {
    const p = {
      id,
      name: String(name || 'PLAYER').slice(0, 12).toUpperCase() || 'PLAYER',
      color: PLAYER_COLORS[this.players.length % PLAYER_COLORS.length],
      score: 0,
      alive: true,
      connected: true,
      spectator: false,
    };
    this.players.push(p);
    return p;
  }

  player(id) { return this.players.find((p) => p.id === id); }

  onJoin(d, from) {
    const existing = this.player(from);
    if (existing) {
      // Rejoin after a reload/drop: reinstate and resync.
      existing.connected = true;
      this.missingSince.delete(from);
      this.broadcastLobby();
      if (this.started) this.sendResync(from);
      return;
    }
    if (this.started) {
      this.net.emit(EV.JOIN_ERR, { to: from, reason: 'Game already started' });
      return;
    }
    if (this.players.length >= MAX_PLAYERS) {
      this.net.emit(EV.JOIN_ERR, { to: from, reason: 'Room is full (4 players max)' });
      return;
    }
    this.addPlayer(from, d.name);
    this.broadcastLobby();
  }

  setSettings(patch) {
    if (this.started) return;
    Object.assign(this.settings, patch);
    this.broadcastLobby();
  }

  broadcastLobby() {
    this.net.emit(EV.LOBBY, {
      hostId: this.hostId,
      started: this.started,
      settings: this.settings,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, score: p.score,
        alive: p.alive, connected: p.connected, spectator: p.spectator,
      })),
    });
  }

  start() {
    if (this.started || this.players.filter((p) => p.connected).length < MIN_PLAYERS) return;
    this.players = this.players.filter((p) => p.connected);
    this.players.forEach((p, i) => {
      p.color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      p.score = this.settings.mode === 'royale' ? ROYALE.startScore : 0;
      p.alive = true;
      p.spectator = false;
    });
    this.started = true;
    this.over = false;
    this.roundNo = 0;
    this.pot = 0;
    this.setterCursor = -1;
    this.net.emit(EV.START, {
      settings: this.settings,
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
    });
    this.timers.next = setTimeout(() => this.nextWord(), 1200);
  }

  // ---------- rounds ----------
  activePlayers() {
    return this.players.filter((p) => p.alive && p.connected && !p.spectator);
  }

  guessers() {
    const act = this.activePlayers();
    if (this.settings.mode === 'friend' && this.round) {
      return act.filter((p) => p.id !== this.round.setterId);
    }
    return act;
  }

  totalWords() {
    return this.settings.mode === 'royale' ? 0 : this.settings.words;
  }

  nextWord() {
    if (this.over) return;
    this.clearRoundTimers();
    this.roundNo += 1;
    const mode = this.settings.mode;

    this.round = {
      no: this.roundNo,
      word: null,
      phase: 'play',
      setterId: null,
      rows: {},        // pid -> [{word, colors}]
      done: {},        // pid -> 'solved'|'failed'|'timeout'|'left'
      solveCand: [],   // photo-finish candidates
      solveOrder: [],  // pids in decided solve order
      winner: null,
      deltas: {},
      startAt: 0,
      deadline: 0,
      suspended: false,
      remainingMs: 0,
    };
    this.frozenUntil = {};

    if (mode === 'friend') {
      const act = this.activePlayers();
      this.setterCursor = (this.setterCursor + 1) % act.length;
      this.round.setterId = act[this.setterCursor].id;
      this.round.phase = 'set';
      this.net.emit(EV.WORD, {
        no: this.round.no, total: this.totalWords(), phase: 'set',
        setterId: this.round.setterId, timerMs: this.settings.timerMs,
        scores: this.scoreMap(),
      });
      this.timers.setter = setTimeout(() => this.skipSetter('slow'), SET_TIMEOUT_MS);
      return;
    }

    // classic / royale: engine picks the secret
    this.round.word = pickWord(this.usedWords);
    this.usedWords.add(this.round.word);

    let anted = 0;
    if (mode === 'royale') {
      anted = this.settings.ante;
      for (const p of this.activePlayers()) {
        const pay = Math.min(anted, p.score);
        p.score -= pay;
        this.pot += pay;
      }
    }
    this.beginPlay({ anted });
  }

  beginPlay(extra = {}) {
    this.round.phase = 'play';
    this.round.startAt = now() + (this.settings.countdownMs ?? COUNTDOWN_MS);
    if (this.settings.timerMs > 0) {
      this.round.deadline = this.round.startAt + this.settings.timerMs + TIMER_SLACK_MS;
      this.armDeadline();
    }
    this.net.emit(EV.WORD, {
      no: this.round.no, total: this.totalWords(), phase: 'play',
      setterId: this.round.setterId, timerMs: this.settings.timerMs,
      pot: this.pot, scores: this.scoreMap(), ...extra,
    });
  }

  armDeadline() {
    clearTimeout(this.timers.deadline);
    if (!this.round.deadline) return;
    this.timers.deadline = setTimeout(() => this.onTimeUp(), Math.max(0, this.round.deadline - now()));
  }

  onTimeUp() {
    if (!this.round || this.round.phase !== 'play' || this.round.suspended) return;
    this.net.emit(EV.TIME_UP, { no: this.round.no });
    for (const p of this.guessers()) {
      if (!this.round.done[p.id]) this.round.done[p.id] = 'timeout';
    }
    this.finishRound('timeout');
  }

  scoreMap() {
    const m = {};
    for (const p of this.players) m[p.id] = p.score;
    return m;
  }

  // ---------- FRIEND setter ----------
  onSecret(d, from) {
    const r = this.round;
    if (!r || r.phase !== 'set' || from !== r.setterId) return;
    let word = '';
    try { word = deobf(d.x, this.code).toLowerCase(); } catch { /* garbled */ }
    if (!isValidGuess(word)) {
      this.net.emit(EV.SET_ERR, { to: from, reason: 'Not in the dictionary — try another word' });
      return;
    }
    clearTimeout(this.timers.setter);
    r.word = word;
    this.usedWords.add(word);
    this.beginPlay({});
  }

  skipSetter(why) {
    const r = this.round;
    if (!r || r.phase !== 'set') return;
    // Setter stalled or left: rotate to the next active player this round.
    const act = this.activePlayers();
    if (act.length < 2) { this.gameOver('not enough players'); return; }
    this.setterCursor = this.setterCursor % act.length;
    const prev = r.setterId;
    this.setterCursor = (this.setterCursor + 1) % act.length;
    r.setterId = act[this.setterCursor].id;
    if (r.setterId === prev) { this.gameOver('not enough players'); return; }
    this.net.emit(EV.WORD, {
      no: r.no, total: this.totalWords(), phase: 'set',
      setterId: r.setterId, timerMs: this.settings.timerMs, scores: this.scoreMap(),
      skipped: why,
    });
    this.timers.setter = setTimeout(() => this.skipSetter('slow'), SET_TIMEOUT_MS);
  }

  // ---------- guessing ----------
  onGuess(d, from) {
    const r = this.round;
    if (!r || r.phase !== 'play' || r.suspended || this.over) return;
    const p = this.player(from);
    if (!p || !this.guessers().some((g) => g.id === from) || r.done[from]) return;
    const rows = r.rows[from] || (r.rows[from] = []);
    if (d.no !== r.no || d.row !== rows.length || rows.length >= MAX_ROWS) return;
    if ((this.frozenUntil[from] || 0) > now()) {
      this.net.emit(EV.BAD_GUESS, { to: from, no: r.no, reason: 'frozen' });
      return;
    }
    const word = String(d.word || '').toLowerCase();
    if (!isValidGuess(word)) {
      this.net.emit(EV.BAD_GUESS, { to: from, no: r.no, reason: 'invalid' });
      return;
    }
    const colors = scoreGuess(word, r.word);
    const solved = word === r.word;
    rows.push({ word, colors });
    const done = solved || rows.length >= MAX_ROWS;
    if (done) r.done[from] = solved ? 'solved' : 'failed';

    // Broadcast colors only - opponents mirror the grid without letters.
    this.net.emit(EV.RESULT, {
      pid: from, no: r.no, row: rows.length - 1, colors, solved, done,
    });

    if (solved) this.recordSolve(from, rows.length - 1, Number(d.elapsed) || 0);
    else this.maybeFinishRound();
  }

  recordSolve(pid, row, elapsed) {
    const r = this.round;
    (r.elapsedBy || (r.elapsedBy = {}))[pid] = elapsed;
    if (r.winner === null && !this.timers.grace) {
      // First solve in: hold the photo-finish window before declaring.
      r.solveCand.push({ pid, row, elapsed });
      this.timers.grace = setTimeout(() => this.closeGrace(), GRACE_MS);
    } else if (r.winner === null) {
      r.solveCand.push({ pid, row, elapsed });
    } else {
      r.solveOrder.push(pid); // late solver (classic/friend consolation)
      this.maybeFinishRound();
    }
  }

  // Smallest reported elapsed among grace-window candidates wins.
  decideWinner() {
    const r = this.round;
    if (!r || r.winner !== null || r.solveCand.length === 0) return;
    r.solveCand.sort((a, b) => a.elapsed - b.elapsed);
    r.winner = r.solveCand[0].pid;
    r.solveOrder = [r.winner, ...r.solveCand.slice(1).map((c) => c.pid),
      ...r.solveOrder.filter((pid) => pid !== r.winner)];
  }

  closeGrace() {
    this.timers.grace = null;
    const r = this.round;
    if (!r || r.winner !== null) return;
    this.decideWinner();
    if (this.settings.mode === 'royale') {
      // Pot decided - the word is over for everyone.
      for (const p of this.guessers()) {
        if (!r.done[p.id]) r.done[p.id] = 'lost';
      }
    }
    this.maybeFinishRound();
  }

  maybeFinishRound() {
    const r = this.round;
    if (!r || r.phase !== 'play' || r.finishing) return;
    if (this.timers.grace) return; // photo finish still open
    const pending = this.guessers().filter((p) => !r.done[p.id]);
    if (pending.length === 0) this.finishRound('done');
  }

  rowsUsed(pid) { return (this.round.rows[pid] || []).length; }

  finishRound(reason) {
    const r = this.round;
    if (!r || r.finishing) return;
    r.finishing = true;
    this.clearRoundTimers();
    // A timeout can land inside the open grace window - a solve recorded
    // there still wins the word.
    this.decideWinner();
    const mode = this.settings.mode;
    const deltas = {};

    if (mode === 'royale') {
      if (r.winner) {
        const w = this.player(r.winner);
        deltas[r.winner] = this.pot;
        w.score += this.pot;
        this.pot = 0;
      }
      // unsolved -> pot rolls over and grows
    } else {
      // classic & friend: formula points, first solver full, later solvers a cut
      for (const pid of r.solveOrder) {
        const p = this.player(pid);
        if (!p) continue;
        const rows = this.rowsUsed(pid);
        const elapsed = (r.elapsedBy || {})[pid] ?? SCORING.speedWindowMs;
        const speed = Math.max(0, Math.round(SCORING.speedMax * (1 - elapsed / SCORING.speedWindowMs)));
        const full = SCORING.base + (MAX_ROWS - rows) * SCORING.perRowSaved + speed;
        const pts = pid === r.winner ? full : Math.round(full * SCORING.latePct);
        deltas[pid] = pts;
        p.score += pts;
      }
      if (mode === 'friend' && !r.winner) {
        const s = this.player(r.setterId);
        if (s) { deltas[r.setterId] = SCORING.setterPoints; s.score += SCORING.setterPoints; }
      }
    }

    // Royale eliminations happen at reveal time: hit 0 and you spectate.
    const eliminated = [];
    if (mode === 'royale') {
      for (const p of this.activePlayers()) {
        if (p.score <= 0) { p.alive = false; p.spectator = true; eliminated.push(p.id); }
      }
    }

    this.net.emit(EV.REVEAL, {
      no: r.no, word: r.word, winner: r.winner, deltas,
      scores: this.scoreMap(), pot: this.pot, eliminated, reason,
    });

    const alive = this.players.filter((p) => p.alive && p.connected);
    const lastWord = mode !== 'royale' && r.no >= this.totalWords();
    const royaleOver = mode === 'royale' && alive.length <= 1;
    this.timers.next = setTimeout(() => {
      if (this.over) return;
      if (lastWord || royaleOver) this.gameOver(royaleOver ? 'last one standing' : 'all words played');
      else if (this.activePlayers().length < MIN_PLAYERS) this.gameOver('not enough players');
      else this.nextWord();
    }, this.settings.revealMs);
  }

  gameOver(reason) {
    if (this.over) return;
    this.over = true;
    this.round = null;
    this.duel = null;
    this.clearRoundTimers();
    const standings = [...this.players]
      .sort((a, b) => b.score - a.score || (a.alive === b.alive ? 0 : a.alive ? -1 : 1));
    const winner = this.settings.mode === 'royale'
      ? (this.players.find((p) => p.alive && p.connected) || standings[0])
      : standings[0];
    this.net.emit(EV.GAME_OVER, {
      reason,
      winner: winner ? winner.id : null,
      standings: standings.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
    });
  }

  playAgain() {
    if (!this.over) return;
    this.started = false;
    this.over = false;
    this.usedWords = new Set(this.usedWords); // used words persist across a session
    for (const p of this.players) { p.score = 0; p.alive = true; p.spectator = false; }
    this.players = this.players.filter((p) => p.connected);
    this.broadcastLobby();
  }

  // ---------- shop ----------
  onBuy(d, from) {
    const item = SHOP[d.item];
    const p = this.player(from);
    const r = this.round;
    const fail = (reason) => this.net.emit(EV.SHOP_ERR, { to: from, reason });

    if (!item || !p) return;
    if (this.settings.mode === 'friend') return fail('No shop in FRIEND mode');
    if (d.item === 'duel' && this.settings.mode !== 'royale') return fail('Duels are Royale-only');
    if (!r || r.phase !== 'play' || r.suspended || this.over) return fail('Not now');
    if (!p.alive || p.spectator) return fail('Spectators cannot buy');
    if (r.done[from] && d.item !== 'duel') return fail('You already finished this word');

    if (d.item === 'duel') return this.onDuelRequest(d, from, fail);

    if (p.score < item.price) return fail(`Need ${item.price} points`);

    let effect = null;
    if (d.item === 'peek') {
      const target = this.player(d.target);
      if (!target || target.id === from) return fail('Pick an opponent');
      const rows = r.rows[target.id] || [];
      if (rows.length === 0) return fail('They have no guesses yet');
      const last = rows[rows.length - 1];
      const col = Math.floor(Math.random() * last.word.length);
      effect = () => this.net.emit(EV.PEEK, {
        to: from, target: target.id, row: rows.length - 1, col, letter: last.word[col],
      });
    } else if (d.item === 'freeze') {
      const until = now() + FREEZE_MS;
      for (const g of this.guessers()) {
        if (g.id !== from && !r.done[g.id]) this.frozenUntil[g.id] = until;
      }
      effect = () => this.net.emit(EV.FREEZE, { from, ms: FREEZE_MS });
    } else if (d.item === 'hint') {
      const mine = r.rows[from] || [];
      const greens = new Set();
      for (const row of mine) {
        for (let i = 0; i < row.colors.length; i++) if (row.colors[i] === 'g') greens.add(i);
      }
      const open = [0, 1, 2, 3, 4].filter((i) => !greens.has(i));
      if (open.length === 0) return fail('Nothing left to hint');
      const col = open[Math.floor(Math.random() * open.length)];
      effect = () => this.net.emit(EV.HINT, { to: from, col, letter: r.word[col] });
    } else if (d.item === 'smudge') {
      const target = this.player(d.target);
      if (!target || target.id === from) return fail('Pick an opponent');
      const best = {}; // letter -> best status seen (g > y > x)
      for (const row of (r.rows[target.id] || [])) {
        for (let i = 0; i < row.word.length; i++) {
          const L = row.word[i], c = row.colors[i];
          const rank = { g: 3, y: 2, x: 1 };
          if ((rank[c] || 0) > (rank[best[L]] || 0)) best[L] = c;
        }
      }
      const grays = Object.keys(best).filter((L) => best[L] === 'x');
      if (grays.length === 0) return fail('No gray letters to smudge');
      const letter = grays[Math.floor(Math.random() * grays.length)];
      effect = () => this.net.emit(EV.SMUDGE, { to: target.id, letter });
    } else {
      return fail('Unknown item');
    }

    p.score -= item.price;
    this.net.emit(EV.SCORES, { scores: this.scoreMap(), buyer: from, item: d.item });
    effect();
  }

  // ---------- duel (Royale only) ----------
  onDuelRequest(d, from, fail) {
    if (this.duel) return fail('A duel is already running');
    const a = this.player(from);
    const b = this.player(d.target);
    const stake = Math.floor(Number(d.stake));
    if (!b || b.id === from || !b.alive || !b.connected || b.spectator) return fail('Pick a living foe');
    if (!(stake >= 0 && stake <= ROYALE.duelMaxStake)) return fail(`Stake must be 0-${ROYALE.duelMaxStake}`);

    // Suspend the current word (timer pauses; grids lock).
    const r = this.round;
    r.suspended = true;
    if (r.deadline) {
      r.remainingMs = Math.max(0, r.deadline - now());
      clearTimeout(this.timers.deadline);
    }
    clearTimeout(this.timers.grace);
    this.timers.grace = null;

    const word = pickWord(this.usedWords);
    this.usedWords.add(word);
    this.duel = { a: a.id, b: b.id, stake, word, rows: [], turn: a.id, over: false };
    this.net.emit(EV.DUEL_START, { a: a.id, b: b.id, stake });
  }

  onDuelGuess(d, from) {
    const duel = this.duel;
    if (!duel || duel.over || from !== duel.turn) return;
    const word = String(d.word || '').toLowerCase();
    if (!isValidGuess(word)) {
      this.net.emit(EV.BAD_GUESS, { to: from, no: -1, reason: 'invalid' });
      return;
    }
    const colors = scoreGuess(word, duel.word);
    const solved = word === duel.word;
    duel.rows.push({ pid: from, word, colors });
    duel.turn = from === duel.a ? duel.b : duel.a;
    // Duel grids are a public spectacle: letters are broadcast. The duel word
    // is fresh and discarded, so nothing about the round's secret leaks.
    this.net.emit(EV.DUEL_ROW, {
      pid: from, row: duel.rows.length - 1, word, colors, solved,
    });
    if (solved) this.endDuel(from);
    else if (duel.rows.length >= MAX_ROWS) this.endDuel(null);
  }

  endDuel(winnerId) {
    const duel = this.duel;
    if (!duel || duel.over) return;
    duel.over = true;
    let eliminated = [];
    let loserId = null;
    if (winnerId) {
      loserId = winnerId === duel.a ? duel.b : duel.a;
      const w = this.player(winnerId), l = this.player(loserId);
      const pay = Math.min(duel.stake, l.score);
      l.score -= pay;
      w.score += pay;
      // Can't cover the stake -> busted out, regardless of the reveal cycle.
      if (l.score <= 0 && duel.stake > 0) {
        l.alive = false; l.spectator = true; eliminated.push(l.id);
      }
    }
    this.net.emit(EV.DUEL_END, {
      winner: winnerId, loser: loserId, stake: duel.stake, draw: !winnerId,
      word: duel.word, scores: this.scoreMap(), eliminated,
    });
    this.duel = null;

    const alive = this.players.filter((p) => p.alive && p.connected);
    if (alive.length <= 1) {
      this.timers.next = setTimeout(() => this.gameOver('last one standing'), this.settings.revealMs);
      return;
    }
    // Resume the suspended word after everyone has seen the duel result
    // (an immediate RESUME would wipe it off screens instantly).
    this.timers.next = setTimeout(() => {
      const r = this.round;
      if (!r || !r.suspended || this.over) return;
      r.suspended = false;
      // Duelist may have been eliminated mid-word.
      for (const pid of eliminated) if (!r.done[pid]) r.done[pid] = 'left';
      if (r.deadline) {
        r.deadline = now() + r.remainingMs;
        this.armDeadline();
      }
      this.net.emit(EV.RESUME, { no: r.no, remainingMs: r.deadline ? r.remainingMs : 0 });
      this.maybeFinishRound();
    }, this.settings.revealMs);
  }

  // ---------- presence / leaving ----------
  onPresence(present) {
    for (const id of present) this.everSeen.add(id);
    for (const p of this.players) {
      if (p.id === this.hostId) continue;
      if (present.has(p.id)) {
        this.missingSince.delete(p.id);
        if (!p.connected && !this.started) { p.connected = true; this.broadcastLobby(); }
      } else if (p.connected && this.everSeen.has(p.id) && !this.missingSince.has(p.id)) {
        // Only players once CONFIRMED present can go missing - a joiner whose
        // broadcast outran their presence registration must not be kicked.
        this.missingSince.set(p.id, now());
      }
    }
  }

  sweepMissing() {
    for (const [pid, since] of this.missingSince) {
      if (now() - since > LEAVE_GRACE_MS) {
        this.missingSince.delete(pid);
        this.onLeave(pid, 'disconnected');
      }
    }
  }

  onLeave(pid, why) {
    const p = this.player(pid);
    if (!p || !p.connected) return;
    p.connected = false;

    if (!this.started) {
      this.players = this.players.filter((q) => q.id !== pid);
      this.broadcastLobby();
      return;
    }

    this.net.emit(EV.PLAYER_LEFT, { pid, why });

    // Duel: leaver forfeits and pays.
    if (this.duel && !this.duel.over && (pid === this.duel.a || pid === this.duel.b)) {
      this.endDuel(pid === this.duel.a ? this.duel.b : this.duel.a);
    }

    const r = this.round;
    if (r) {
      if (r.phase === 'set' && r.setterId === pid) {
        clearTimeout(this.timers.setter);
        this.skipSetter('left');
      } else if (r.phase === 'play' && !r.done[pid]) {
        r.done[pid] = 'left';
        this.maybeFinishRound();
      }
    }

    const remaining = this.players.filter((q) => q.connected);
    if (this.started && !this.over && remaining.length < MIN_PLAYERS) {
      this.gameOver('everyone else left');
    }
  }

  // ---------- resync (the one deliberately fat message) ----------
  sendResync(pid) {
    const r = this.round;
    const snapshot = {
      hostId: this.hostId,
      settings: this.settings,
      started: this.started,
      over: this.over,
      pot: this.pot || 0,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, score: p.score,
        alive: p.alive, connected: p.connected, spectator: p.spectator,
      })),
      round: r ? {
        no: r.no, total: this.totalWords(), phase: r.phase, setterId: r.setterId,
        timerMs: this.settings.timerMs,
        remainingMs: r.deadline ? Math.max(0, r.deadline - now()) : 0,
        done: r.done,
        suspended: r.suspended,
        grids: Object.fromEntries(Object.entries(r.rows).map(([id, rows]) => [
          id,
          rows.map((row) => ({
            colors: row.colors,
            // letters only for the requester's own grid
            word: id === pid ? row.word : undefined,
            solved: row.word === r.word,
          })),
        ])),
      } : null,
      duel: this.duel ? {
        a: this.duel.a, b: this.duel.b, stake: this.duel.stake, turn: this.duel.turn,
        rows: this.duel.rows.map((x) => ({ pid: x.pid, word: x.word, colors: x.colors })),
      } : null,
    };
    this.net.emit(EV.RESYNC, { to: pid, snapshot });
  }

  clearRoundTimers() {
    for (const k of ['deadline', 'grace', 'setter', 'next']) {
      clearTimeout(this.timers[k]);
      this.timers[k] = null;
    }
  }

  shutdown() {
    this.clearRoundTimers();
    clearInterval(this._sweep);
    this.net.emit(EV.ROOM_DEAD, {});
  }

  // ---------- debug hooks (?debug=1 only; used by the E2E suite) ----------
  _debugSecret() { return this.round ? this.round.word : null; }
  _debugSetScore(pid, score) { const p = this.player(pid); if (p) p.score = score; this.net.emit(EV.SCORES, { scores: this.scoreMap() }); }
}
