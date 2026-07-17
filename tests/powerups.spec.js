import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, secret, setScore, buy,
  waitUnlocked, waitRound, guessWait, wrongWords, FAST,
} from './helpers.js';

test('power-ups: hint, peek, freeze, smudge — effects and deductions', async ({ context }) => {
  test.setTimeout(90000);
  const host = await openPage(context);
  const code = await hostGame(host, 'HOSTP', { ...FAST, mode: 'classic', words: 10 });
  const pA = await openPage(context);
  await joinGame(pA, code, 'AMBER');
  await host.waitForFunction(() => window.__friendle.state().players.length === 2);
  const [hostId, aId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));

  await startGame(host, [host, pA]);
  await waitRound(host, 1);
  await Promise.all([waitUnlocked(host), waitUnlocked(pA)]);
  const w1 = await secret(host);

  // Classic starts at 0 points; the shop demands cash up front.
  await buy(pA, 'hint');
  await expect(pA.locator('#toast')).toContainText('Need 75');

  await setScore(host, hostId, 500);
  await setScore(host, aId, 500);

  // ---------- HINT: reveals a true green letter in your own grid ----------
  await buy(pA, 'hint');
  await pA.waitForFunction(() => Object.keys(window.__friendle.state().hints).length === 1);
  let s = await state(pA);
  const [col, letter] = Object.entries(s.hints)[0];
  expect(w1[Number(col)]).toBe(letter);
  expect(s.players.find((p) => p.id === aId).score).toBe(425); // 500 - 75

  // ---------- PEEK: see one real letter of the rival's latest guess ----------
  const hostGuess = wrongWords(w1, 1)[0];
  await guessWait(host, hostGuess);
  await buy(pA, 'peek', hostId);
  await pA.waitForFunction(() => window.__friendle.state().peeks.length === 1);
  s = await state(pA);
  const pk = s.peeks[0];
  expect(pk.target).toBe(hostId);
  expect(pk.row).toBe(0);
  expect(hostGuess[pk.col]).toBe(pk.letter);
  expect(s.players.find((p) => p.id === aId).score).toBe(350);
  // and it renders on the opponent mini-grid (the one legal letter leak)
  await expect(pA.locator(`[data-testid="opp-${hostId}-0-${pk.col}"]`))
    .toHaveText(pk.letter.toUpperCase());

  // peek with no guesses to peek at is refused (fresh target rule: self-target)
  await buy(pA, 'peek', aId);
  await expect(pA.locator('#toast')).toContainText('opponent');

  // A guess word sharing no letters with the secret guarantees gray keys for
  // the smudge test below (falls back to any wrong word).
  const disjointPool = ['jumbo', 'fizzy', 'whack', 'pluck', 'dowdy', 'crane', 'slimy', 'ghost'];
  const dis = disjointPool.find((w) => w !== w1 && [...w].every((ch) => !w1.includes(ch)))
    || wrongWords(w1, 1)[0];

  // ---------- FREEZE: rival keyboards lock for 5s, host rejects frozen guesses --------
  await buy(host, 'freeze');
  await pA.waitForFunction(() => window.__friendle.state().frozen);
  // Playwright clicks can land late on a frozen keyboard - drive the engine
  // directly per the spec: the mirror refuses while frozen.
  expect(await pA.evaluate((w) => window.__friendle.guess(w), dis)).toBe(false);
  // even a raw intent straight past the mirror is bounced by the host
  await pA.evaluate((w) => window.__friendle.net.emit('guess', {
    no: 1, row: (window.__friendle.state().round.grids[window.__friendle.selfId] || []).length,
    word: w, elapsed: 1,
  }), dis);
  await expect(pA.locator('#toast')).toContainText('Frozen');
  // the buyer is NOT frozen
  expect(await host.evaluate(() => window.__friendle.state().frozen)).toBe(false);
  // thaw
  await pA.waitForFunction(() => !window.__friendle.state().frozen, null, { timeout: 8000 });
  expect(await pA.evaluate((w) => window.__friendle.guess(w), dis)).toBe(true);

  // ---------- SMUDGE: un-grays a letter on the rival's keyboard ----------
  await pA.waitForFunction(() => {
    const st = window.__friendle.state();
    return (st.round.grids[st.selfId] || []).length === 1;
  });
  const kbBefore = await pA.evaluate(() => window.__friendle.state().keyboard);
  const graysBefore = Object.keys(kbBefore).filter((L) => kbBefore[L] === 'x');
  expect(graysBefore.length).toBeGreaterThan(0);
  await buy(host, 'smudge', aId);
  await pA.waitForFunction((n) => {
    const kb = window.__friendle.state().keyboard;
    return Object.keys(kb).filter((L) => kb[L] === 'x').length === n - 1;
  }, graysBefore.length);
  const kbAfter = await pA.evaluate(() => window.__friendle.state().keyboard);
  const graysAfter = new Set(Object.keys(kbAfter).filter((L) => kbAfter[L] === 'x'));
  const smudged = graysBefore.filter((L) => !graysAfter.has(L));
  expect(smudged).toHaveLength(1); // poisoned, silently

  // ---------- guardrails ----------
  await buy(host, 'duel', aId, 100); // duel outside royale
  await expect(host.locator('#toast')).toContainText('Royale');
  const hostScore = (await state(host)).players.find((p) => p.id === hostId).score;
  await setScore(host, hostId, 10);
  await buy(host, 'freeze'); // can't afford
  await expect(host.locator('#toast')).toContainText('Need 100');
  expect(hostScore).toBeGreaterThanOrEqual(0);
});
