// Shared E2E helpers. Every test runs the real site over LocalTransport
// (?t=local) with the debug handle (?debug=1). All pages share ONE browser
// context so BroadcastChannel connects them like tabs of one machine.

export const BASE = '/index.html?t=local&debug=1';

export async function openPage(context) {
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector('#scr-menu:not(.hidden)');
  return page;
}

// Fast settings used by most matches (humans get 3s countdowns; tests don't).
export const FAST = { revealMs: 350, countdownMs: 120 };

export async function hostGame(page, name, settings) {
  await page.fill('#inp-name', name);
  await page.click('#btn-host');
  await page.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await page.textContent('#room-code')).trim();
  if (settings) await setSettings(page, settings);
  return code;
}

export async function joinGame(page, code, name) {
  await page.fill('#inp-name', name);
  await page.fill('#inp-code', code);
  await page.click('#btn-join');
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 15000 });
}

export async function joinViaLink(context, code, name) {
  const page = await context.newPage();
  await page.addInitScript((n) => localStorage.setItem('friendle-name', n), name);
  await page.goto(`/index.html?t=local&debug=1&join=${code}`);
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 15000 });
  return page;
}

export const state = (page) => page.evaluate(() => window.__friendle.state());
export const engineState = (page) => page.evaluate(() => window.__friendle.engineState());
export const secret = (page) => page.evaluate(() => window.__friendle.secret());
export const duelSecret = (page) => page.evaluate(() => window.__friendle.duelSecret());
export const setSettings = (page, s) => page.evaluate((x) => window.__friendle.setSettings(x), s);
export const setScore = (page, pid, n) => page.evaluate(([p, v]) => window.__friendle.setScore(p, v), [pid, n]);
export const selfId = (page) => page.evaluate(() => window.__friendle.selfId);
export const buy = (page, item, target, stake) =>
  page.evaluate(([i, t, s]) => window.__friendle.buy(i, t, s), [item, target, stake]);

export async function startGame(hostPage, pages) {
  await hostPage.click('#btn-start');
  for (const p of pages) {
    await p.waitForFunction(() => window.__friendle.state().started);
  }
}

const POLL = { polling: 100 }; // background pages throttle rAF; poll by clock

// Wait until this player may type (countdown over, not frozen, round live).
export function waitUnlocked(page) {
  return page.waitForFunction(() => {
    const s = window.__friendle.state();
    return s.round && s.round.phase === 'play' && !s.inputLocked;
  }, null, POLL);
}

export function waitRound(page, no) {
  return page.waitForFunction((n) => {
    const s = window.__friendle.state();
    return s.round && s.round.no === n && s.round.phase === 'play';
  }, no, POLL);
}

// Submit a guess and wait for the host's RESULT to land back in this page.
export async function guessWait(page, word) {
  const before = await page.evaluate(() => {
    const s = window.__friendle.state();
    return (s.round.grids[s.selfId] || []).length;
  });
  const accepted = await page.evaluate((w) => window.__friendle.guess(w), word);
  if (!accepted) return false;
  await page.waitForFunction((n) => {
    const s = window.__friendle.state();
    if (!s.round) return true; // round already wrapped up
    return (s.round.grids[s.selfId] || []).length >= n;
  }, before + 1, { polling: 50 });
  return true;
}

// Six wrong-but-valid guesses (never the secret) = fail the word.
const WRONG_POOL = ['crane', 'slimy', 'pouty', 'vague', 'depth', 'flock', 'wring', 'jumbo'];
export function wrongWords(secretWord, n = 6) {
  return WRONG_POOL.filter((w) => w !== secretWord).slice(0, n);
}
export async function failWord(page, secretWord) {
  for (const w of wrongWords(secretWord)) await guessWait(page, w);
}

// The reveal overlay is transient; the mirror pins the latest payload in
// lastReveal so a slow poll can never miss it.
export function waitReveal(page, no) {
  return page.waitForFunction((n) => {
    const s = window.__friendle.state();
    return s.lastReveal && s.lastReveal.no >= n;
  }, no, POLL);
}

export function waitGameOver(page) {
  return page.waitForFunction(() => window.__friendle.state().over, null, POLL);
}

export const wireLog = (page) => page.evaluate(() => window.__wireLog.slice());
