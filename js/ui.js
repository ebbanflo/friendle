// Rendering + input. Renders exclusively from the Mirror; sends intents back
// through it. Persistent tile/key nodes are mutated in place so CSS animations
// survive updates.

import { WORD_LEN, MAX_ROWS, SHOP, DEFAULT_SETTINGS, REACTIONS } from './config.js';
import { el, fmtMs, now } from './util.js';
import { sfx, soundEnabled, setSound } from './audio.js';

const $ = (id) => document.getElementById(id);
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', '⏎zxcvbnm⌫'];

export class UI {
  // actions: {host(), join(code), start(), setSettings(patch), playAgain(), quitToMenu()}
  constructor(actions) {
    this.a = actions;
    this.mirror = null;
    this.paused = false;
    this.toastTimer = null;
    this.buildStaticDom();
    this.wireMenu();
    this.wireGameChrome();
    setInterval(() => this.tick(), 120);
  }

  attach(mirror) {
    this.mirror = mirror;
    mirror.onChange((type, d) => this.onEvent(type, d));
  }

  // ---------- static DOM ----------
  buildStaticDom() {
    // FRIENDLE title with per-letter rainbow tiles
    const title = $('scr-menu').querySelector('.big-title');
    for (const [i, ch] of [...'FRIENDLE'].entries()) {
      title.append(el('span', { class: `title-tile t${i % 4}`, text: ch, style: { animationDelay: `${i * 0.12}s` } }));
    }
    // own board
    const board = $('board');
    this.tiles = [];
    for (let r = 0; r < MAX_ROWS; r++) {
      const rowEl = el('div', { class: 'brow', 'data-row': r });
      const row = [];
      for (let c = 0; c < WORD_LEN; c++) {
        const t = el('div', { class: 'tile', 'data-testid': `tile-${r}-${c}` });
        rowEl.append(t);
        row.push(t);
      }
      board.append(rowEl);
      this.tiles.push(row);
    }
    // setter row
    this.setterTiles = [];
    for (let c = 0; c < WORD_LEN; c++) {
      const t = el('div', { class: 'tile setter-tile', 'data-testid': `setter-${c}` });
      $('setter-row').append(t);
      this.setterTiles.push(t);
    }
    // duel board
    this.duelTiles = [];
    const db = $('duel-board');
    for (let r = 0; r < MAX_ROWS; r++) {
      const rowEl = el('div', { class: 'brow' });
      const row = [];
      for (let c = 0; c < WORD_LEN; c++) {
        const t = el('div', { class: 'tile mini-duel', 'data-testid': `duel-${r}-${c}` });
        rowEl.append(t);
        row.push(t);
      }
      db.append(rowEl);
      this.duelTiles.push(row);
    }
    // keyboard
    this.keys = {};
    for (const rowStr of KEY_ROWS) {
      const rowEl = el('div', { class: 'krow' });
      for (const ch of rowStr) {
        const wide = ch === '⏎' || ch === '⌫';
        const label = ch === '⏎' ? 'ENTER' : ch === '⌫' ? '⌫' : ch;
        const k = el('button', {
          class: 'key' + (wide ? ' key-wide' : ''),
          'data-key': ch, 'data-testid': `key-${ch === '⏎' ? 'enter' : ch === '⌫' ? 'back' : ch}`,
          text: label,
          onclick: () => this.pressKey(ch),
        });
        rowEl.append(k);
        this.keys[ch] = k;
      }
      $('keyboard').append(rowEl);
    }
    // shop
    for (const [id, item] of Object.entries(SHOP)) {
      $('shop').append(el('button', {
        class: 'shop-btn', 'data-item': id, 'data-testid': `shop-${id}`,
        html: `<span class="shop-emoji">${item.emoji}</span><span class="shop-name">${item.name}</span><span class="shop-price">${id === 'duel' ? 'stake' : item.price}</span>`,
        title: item.desc,
        onclick: () => this.shopClick(id),
      }));
    }
  }

  // ---------- menu & chrome wiring ----------
  wireMenu() {
    const nameInput = $('inp-name');
    nameInput.value = localStorage.getItem('friendle-name') || '';
    const saveName = () => localStorage.setItem('friendle-name', nameInput.value.trim());
    nameInput.addEventListener('change', saveName);

    const soundBtn = $('btn-sound');
    const paintSound = () => { soundBtn.textContent = soundEnabled() ? '\u{1F50A} SOUND ON' : '\u{1F507} SOUND OFF'; };
    paintSound();
    soundBtn.onclick = () => { setSound(!soundEnabled()); paintSound(); if (soundEnabled()) sfx.key(); };

    $('btn-host').onclick = () => { saveName(); this.a.host(this.playerName()); };
    const join = () => {
      saveName();
      const code = $('inp-code').value;
      if (code.trim().length >= 4) this.a.join(code, this.playerName());
      else this.showToast('Enter the 4-letter room code');
    };
    $('btn-join').onclick = join;
    $('inp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    $('inp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

    $('btn-help-menu').onclick = () => this.showHelp(true);
    $('btn-help-close').onclick = () => this.showHelp(false);
    $('btn-connect-back').onclick = () => this.a.quitToMenu();
    $('btn-dead-menu').onclick = () => this.a.quitToMenu();
    $('btn-over-menu').onclick = () => this.confirmQuit();
    $('btn-again').onclick = () => this.a.playAgain();
  }

  wireGameChrome() {
    $('btn-share').onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.a.shareLink());
        this.showToast('Invite link copied!');
      } catch {
        this.showToast(this.a.shareLink());
      }
    };
    for (const seg of document.querySelectorAll('.seg')) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn || !this.mirror || !this.mirror.isHost()) return;
        const key = seg.dataset.setting;
        const val = key === 'mode' ? btn.dataset.val : Number(btn.dataset.val);
        this.a.setSettings({ [key]: val });
        sfx.key();
      });
    }
    $('btn-start').onclick = () => this.a.start();
    $('btn-lobby-help').onclick = () => this.showHelp(true);
    $('btn-help').onclick = () => this.showHelp(true);
    $('btn-lobby-quit').onclick = () => this.confirmQuit();
    $('btn-quit').onclick = () => this.confirmQuit();
    $('btn-pause').onclick = () => this.setPaused(true);
    $('btn-resume').onclick = () => this.setPaused(false);
    $('btn-picker-cancel').onclick = () => this.closePicker();
    $('stake-range').addEventListener('input', (e) => { $('stake-out').textContent = e.target.value; });

    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (['inp-name', 'inp-code'].includes(document.activeElement?.id)) return;
      if (this.paused || !$('ovl-help').classList.contains('hidden')) return;
      if (!$('ovl-picker').classList.contains('hidden')) return;
      if (/^[a-zA-Z]$/.test(e.key)) this.pressKey(e.key.toLowerCase());
      else if (e.key === 'Enter') this.pressKey('⏎');
      else if (e.key === 'Backspace') this.pressKey('⌫');
    });
  }

  playerName() {
    const v = $('inp-name').value.trim();
    if (v) return v;
    const names = ['MANGO', 'PICKLE', 'WAFFLE', 'NOODLE', 'BISCUIT', 'TACO', 'PANDA', 'GOBLIN'];
    const n = names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 90 + 10);
    $('inp-name').value = n;
    return n;
  }

  confirmQuit() {
    const m = this.mirror;
    if (m && m.started && !m.over) {
      if (!confirm(m.isHost() ? 'Quit? You are the host — the room dies with you!' : 'Quit to menu?')) return;
    }
    this.a.quitToMenu();
  }

  // ---------- screens ----------
  show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    $(id).classList.remove('hidden');
  }

  showConnect(msg) { this.show('scr-connect'); $('connect-msg').textContent = msg; }
  showDead(msg) { this.show('scr-dead'); $('dead-msg').textContent = msg; }
  showHelp(on) { $('ovl-help').classList.toggle('hidden', !on); }

  setPaused(on) {
    this.paused = on;
    $('ovl-pause').classList.toggle('hidden', !on);
  }

  showToast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---------- event routing ----------
  onEvent(type, d) {
    const m = this.mirror;
    switch (type) {
      case 'lobby':
        if (!m.started) {
          $('ovl-reveal').classList.add('hidden');
          this.show('scr-lobby');
          this.renderLobby();
        } else this.renderStrip();
        break;
      case 'start':
        this.show('scr-game');
        this.buildOpponents();
        this.renderStrip();
        sfx.join();
        break;
      case 'word': this.onWord(d); break;
      case 'result': this.onResult(d); break;
      case 'type': this.renderInputRow(); (d.back ? sfx.back : sfx.key)(); break;
      case 'submit': sfx.flip(0); break;
      case 'badguess': this.renderBoard(); this.shakeRow(); break;
      case 'shake': this.shakeRow(); sfx.invalid(); break;
      case 'toast': this.showToast(d.msg); break;
      case 'timeup': this.showToast('⏰ TIME!'); sfx.lose(); this.renderShop(); break;
      case 'reveal': this.onReveal(d); break;
      case 'scores': this.renderStrip(); this.renderShop(); if (d.buyer === m.selfId) sfx.buy(); break;
      case 'freeze': if (d.from !== m.selfId) sfx.freeze(); this.renderShop(); break;
      case 'hint': this.renderBoard(); this.showToast(`\u{1F4A1} letter ${d.col + 1} is "${d.letter.toUpperCase()}"`); sfx.peek(); break;
      case 'peek': this.renderOpponents(); this.showToast('\u{1F50D} peeked!'); sfx.peek(); break;
      case 'smudge': this.renderKeyboard(); break; // silent: poisoned memory
      case 'sletters': this.renderOpponents(); break;
      case 'reaction': this.spawnReaction(d); break;
      case 'duelstart': this.onDuelStart(d); break;
      case 'duelrow': this.renderDuel(); sfx.flip(1); break;
      case 'duelend': this.onDuelEnd(d); break;
      case 'resume': this.onResume(); break;
      case 'left': this.onLeft(d); break;
      case 'gameover': this.onGameOver(d); break;
      case 'roomdead': this.showDead('The host closed the room \u{1F480} the game is over.'); break;
      case 'joinerr': this.showDead(d.reason); break;
      case 'seterr': this.renderSetter(); break;
      case 'secretsent': this.renderSetter(); break;
      case 'resync': this.onResync(); break;
      default: break;
    }
  }

  // ---------- lobby ----------
  renderLobby() {
    const m = this.mirror;
    $('room-code').textContent = this.a.roomCode();
    const ul = $('lobby-players');
    ul.replaceChildren();
    for (const p of m.players) {
      ul.append(el('li', {
        class: 'lobby-player' + (p.connected ? '' : ' gone'),
        'data-testid': `lobby-player-${p.id}`,
        style: { '--sig': p.color },
      },
      el('span', { class: 'sig-dot' }),
      el('span', { text: p.name + (p.id === m.hostId ? ' \u{1F451}' : '') + (p.id === m.selfId ? ' (you)' : '') })));
    }
    for (let i = m.players.length; i < 4; i++) {
      ul.append(el('li', { class: 'lobby-player empty', text: 'waiting…' }));
    }
    const s = m.settings || DEFAULT_SETTINGS;
    for (const seg of document.querySelectorAll('.seg')) {
      const key = seg.dataset.setting;
      for (const btn of seg.querySelectorAll('.seg-btn')) {
        btn.classList.toggle('on', String(s[key]) === btn.dataset.val);
        btn.disabled = !m.isHost();
      }
    }
    $('set-ante').classList.toggle('hidden', s.mode !== 'royale');
    $('set-words').classList.toggle('hidden', s.mode === 'royale');
    $('mode-blurb').textContent = {
      classic: 'same word, everyone races — most points after all words wins',
      royale: 'endless words, ante into the pot, hit 0 = out. last standing wins',
      friend: 'take turns setting a secret word for the others. stump everyone to score',
    }[s.mode] || '';
    const enough = m.players.filter((p) => p.connected).length >= 2;
    $('btn-start').classList.toggle('hidden', !m.isHost());
    $('btn-start').disabled = !enough;
    $('btn-start').textContent = enough ? 'START' : 'NEED 2+ PLAYERS';
    $('lobby-wait').classList.toggle('hidden', m.isHost());
  }

  // ---------- game strip / opponents ----------
  renderStrip() {
    const m = this.mirror;
    const strip = $('players-strip');
    strip.replaceChildren();
    for (const p of m.players) {
      strip.append(el('div', {
        class: 'strip-p' + (p.alive ? '' : ' dead') + (p.connected ? '' : ' gone')
          + (m.round && m.round.setterId === p.id ? ' setter' : ''),
        'data-testid': `strip-${p.id}`,
        style: { '--sig': p.color },
      },
      el('span', { class: 'strip-name', text: (p.id === m.selfId ? '★ ' : '') + p.name }),
      el('span', { class: 'strip-score', 'data-testid': `score-${p.id}`, text: p.score })));
    }
  }

  buildOpponents() {
    const m = this.mirror;
    const box = $('opponents');
    box.replaceChildren();
    this.oppTiles = {};
    for (const p of m.players) {
      if (p.id === m.selfId) continue;
      const grid = el('div', { class: 'opp-grid' });
      const tiles = [];
      for (let r = 0; r < MAX_ROWS; r++) {
        const rowEl = el('div', { class: 'opp-row' });
        const row = [];
        for (let c = 0; c < WORD_LEN; c++) {
          const t = el('div', { class: 'opp-tile', 'data-testid': `opp-${p.id}-${r}-${c}` });
          rowEl.append(t);
          row.push(t);
        }
        grid.append(rowEl);
        tiles.push(row);
      }
      this.oppTiles[p.id] = tiles;
      // FRIEND setter's heckle bar - hidden unless I'm the watching setter
      const reactBar = el('div', { class: 'react-bar hidden', 'data-react-for': p.id });
      for (const emoji of REACTIONS) {
        reactBar.append(el('button', {
          class: 'react-btn', text: emoji, 'data-testid': `react-${p.id}-${emoji}`,
          onclick: () => m.react(emoji, p.id),
        }));
      }
      box.append(el('div', {
        class: 'opp-panel', 'data-testid': `opp-${p.id}`, style: { '--sig': p.color },
      },
      el('div', { class: 'opp-name', text: p.name }),
      grid,
      el('div', { class: 'opp-status', 'data-opp-status': p.id }),
      reactBar));
    }
  }

  renderOpponents() {
    const m = this.mirror;
    if (!m.round || !this.oppTiles) return;
    for (const [pid, tiles] of Object.entries(this.oppTiles)) {
      const rows = m.round.grids[pid] || [];
      const p = m.player(pid);
      for (let r = 0; r < MAX_ROWS; r++) {
        for (let c = 0; c < WORD_LEN; c++) {
          const t = tiles[r][c];
          const row = rows[r];
          t.className = 'opp-tile' + (row ? ` ${row.colors[c]}` : '');
          // letters render ONLY when the mirror has them - i.e. for the
          // FRIEND setter's live feed; competing guessers get colors alone
          t.textContent = row && row.word ? row.word[c].toUpperCase() : '';
        }
      }
      // peeked letters bleed through (colors-only rule broken ONLY by Peek)
      for (const pk of m.peeks) {
        if (pk.target === pid && tiles[pk.row]) {
          tiles[pk.row][pk.col].textContent = pk.letter.toUpperCase();
          tiles[pk.row][pk.col].classList.add('peeked');
        }
      }
      const panel = box$(pid);
      if (panel) {
        const status = m.round.done[pid];
        const label = p && !p.connected ? 'left' : p && !p.alive ? '\u{1F480} out'
          : m.round.setterId === pid ? '\u{1F608} setter'
            : status === 'solved' ? '✨ solved!' : status ? '✖' : '';
        panel.textContent = label;
        panel.parentElement.classList.toggle('solved', status === 'solved');
        panel.parentElement.classList.toggle('dead', !!p && !p.alive);
      }
    }
    function box$(pid) { return document.querySelector(`[data-opp-status="${pid}"]`); }
  }

  // ---------- own board ----------
  onWord(d) {
    const m = this.mirror;
    $('ovl-reveal').classList.add('hidden');
    $('duel-panel').classList.add('hidden');
    $('game-main').classList.remove('hidden');
    this.renderRoundHeader();
    this.renderStrip();
    this.renderBoard();
    this.renderKeyboard();
    this.renderOpponents();
    this.renderShop();

    const setPhase = d.phase === 'set';
    $('setter-panel').classList.toggle('hidden', !(setPhase && m.amSetter()));
    $('game-main').classList.toggle('hidden', setPhase && m.amSetter());
    const banner = $('setter-banner');
    if (setPhase && !m.amSetter()) {
      const setter = m.player(d.setterId);
      banner.textContent = `\u{1F608} ${setter ? setter.name : '???'} is scheming a secret word…`;
      banner.classList.remove('hidden');
    } else if (!setPhase && m.settings.mode === 'friend' && m.amSetter()) {
      banner.textContent = '\u{1F608} your word is live — watch them squirm';
      banner.classList.remove('hidden');
    } else if (!setPhase && m.amSpectator()) {
      banner.textContent = '\u{1F47B} spectating';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    if (setPhase && m.amSetter()) this.renderSetter();
    this.renderSetterView();
    if (d.skipped) this.showToast('Setter skipped — next player sets!');
    if (!setPhase) sfx.reveal();
  }

  // FRIEND setter spectating: own board folds away, rival grids grow and show
  // real letters, and each panel grows a heckle bar.
  renderSetterView() {
    const m = this.mirror;
    const watching = !!(m.settings && m.settings.mode === 'friend' && m.round
      && m.round.phase === 'play' && m.amSetter() && !m.over);
    document.querySelector('.board-wrap').classList.toggle('hidden', watching);
    $('opponents').classList.toggle('setter-view', watching);
    $('keyboard').classList.toggle('hidden', watching);
    for (const bar of document.querySelectorAll('.react-bar')) {
      bar.classList.toggle('hidden', !watching);
    }
  }

  spawnReaction(d) {
    const m = this.mirror;
    // everyone sees the emoji sail over the target's panel...
    const panel = document.querySelector(`[data-testid="opp-${d.target}"]`);
    if (panel) {
      const f = el('span', { class: 'float-emoji', text: d.emoji });
      panel.append(f);
      setTimeout(() => f.remove(), 1700);
    }
    // ...and the target gets it big, center-board
    if (d.target === m.selfId) {
      const splash = el('div', { class: 'emoji-splash', text: d.emoji });
      document.querySelector('.board-wrap').append(splash);
      setTimeout(() => splash.remove(), 1500);
    }
    sfx.pop();
  }

  renderRoundHeader() {
    const m = this.mirror;
    const r = m.round;
    if (!r) return;
    $('hdr-round').textContent = m.settings.mode === 'royale'
      ? `WORD ${r.no}` : `WORD ${r.no}/${r.total}`;
    const potEl = $('hdr-pot');
    if (m.settings.mode === 'royale') {
      potEl.textContent = `\u{1F3C6} POT ${r.pot}`;
      potEl.classList.remove('hidden');
    } else potEl.classList.add('hidden');
    $('hdr-timer').classList.toggle('hidden', !r.timerMs);
  }

  renderBoard() {
    const m = this.mirror;
    if (!m.round) return;
    const rows = m.myRows();
    const activeRow = rows.length;
    for (let r = 0; r < MAX_ROWS; r++) {
      const row = rows[r];
      for (let c = 0; c < WORD_LEN; c++) {
        const t = this.tiles[r][c];
        t.classList.remove('active-row', 'filled', 'g', 'y', 'x', 'ghost', 'flip', 'cascade');
        if (row) {
          t.textContent = (row.word ? row.word[c] : '').toUpperCase();
          t.classList.add(row.colors[c]);
        } else if (r === activeRow && !m.round.done[m.selfId]) {
          t.classList.add('active-row');
          const ch = m.input[c];
          const hint = m.hints[c];
          if (ch) { t.textContent = ch.toUpperCase(); t.classList.add('filled'); }
          else if (hint) { t.textContent = hint.toUpperCase(); t.classList.add('ghost'); }
          else t.textContent = '';
        } else {
          t.textContent = '';
        }
      }
    }
  }

  renderInputRow() { this.renderBoard(); }

  shakeRow() {
    const m = this.mirror;
    const r = Math.min(m.myRows().length, MAX_ROWS - 1);
    const rowEl = this.tiles[r][0].parentElement;
    rowEl.classList.remove('shake');
    void rowEl.offsetWidth;
    rowEl.classList.add('shake');
  }

  onResult(d) {
    const m = this.mirror;
    if (d.pid === m.selfId) {
      // flip-reveal my row with letters
      this.renderBoard();
      const rowTiles = this.tiles[d.row];
      rowTiles.forEach((t, i) => {
        t.style.animationDelay = `${i * 0.12}s`;
        t.classList.add('flip');
        sfx.flip(i);
      });
      if (d.solved) {
        this.cascade();
        sfx.solve();
      } else if (d.done) {
        sfx.lose();
      }
      this.renderKeyboard();
    } else {
      this.renderOpponents();
      const tiles = this.oppTiles?.[d.pid]?.[d.row];
      if (tiles) tiles.forEach((t, i) => { t.style.animationDelay = `${i * 0.06}s`; t.classList.add('pop'); });
      if (d.solved) {
        const p = m.player(d.pid);
        this.showToast(`⚡ ${p ? p.name : '???'} solved it!`);
      }
    }
    this.renderShop();
  }

  cascade() {
    for (let r = 0; r < MAX_ROWS; r++) {
      for (let c = 0; c < WORD_LEN; c++) {
        const t = this.tiles[r][c];
        t.style.animationDelay = `${(r + c) * 0.06}s`;
        t.classList.add('cascade');
      }
    }
  }

  // ---------- keyboard ----------
  renderKeyboard() {
    const m = this.mirror;
    const state = m ? m.keyboardState() : {};
    for (const [ch, btn] of Object.entries(this.keys)) {
      btn.classList.remove('g', 'y', 'x');
      if (state[ch]) btn.classList.add(state[ch]);
    }
  }

  pressKey(ch) {
    const m = this.mirror;
    if (!m) return;
    const btn = this.keys[ch];
    if (btn) {
      btn.classList.remove('ripple');
      void btn.offsetWidth;
      btn.classList.add('ripple');
    }
    if (ch === '⏎') m.enter();
    else if (ch === '⌫') m.backspace();
    else m.type(ch);
    if (m.round && m.round.phase === 'set' && m.amSetter()) this.renderSetter();
  }

  renderSetter() {
    const m = this.mirror;
    for (let c = 0; c < WORD_LEN; c++) {
      const t = this.setterTiles[c];
      const ch = m.input[c];
      t.textContent = ch ? ch.toUpperCase() : '';
      t.classList.toggle('filled', !!ch);
    }
    $('setter-panel').querySelector('.setter-tip').textContent =
      m.setterBusy ? 'checking…' : 'type, then ENTER';
  }

  // ---------- shop ----------
  renderShop() {
    const m = this.mirror;
    const shop = $('shop');
    const mode = m.settings ? m.settings.mode : 'classic';
    const visible = m.started && !m.over && mode !== 'friend';
    shop.classList.toggle('hidden', !visible);
    if (!visible) return;
    const me = m.me();
    const r = m.round;
    const canBuy = r && r.phase === 'play' && !r.suspended && !r.timeUp && me && me.alive
      && !me.spectator && !r.done[m.selfId] && !m.reveal;
    for (const btn of shop.querySelectorAll('.shop-btn')) {
      const id = btn.dataset.item;
      const item = SHOP[id];
      if (id === 'duel') {
        btn.classList.toggle('hidden', mode !== 'royale');
        btn.disabled = !canBuy || !!m.duel;
      } else {
        btn.classList.remove('hidden');
        btn.disabled = !canBuy || !me || me.score < item.price;
      }
    }
  }

  shopClick(id) {
    const m = this.mirror;
    if (id === 'freeze' || id === 'hint') { m.buy(id); return; }
    this.openPicker(id);
  }

  openPicker(item) {
    const m = this.mirror;
    this.pickerItem = item;
    this.pickerTarget = null;
    $('picker-title').textContent = `${SHOP[item].emoji} ${SHOP[item].name} — pick a target`;
    const box = $('picker-targets');
    box.replaceChildren();
    for (const p of m.players) {
      if (p.id === m.selfId || !p.connected || !p.alive || p.spectator) continue;
      box.append(el('button', {
        class: 'picker-target', 'data-testid': `pick-${p.id}`, style: { '--sig': p.color },
        text: p.name,
        onclick: (e) => {
          this.pickerTarget = p.id;
          for (const b of box.children) b.classList.remove('on');
          e.target.classList.add('on');
          $('btn-picker-go').disabled = false;
        },
      }));
    }
    $('picker-stake').classList.toggle('hidden', item !== 'duel');
    $('btn-picker-go').disabled = true;
    $('btn-picker-go').onclick = () => {
      const stake = item === 'duel' ? Number($('stake-range').value) : undefined;
      m.buy(item, this.pickerTarget, stake);
      this.closePicker();
    };
    $('ovl-picker').classList.remove('hidden');
  }

  closePicker() { $('ovl-picker').classList.add('hidden'); }

  // ---------- reveal / duel / gameover ----------
  onReveal(d) {
    const m = this.mirror;
    this.renderStrip();
    this.renderOpponents();
    this.renderShop();
    $('reveal-label').textContent = d.winner
      ? `${m.player(d.winner)?.name || '???'} took it!`
      : (m.settings.mode === 'friend' ? 'NOBODY got it — setter scores!' : 'nobody solved it…');
    const wordBox = $('reveal-word');
    wordBox.replaceChildren();
    for (const [i, ch] of [...d.word.toUpperCase()].entries()) {
      wordBox.append(el('span', { class: 'reveal-tile', text: ch, style: { animationDelay: `${i * 0.1}s` } }));
    }
    const scores = $('reveal-scores');
    scores.replaceChildren();
    for (const p of m.players) {
      const delta = d.deltas[p.id];
      scores.append(el('div', {
        class: 'reveal-line' + ((d.eliminated || []).includes(p.id) ? ' elim' : ''),
        style: { '--sig': p.color },
      },
      el('span', { text: p.name }),
      el('span', { class: 'reveal-delta', text: delta ? `+${delta}` : ((d.eliminated || []).includes(p.id) ? '\u{1F480} OUT' : '') }),
      el('span', { class: 'reveal-total', text: p.score })));
    }
    const potLine = $('reveal-pot');
    if (m.settings.mode === 'royale' && !d.winner) {
      potLine.textContent = `\u{1F3C6} pot rolls over: ${d.pot}`;
      potLine.classList.remove('hidden');
    } else potLine.classList.add('hidden');
    $('ovl-reveal').classList.remove('hidden');
    if (d.winner === m.selfId) sfx.pot();
    else if (d.winner) sfx.reveal();
    else sfx.lose();
  }

  onDuelStart(d) {
    const m = this.mirror;
    const a = m.player(d.a), b = m.player(d.b);
    $('game-main').classList.add('hidden');
    $('setter-panel').classList.add('hidden');
    $('duel-panel').classList.remove('hidden');
    $('duel-title').textContent = `⚔️ ${a?.name} vs ${b?.name}`;
    $('duel-sub').textContent = d.stake > 0 ? `stake: ${d.stake} points — loser pays!` : 'honor duel — no stake';
    $('duel-result').classList.add('hidden');
    this.renderDuel();
    sfx.duel();
  }

  renderDuel() {
    const m = this.mirror;
    const duel = m.duel;
    if (!duel) return;
    for (let r = 0; r < MAX_ROWS; r++) {
      const row = duel.rows[r];
      for (let c = 0; c < WORD_LEN; c++) {
        const t = this.duelTiles[r][c];
        t.className = 'tile mini-duel';
        t.style.removeProperty('--sig');
        if (row) {
          t.textContent = row.word[c].toUpperCase();
          t.classList.add(row.colors[c]);
          const p = m.player(row.pid);
          if (p) t.style.setProperty('--sig', p.color);
        } else if (r === duel.rows.length && duel.turn === m.selfId && !duel.over) {
          t.textContent = (m.input[c] || '').toUpperCase();
          t.classList.add('active-row');
        } else {
          t.textContent = '';
        }
      }
    }
    const turnP = m.player(duel.turn);
    $('duel-turn').textContent = duel.over ? ''
      : duel.turn === m.selfId ? '\u{1F525} YOUR TURN — type a guess!'
        : `waiting for ${turnP ? turnP.name : '???'}…`;
  }

  onDuelEnd(d) {
    const m = this.mirror;
    this.renderDuel();
    this.renderStrip();
    const res = $('duel-result');
    res.classList.remove('hidden');
    if (d.draw) res.textContent = `DRAW — the word was "${d.word.toUpperCase()}". stakes returned.`;
    else {
      const w = m.player(d.winner), l = m.player(d.loser);
      res.textContent = `${w?.name} WINS${d.stake ? ` +${d.stake}` : ''}! word: "${d.word.toUpperCase()}"`
        + ((d.eliminated || []).length ? ` — ${l?.name} is BUSTED \u{1F480}` : '');
    }
    if (d.winner === m.selfId) sfx.win();
    else if (d.loser === m.selfId) sfx.lose();
  }

  onResume() {
    $('duel-panel').classList.add('hidden');
    $('game-main').classList.remove('hidden');
    this.renderBoard();
    this.renderOpponents();
    this.renderShop();
    this.renderStrip();
  }

  onLeft(d) {
    const m = this.mirror;
    const p = m.player(d.pid);
    this.showToast(`${p ? p.name : 'someone'} left the game`);
    this.renderStrip();
    this.renderOpponents();
    if (!m.started) this.renderLobby();
  }

  onGameOver(d) {
    const m = this.mirror;
    this.setPaused(false);
    this.closePicker();
    $('ovl-reveal').classList.add('hidden'); // the final reveal must not cover the podium
    this.show('scr-over');
    const winner = m.player(d.winner);
    const iWon = d.winner === m.selfId;
    $('over-title').textContent = iWon ? '\u{1F308} YOU WIN! \u{1F308}' : winner ? `${winner.name} WINS!` : 'GAME OVER';
    $('over-title').classList.toggle('mega-win', iWon);
    const ol = $('standings');
    ol.replaceChildren();
    for (const p of d.standings) {
      ol.append(el('li', {
        class: 'standing' + (p.id === d.winner ? ' winner' : ''),
        'data-testid': `standing-${p.id}`,
        style: { '--sig': p.color },
      },
      el('span', { text: p.name + (p.id === m.selfId ? ' (you)' : '') }),
      el('span', { class: 'standing-score', text: p.score })));
    }
    $('btn-again').classList.toggle('hidden', !m.isHost());
    $('over-wait').classList.toggle('hidden', m.isHost());
    if (iWon) sfx.win(); else sfx.reveal();
  }

  onResync() {
    const m = this.mirror;
    if (m.over && m.gameover) { this.onGameOver(m.gameover); return; }
    if (!m.started) { this.show('scr-lobby'); this.renderLobby(); return; }
    this.show('scr-game');
    this.buildOpponents();
    this.renderStrip();
    if (m.round) this.onWord({ phase: m.round.phase, setterId: m.round.setterId });
    if (m.duel) { this.onDuelStart({ a: m.duel.a, b: m.duel.b, stake: m.duel.stake }); this.renderDuel(); }
  }

  // ---------- ticker ----------
  tick() {
    const m = this.mirror;
    if (!m || !m.round || m.over) return;
    const r = m.round;
    // pre-word countdown
    const cd = $('countdown');
    if (r.phase === 'play' && !r.suspended && r.unlockAt > now()) {
      cd.textContent = Math.ceil((r.unlockAt - now()) / 1000);
      cd.classList.remove('hidden');
    } else {
      cd.classList.add('hidden');
    }
    // word timer
    if (r.timerMs > 0 && r.phase === 'play') {
      const left = r.unlockAt + r.timerMs - now();
      const timerEl = $('hdr-timer');
      timerEl.textContent = `⏱ ${fmtMs(left)}`;
      timerEl.classList.toggle('urgent', left < 11000 && left > 0);
    }
    // freeze overlay
    const fz = $('freeze-overlay');
    if (m.frozen()) {
      $('freeze-secs').textContent = Math.ceil((m.frozenUntil - now()) / 1000);
      fz.classList.remove('hidden');
      $('keyboard').classList.add('frozen');
    } else {
      fz.classList.add('hidden');
      $('keyboard').classList.remove('frozen');
    }
  }
}
