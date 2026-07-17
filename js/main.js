// Bootstrap: wires transport + engine/mirror + UI, handles ?join=CODE links,
// ?t=local transport selection, and the ?debug=1 test handle.

import { LEAVE_GRACE_MS, ERR_NAPPING } from './config.js';
import { qs, makeCode, normCode, tabId, shareLink, now } from './util.js';
import { makeTransport, Net } from './transport.js';
import { Engine } from './engine.js';
import { Mirror } from './client.js';
import { UI } from './ui.js';

const S = {
  code: null,
  selfId: tabId(),
  transport: null,
  net: null,
  engine: null,
  mirror: null,
  hostMissingSince: 0,
  watchdog: null,
};

const transportKind = qs.get('t') === 'local' ? 'local' : 'supabase';
const DEBUG = qs.get('debug') === '1';

const ui = new UI({
  host: (name) => hostGame(name),
  join: (code, name) => joinGame(code, name),
  start: () => S.engine && S.engine.start(),
  setSettings: (patch) => S.engine && S.engine.setSettings(patch),
  playAgain: () => S.engine && S.engine.playAgain(),
  quitToMenu: () => quitToMenu(),
  shareLink: () => shareLink(S.code),
  roomCode: () => S.code || '????',
});

async function connect(code) {
  S.code = code;
  S.transport = makeTransport(code, { id: S.selfId, name: '' }, transportKind);
  S.net = new Net(S.transport, S.selfId);
  S.mirror = new Mirror(S.net, code, S.selfId);
  ui.attach(S.mirror);
  installDebug();
  await S.transport.connect();
}

async function hostGame(name) {
  ui.showConnect('opening a room…');
  try {
    await connect(makeCode());
    S.engine = new Engine(S.net, S.code, { id: S.selfId, name });
    if (DEBUG) window.__friendle.engine = S.engine;
    S.engine.broadcastLobby();
  } catch (e) {
    ui.showDead(e.message || ERR_NAPPING);
  }
}

async function joinGame(codeRaw, name) {
  const code = normCode(codeRaw);
  if (code.length < 4) { ui.showToast('Room codes are 4 characters'); return; }
  ui.showConnect(`joining ${code}…`);
  try {
    await connect(code);
  } catch (e) {
    ui.showDead(e.message || ERR_NAPPING);
    return;
  }
  // Ask to join until the host's lobby lists us (broadcast rooms have no
  // membership - a dead code simply never answers).
  let joined = false;
  S.mirror.onChange((type) => {
    if (type === 'lobby' || type === 'resync') {
      if (S.mirror.players.some((p) => p.id === S.selfId)) joined = true;
    }
    if (type === 'joinerr') joined = 'rejected';
  });
  const deadline = now() + 9000;
  while (!joined && now() < deadline) {
    S.mirror.join(name);
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!joined) {
    await S.transport.leave();
    ui.showDead(`No room "${code}" answered. Check the code — or ${ERR_NAPPING.toLowerCase()}`);
    return;
  }
  if (joined !== 'rejected') startHostWatchdog();
}

// Guests: if the host's presence vanishes and stays gone, the room is dead.
// The missing-clock may only start AFTER the host has been seen present at
// least once - starting from an empty pre-sync roster used to kick perfectly
// healthy guests a few seconds after joining.
function startHostWatchdog() {
  let present = new Set();
  let seenHost = false;
  S.transport.onPresence((p) => { present = p; });
  S.watchdog = setInterval(() => {
    const m = S.mirror;
    if (!m || m.roomDead || !m.hostId || m.isHost()) return;
    if (present.has(m.hostId)) {
      seenHost = true;
      S.hostMissingSince = 0;
    } else if (seenHost) {
      if (!S.hostMissingSince) S.hostMissingSince = now();
      else if (now() - S.hostMissingSince > LEAVE_GRACE_MS) {
        clearInterval(S.watchdog);
        m.roomDead = true;
        m.fire('roomdead', {});
      }
    }
  }, 1000);
}

async function quitToMenu() {
  try {
    if (S.engine) { S.engine.shutdown(); S.engine = null; }
    else if (S.mirror && S.mirror.players.some((p) => p.id === S.selfId)) S.mirror.quit();
    if (S.transport) await S.transport.leave();
  } catch { /* leaving anyway */ }
  const url = new URL(location.href);
  url.search = transportKind === 'local' ? '?t=local' : '';
  if (DEBUG) url.search += (url.search ? '&' : '?') + 'debug=1';
  sessionStorage.removeItem('friendle-id'); // fresh identity next time
  location.href = url.toString();
}

// Leaving the tab entirely: tell the room (best effort).
window.addEventListener('pagehide', () => {
  try {
    if (S.engine) S.engine.shutdown();
    else if (S.mirror && S.mirror.started) S.mirror.quit();
  } catch { /* closing */ }
});

// ---------- debug handle for the E2E suite (?debug=1) ----------
function installDebug() {
  if (!DEBUG) return;
  // record every envelope crossing this page (tests assert secrets stay off
  // the wire until reveal)
  window.__wireLog = [];
  S.net.onAny((env) => window.__wireLog.push(JSON.stringify(env)));
  window.__friendle = {
    code: S.code,
    selfId: S.selfId,
    net: S.net,
    mirror: S.mirror,
    engine: S.engine,
    ui,
    // engine-side helpers (host page only)
    secret: () => (S.engine ? S.engine._debugSecret() : null),
    duelSecret: () => (S.engine && S.engine.duel ? S.engine.duel.word : null),
    setScore: (pid, n) => S.engine && S.engine._debugSetScore(pid, n),
    setSettings: (patch) => S.engine && S.engine.setSettings(patch),
    engineState: () => S.engine && {
      started: S.engine.started,
      over: S.engine.over,
      pot: S.engine.pot,
      roundNo: S.engine.roundNo,
      round: S.engine.round && {
        no: S.engine.round.no, phase: S.engine.round.phase,
        winner: S.engine.round.winner, setterId: S.engine.round.setterId,
        done: S.engine.round.done, suspended: S.engine.round.suspended,
      },
      duel: S.engine.duel && { ...S.engine.duel },
      players: S.engine.players.map((p) => ({ ...p })),
      usedWords: S.engine.usedWords.size,
    },
    // client-side helpers (any page)
    state: () => ({
      selfId: S.selfId,
      hostId: S.mirror.hostId,
      started: S.mirror.started,
      over: S.mirror.over,
      players: S.mirror.players.map((p) => ({ ...p })),
      round: S.mirror.round && {
        no: S.mirror.round.no, phase: S.mirror.round.phase,
        setterId: S.mirror.round.setterId, pot: S.mirror.round.pot,
        done: { ...S.mirror.round.done },
        grids: Object.fromEntries(Object.entries(S.mirror.round.grids)
          .map(([pid, rows]) => [pid, rows.map((r) => ({ colors: r.colors, solved: !!r.solved, word: r.word }))])),
        suspended: S.mirror.round.suspended,
        timeUp: S.mirror.round.timeUp,
      },
      duel: S.mirror.duel && {
        a: S.mirror.duel.a, b: S.mirror.duel.b, stake: S.mirror.duel.stake,
        turn: S.mirror.duel.turn, over: S.mirror.duel.over,
        rows: S.mirror.duel.rows.map((r) => ({ ...r })),
      },
      reveal: S.mirror.reveal && { ...S.mirror.reveal },
      lastReveal: S.mirror.lastReveal && { ...S.mirror.lastReveal },
      lastDuel: S.mirror.lastDuel && {
        rows: S.mirror.lastDuel.rows.map((r) => ({ ...r })),
        result: { ...S.mirror.lastDuel.result },
      },
      gameover: S.mirror.gameover && { ...S.mirror.gameover },
      frozen: S.mirror.frozen(),
      input: S.mirror.input,
      hints: { ...S.mirror.hints },
      peeks: S.mirror.peeks.map((p) => ({ ...p })),
      keyboard: S.mirror.keyboardState(),
      inputLocked: S.mirror.inputLocked(),
      roomDead: S.mirror.roomDead,
      joinError: S.mirror.joinError,
    }),
    // drive the game like a player (bypasses Playwright's pointer, not the engine)
    guess: (word) => {
      const m = S.mirror;
      m.input = word.toLowerCase();
      return m.enter();
    },
    type: (ch) => S.mirror.type(ch),
    enter: () => S.mirror.enter(),
    backspace: () => S.mirror.backspace(),
    buy: (item, target, stake) => S.mirror.buy(item, target, stake),
    quit: () => quitToMenu(),
  };
}

// ---------- entry ----------
const joinCode = qs.get('join');
if (joinCode) {
  const name = localStorage.getItem('friendle-name') || ui.playerName();
  joinGame(joinCode, name);
}
