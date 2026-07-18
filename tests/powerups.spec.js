import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, secret, duelSecret, setScore,
  buy, waitUnlocked, waitRound, waitReveal, guessWait, wrongWords, FAST,
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
  await setScore(host, hostId, 10);
  await buy(host, 'freeze'); // can't afford
  await expect(host.locator('#toast')).toContainText('Need 100');
});

test('classic duel via real clicks: picker, stake, typing renders, payout, resume', async ({ context }) => {
  const host = await openPage(context);
  const code = await hostGame(host, 'BLADE', { ...FAST, mode: 'classic', words: 10 });
  const pA = await openPage(context);
  await joinGame(pA, code, 'EDGE');
  await host.waitForFunction(() => window.__friendle.state().players.length === 2);
  const [hostId, aId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));

  await startGame(host, [host, pA]);
  await waitRound(host, 1);
  await Promise.all([waitUnlocked(host), waitUnlocked(pA)]);
  await setScore(host, hostId, 300);
  await setScore(host, aId, 300);

  // the whole flow through the actual UI: shop button -> picker -> stake -> GO
  await expect(host.locator('[data-testid="shop-duel"]')).toBeVisible(); // Classic has duels now
  await host.click('[data-testid="shop-duel"]');
  await expect(host.locator('#ovl-picker')).toBeVisible();
  await host.click(`[data-testid="pick-${aId}"]`);
  await host.locator('#stake-range').fill('100');
  await host.click('#btn-picker-go');

  await host.waitForFunction(() => {
    const st = window.__friendle.state();
    return st.duel && !st.duel.over;
  }, null, { polling: 100 });
  await expect(host.locator('#duel-panel')).toBeVisible();
  await expect(pA.locator('#duel-panel')).toBeVisible();

  // challenger types on the real keyboard - letters must appear in the DUEL
  // grid as typed (the bug: the duel grid never re-rendered on input)
  const dw = await duelSecret(host);
  for (const ch of dw) await host.click(`[data-testid="key-${ch}"]`);
  await expect(host.locator('[data-testid="duel-0-0"]')).toHaveText(dw[0].toUpperCase());
  await expect(host.locator('[data-testid="duel-0-4"]')).toHaveText(dw[4].toUpperCase());
  await host.click('[data-testid="key-enter"]');

  // challenger solves -> wins the stake; Classic never eliminates the loser
  await host.waitForFunction(() => window.__friendle.state().lastDuel, null, { polling: 100 });
  const s = await state(host);
  expect(s.lastDuel.result.winner).toBe(hostId);
  expect(s.lastDuel.result.eliminated).toHaveLength(0);
  expect(s.players.find((p) => p.id === hostId).score).toBe(400);
  expect(s.players.find((p) => p.id === aId).score).toBe(200);
  expect(s.players.find((p) => p.id === aId).alive).toBe(true);
  await expect(host.locator('#duel-result')).toContainText('WINS');

  // the interrupted word resumes for everyone
  await host.waitForFunction(() => {
    const st = window.__friendle.state();
    return st.round && st.round.suspended === false && !st.duel;
  }, null, { polling: 100 });
  await expect(host.locator('#duel-panel')).toBeHidden();
  await expect(host.locator('#game-main')).toBeVisible();
  const w = await secret(host);
  await guessWait(pA, w); // and it can still be won
  await guessWait(host, w); // both finish so the round can close
  await waitReveal(pA, 1);
  expect((await state(pA)).lastReveal.winner).toBe(aId);
});
