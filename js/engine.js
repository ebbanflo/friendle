// Host-authoritative game engine. Runs ONLY in the host's browser: it owns
// the secret words, validates every guess and purchase, arbitrates who solved
// first (with a grace window so lag never decides a photo finish), and keeps
// all scores and pots. Guests only send intents (protocol.js IN.*) and mirror
// the host's broadcasts (EV.*).
//
// Secrets never appear in any broadcast until the round's REVEAL - only
// color-result strings and score deltas go over the wire.

import {
  MAX_PLAYERS, MIN_PLAYERS, MAX_ROWS, WORD_LEN, GRACE_MS, COUNTDOWN_MS, TIMER_SLACK_MS,
  SCORING, ROYALE, SHOP, FREEZE_MS, DEFAULT_SETTINGS, PLAYER_COLORS, LEAVE_GRACE_MS,
  REACTIONS, REACT_COOLDOWN_MS, TOWER,
} from './config.js';
import { EV, IN } from './protocol.js';
import { pickWord, scoreGuess, isValidGuess } from './words.js';
import { matchesConstraint, genConstraint, wordPoints } from './tower.js';
import { obf, deobf, now } from './util.js';

const SET_TIMEOUT_MS = 75000; // FRIEND: setter stalls -> rotate onward
const TOWER_DIFFICULTIES = ['easy', 'medium', 'hard', 'ramp'];

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
    net.on(IN.REACT, (d, from) => this.onReact(d, from));
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
    // TOWER has no use for 'standard' (a Classic/Royale word-tier concept) -
    // default it to RAMP the moment the room settles into tower mode with
    // nothing meaningful chosen yet, so a difficulty is always active.
    if (this.settings.mode === 'tower' && this.settings.difficulty === 'standard') {
      this.settings.difficulty = 'ramp';
    }
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

  minPlayers() { return this.settings.mode === 'tower' ? 1 : MIN_PLAYERS; }

  start() {
    if (this.started || this.players.filter((p) => p.connected).length < this.minPlayers()) return;
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
    if (this.settings.mode === 'tower') this.timers.next = setTimeout(() => this.initTower(), 1200);
    else this.timers.next = setTimeout(() => this.nextWord(), 1200);
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
    if (this.settings.mode === 'royale') return 0;
    if (this.settings.mode === 'friend') {
      // "5 words" means 5 words EACH as setter: 3 players -> 15 rounds.
      return this.settings.words * Math.max(1, this.activePlayers().length);
    }
    return this.settings.words;
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
      // who gets the letter feed: the setter now, solvers as they solve
      this.round.viewers = new Set([this.round.setterId]);
      this.round.phase = 'set';
      this.net.emit(EV.WORD, {
        no: this.round.no, total: this.totalWords(), phase: 'set',
        setterId: this.round.setterId, timerMs: this.settings.timerMs,
        scores: this.scoreMap(),
      });
      this.timers.setter = setTimeout(() => this.skipSetter('slow'), SET_TIMEOUT_MS);
      return;
    }

    // classic / royale: engine picks the secret at the round's difficulty
    this.round.tier = this.resolveTier(this.round.no);
    this.round.word = pickWord(this.usedWords, this.round.tier);
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
      pot: this.pot, scores: this.scoreMap(), tier: this.round.tier || null, ...extra,
    });
  }

  // Difficulty -> tier for word #no. 'standard' returns null (full bank,
  // commonest-biased). 'ramp' climbs easy -> medium -> hard: over the set
  // word count in Classic, over the first ~9 words in endless Royale.
  resolveTier(no) {
    const d = this.settings.difficulty || 'standard';
    if (d === 'standard' || this.settings.mode === 'friend') return null;
    if (d !== 'ramp') return d;
    const total = this.totalWords();
    const f = total > 1 ? (no - 1) / (total - 1) : Math.min(1, (no - 1) / 8);
    return f < 1 / 3 ? 'easy' : f < 2 / 3 ? 'medium' : 'hard';
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

  // ---------- TOWER (co-op, endless) ----------
  initTower() {
    if (this.over) return;
    this.tower = {
      stage: 1,
      wordsInStage: 0,
      height: 0,
      combo: 0,
      rows: [],                 // {pid, word, points}
      used: new Set(),
      lives: Object.fromEntries(this.activePlayers().map((p) => [p.id, TOWER.lives])),
      revives: {},              // reviverPid -> {target, word, rows:[{word,colors}]}
      // host-set 3/5/10 in the lobby (UI-clamped, not server-enforced - tests
      // intentionally pass values outside that range to freeze a stage).
      rampWords: this.settings.rampWords ?? TOWER.defaultRampWords,
      hungerMs: this.settings.hungerMs ?? TOWER.hungerMs,
      // 'standard' (the global default, meaningless for TOWER) falls back to
      // 'ramp' - the classic escalating experience.
      difficulty: TOWER_DIFFICULTIES.includes(this.settings.difficulty) ? this.settings.difficulty : 'ramp',
      constraint: null,
    };
    this.tower.constraint = genConstraint(1, this.tower.used, this.tower.difficulty, this.tower.rampWords);
    this.broadcastTower();
    this.armHunger();
  }

  broadcastTower() {
    const t = this.tower;
    this.net.emit(EV.TOWER, {
      stage: t.stage, constraint: t.constraint, height: t.height,
      hungerMs: t.hungerMs, lives: { ...t.lives }, scores: this.scoreMap(),
      combo: t.combo,
    });
  }

  armHunger() {
    clearTimeout(this.timers.hunger);
    if (!this.tower || this.over) return;
    this.timers.hunger = setTimeout(() => this.hungerStrike(), this.tower.hungerMs);
  }

  // The tower demands words: silence bleeds every living player.
  hungerStrike() {
    const t = this.tower;
    if (!t || this.over) return;
    const downed = [];
    for (const p of this.activePlayers()) {
      if (t.lives[p.id] > 0) {
        t.lives[p.id] -= 1;
        if (t.lives[p.id] === 0) downed.push(p.id);
      }
    }
    t.combo = 0;
    this.net.emit(EV.TOWER_HUNGER, { lives: { ...t.lives }, downed });
    if (this.everyoneDowned()) this.endTower();
    else this.armHunger();
  }

  everyoneDowned() {
    return this.activePlayers().every((p) => (this.tower.lives[p.id] ?? 0) <= 0);
  }

  // A word only counts as a duplicate while it's STILL visible in the tower
  // (the newest TOWER.visibleRows floors - what ui.js actually renders). Once
  // a floor scrolls past that window it's forgotten, so an early word can be
  // played again later. t.used keeps every word ever placed, but only to feed
  // genConstraint's survivability check - it is NOT the duplicate gate.
  towerOnScreen(word) {
    const t = this.tower;
    if (!t) return false;
    const start = Math.max(0, t.rows.length - TOWER.visibleRows);
    for (let i = start; i < t.rows.length; i++) {
      if (t.rows[i].word === word) return true;
    }
    return false;
  }

  // Team-wide bonus heart (milestone every N floors, or the TOWER easter
  // egg). Revives anyone currently downed - "everyone gets a heart" is
  // literal, including whoever's at zero.
  grantHearts(reason) {
    const t = this.tower;
    for (const p of this.activePlayers()) {
      const cur = t.lives[p.id] ?? 0;
      t.lives[p.id] = Math.min(TOWER.maxLives, cur + 1);
    }
    this.net.emit(EV.TOWER_BONUS, { reason, lives: { ...t.lives }, height: t.height });
  }

  // Easter egg: if the most recently placed 5 words, read down any single
  // column, spell T-O-W-E-R, the tower itself blesses the climbers.
  checkTowerSpelled() {
    const t = this.tower;
    if (t.height < 5) return false;
    const window = t.rows.slice(-5);
    if (window.length < 5) return false;
    for (let col = 0; col < WORD_LEN; col++) {
      let s = '';
      for (const row of window) s += row.word[col];
      if (s === 'tower') return true;
    }
    return false;
  }

  // A revive is meant to be an untimed puzzle: the shared hunger clock
  // pauses while ANY revive is in flight, and only resumes (with a fresh
  // full window) once none remain. Other players may keep climbing while
  // paused - only the clock itself stops.
  pauseHungerForRevive() {
    const t = this.tower;
    if (t.hungerPaused) return;
    t.hungerPaused = true;
    clearTimeout(this.timers.hunger);
  }

  resumeHungerIfIdle() {
    const t = this.tower;
    if (!t.hungerPaused || Object.keys(t.revives).length > 0) return false;
    t.hungerPaused = false;
    this.armHunger();
    return true;
  }

  onTowerGuess(d, from) {
    const t = this.tower;
    if (!t || this.over) return;
    const p = this.player(from);
    if (!p || !p.connected) return;
    const word = this.unwrapWord(d.x);

    // A player mid-revive is playing their rescue wordle, not the tower.
    if (t.revives[from]) return this.onReviveGuess(word, from);

    if ((t.lives[from] ?? 0) <= 0) return; // downed players watch

    if (!isValidGuess(word)) return this.towerMiss(from, word, 'not a word');
    if (this.towerOnScreen(word)) return this.towerMiss(from, word, 'already in the tower');
    if (!matchesConstraint(word, t.constraint)) return this.towerMiss(from, word, 'breaks the decree');

    // accepted: the tower grows
    t.used.add(word);
    t.height += 1;
    t.combo += 1;
    t.wordsInStage += 1;
    const points = wordPoints(word, t.stage, t.combo);
    p.score += points;
    t.rows.push({ pid: from, word, points });
    if (t.rows.length > 60) t.rows.shift();
    this.net.emit(EV.TOWER_WORD, {
      pid: from, word, points, height: t.height, combo: t.combo, stage: t.stage,
    });
    // While a revive is in flight the clock stays paused regardless of what
    // OTHER (non-reviving) players do - only the last revive ending re-arms it.
    if (!t.hungerPaused) this.armHunger();

    if (Math.floor(t.height / TOWER.heartEveryHeight) > Math.floor((t.height - 1) / TOWER.heartEveryHeight)) {
      this.grantHearts('milestone');
    }
    if (this.checkTowerSpelled()) {
      this.grantHearts('spelled');
    }

    if (t.wordsInStage >= t.rampWords) {
      t.stage += 1;
      t.wordsInStage = 0;
      // pass the outgoing decree so the new one is never an identical repeat
      t.constraint = genConstraint(t.stage, t.used, t.difficulty, t.rampWords, t.constraint);
      this.broadcastTower();
    }
  }

  towerMiss(from, word, reason) {
    const t = this.tower;
    t.lives[from] = Math.max(0, (t.lives[from] ?? 0) - 1);
    t.combo = 0;
    this.net.emit(EV.TOWER_MISS, {
      pid: from, word, reason, lives: { ...t.lives }, combo: 0,
    });
    if (this.everyoneDowned()) this.endTower();
  }

  onReviveBuy(d, from, fail) {
    const t = this.tower;
    const p = this.player(from);
    if (!t) return fail('No tower to climb');
    if ((t.lives[from] ?? 0) <= 0) return fail('You are down yourself');
    if (t.revives[from]) return fail('Already reviving');
    const target = this.player(d.target);
    if (!target || (t.lives[target.id] ?? 0) > 0 || !target.connected) return fail('Pick a fallen teammate');
    if (p.score < SHOP.revive.price) return fail(`Need ${SHOP.revive.price} points`);
    p.score -= SHOP.revive.price;
    const word = pickWord(this.usedWords, 'easy'); // rescues are merciful
    this.usedWords.add(word);
    t.revives[from] = { target: target.id, word, rows: [] };
    this.pauseHungerForRevive();
    this.net.emit(EV.SCORES, { scores: this.scoreMap(), buyer: from, item: 'revive' });
    this.net.emit(EV.TOWER_REVIVE, { phase: 'start', reviver: from, target: target.id, paused: true });
  }

  onReviveGuess(word, from) {
    const t = this.tower;
    const rev = t.revives[from];
    if (!rev) return;
    if (!isValidGuess(word)) {
      this.net.emit(EV.BAD_GUESS, { to: from, no: -1, reason: 'invalid' });
      return;
    }
    const colors = scoreGuess(word, rev.word);
    const solved = word === rev.word;
    rev.rows.push({ word, colors });
    // co-op spectacle: everyone watches the rescue, letters included
    this.net.emit(EV.TOWER_REVIVE, {
      phase: 'row', reviver: from, target: rev.target,
      row: rev.rows.length - 1, word, colors,
    });
    if (solved || rev.rows.length >= MAX_ROWS) {
      delete t.revives[from];
      if (solved) t.lives[rev.target] = TOWER.reviveLives;
      const resumed = this.resumeHungerIfIdle();
      this.net.emit(EV.TOWER_REVIVE, {
        phase: 'end', reviver: from, target: rev.target, ok: solved,
        lives: { ...t.lives }, secret: rev.word, resumed, hungerMs: t.hungerMs,
      });
    }
  }

  endTower() {
    const t = this.tower;
    if (!t || this.over) return;
    this.over = true;
    clearTimeout(this.timers.hunger);
    const standings = [...this.players].sort((a, b) => b.score - a.score);
    this.net.emit(EV.GAME_OVER, {
      reason: 'the tower fell',
      winner: standings[0] ? standings[0].id : null,
      height: t.height,
      stage: t.stage,
      standings: standings.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
    });
  }

  // ---------- guessing ----------
  onGuess(d, from) {
    if (this.settings.mode === 'tower') return this.onTowerGuess(d, from);
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
    const word = this.unwrapWord(d.x);
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
    // FRIEND: everyone out of the race gets the actual letters, live - the
    // setter from the start, and each solver from the moment they solve.
    // Unsolved guessers are still competing and stay colors-only.
    if (this.settings.mode === 'friend' && r.viewers) {
      for (const viewer of r.viewers) {
        if (viewer !== from) {
          this.net.emit(EV.SETTER_LETTERS, {
            to: viewer, pid: from, no: r.no, row: rows.length - 1, x: obf(word, this.code),
          });
        }
      }
      if (solved && !r.viewers.has(from)) {
        r.viewers.add(from);
        // backfill everything the new viewer missed while competing
        for (const [pid, prows] of Object.entries(r.rows)) {
          if (pid === from) continue;
          prows.forEach((prow, i) => this.net.emit(EV.SETTER_LETTERS, {
            to: from, pid, no: r.no, row: i, x: obf(prow.word, this.code),
          }));
        }
      }
    }

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
    } else if (mode === 'friend') {
      // FRIEND: ranked by FEWEST guesses, not time. Every solver earns the
      // full formula (no speed bonus, no late cut) so 3 rows beats 6 rows
      // regardless of who hit enter first; ties go to the earlier solve.
      const solvers = Object.keys(r.done).filter((pid) => r.done[pid] === 'solved');
      for (const pid of solvers) {
        const p = this.player(pid);
        if (!p) continue;
        const pts = SCORING.base + (MAX_ROWS - this.rowsUsed(pid)) * SCORING.perRowSaved;
        deltas[pid] = pts;
        p.score += pts;
      }
      solvers.sort((a, b) => this.rowsUsed(a) - this.rowsUsed(b)
        || ((r.elapsedBy || {})[a] ?? Infinity) - ((r.elapsedBy || {})[b] ?? Infinity));
      r.winner = solvers[0] || null;
      // the setter scores for EVERY guesser they stumped
      const stumped = this.guessers().filter((g) => r.done[g.id] !== 'solved').length;
      if (stumped > 0) {
        const s = this.player(r.setterId);
        if (s) {
          deltas[r.setterId] = (deltas[r.setterId] || 0) + stumped * SCORING.setterPerStump;
          s.score += stumped * SCORING.setterPerStump;
        }
      }
    } else {
      // classic: formula points, first solver full, later solvers a cut
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
    this.tower = null;
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
    if (this.settings.mode === 'tower') {
      if (d.item !== 'revive') return fail('The tower sells only revival');
      return this.onReviveBuy(d, from, fail);
    }
    if (d.item === 'revive') return fail('Revives are TOWER-only');
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

    // duel words match the round's difficulty
    const word = pickWord(this.usedWords, r.tier || null);
    this.usedWords.add(word);
    this.duel = { a: a.id, b: b.id, stake, word, rows: [], turn: a.id, over: false };
    this.net.emit(EV.DUEL_START, { a: a.id, b: b.id, stake });
  }

  // Guess words travel lightly obfuscated (like the FRIEND secret) so rival
  // guesses aren't casual network-tab reading. Not cryptography.
  unwrapWord(x) {
    try { return deobf(x, this.code).toLowerCase(); } catch { return ''; }
  }

  // FRIEND: the setter heckles a guesser with an emoji; host validates + relays.
  onReact(d, from) {
    const r = this.round;
    if (this.settings.mode !== 'friend' || !r || r.phase !== 'play' || this.over) return;
    if (from !== r.setterId || !REACTIONS.includes(d.emoji)) return;
    if (!this.player(d.target) || d.target === from) return;
    if (now() - (this.lastReactAt || 0) < REACT_COOLDOWN_MS) return;
    this.lastReactAt = now();
    this.net.emit(EV.REACTION, { from, target: d.target, emoji: d.emoji });
  }

  onDuelGuess(d, from) {
    const duel = this.duel;
    if (!duel || duel.over || from !== duel.turn) return;
    const word = this.unwrapWord(d.x);
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
      // Royale: can't cover the stake -> busted out. Classic has no
      // elimination - the loser just walks away lighter.
      if (this.settings.mode === 'royale' && l.score <= 0 && duel.stake > 0) {
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

    // Tower: a leaver's revive fizzles (points stay spent, teammate stays
    // down) - the hunger clock resumes if that was the last active revive.
    // The run ends if only downed players remain.
    if (this.settings.mode === 'tower' && this.tower) {
      const rev = this.tower.revives[pid];
      if (rev) {
        delete this.tower.revives[pid];
        const resumed = this.resumeHungerIfIdle();
        this.net.emit(EV.TOWER_REVIVE, {
          phase: 'end', reviver: pid, target: rev.target, ok: false, secret: rev.word,
          lives: { ...this.tower.lives }, resumed, hungerMs: this.tower.hungerMs, reason: 'left',
        });
      }
      if (this.activePlayers().length === 0 || this.everyoneDowned()) { this.endTower(); return; }
    }

    const remaining = this.players.filter((q) => q.connected);
    if (this.started && !this.over && remaining.length < this.minPlayers()) {
      if (this.settings.mode === 'tower') this.endTower();
      else this.gameOver('everyone else left');
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
            // letters for the requester's own grid - and for every grid when
            // the requester has FRIEND letter-vision (setter, or a solver)
            xword: id === pid || (this.settings.mode === 'friend' && r.viewers && r.viewers.has(pid))
              ? obf(row.word, this.code) : undefined,
            solved: row.word === r.word,
          })),
        ])),
      } : null,
      duel: this.duel ? {
        a: this.duel.a, b: this.duel.b, stake: this.duel.stake, turn: this.duel.turn,
        rows: this.duel.rows.map((x) => ({ pid: x.pid, word: x.word, colors: x.colors })),
      } : null,
      tower: (this.settings.mode === 'tower' && this.tower) ? {
        stage: this.tower.stage, constraint: this.tower.constraint,
        height: this.tower.height, combo: this.tower.combo,
        hungerMs: this.tower.hungerMs, lives: { ...this.tower.lives },
        hungerPaused: !!this.tower.hungerPaused,
        rows: this.tower.rows.slice(-40),
        reviving: Object.entries(this.tower.revives).map(([rev, s]) => ({
          reviver: rev, target: s.target,
          rows: s.rows.map((x) => ({ word: x.word, colors: x.colors })),
        })),
      } : null,
    };
    this.net.emit(EV.RESYNC, { to: pid, snapshot });
  }

  clearRoundTimers() {
    for (const k of ['deadline', 'grace', 'setter', 'next', 'hunger']) {
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
