import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, secret, setSettings,
  waitUnlocked, waitRound, waitReveal, waitGameOver, guessWait, failWord,
  wrongWords, wireLog, FAST,
} from './helpers.js';

test('classic: full 3-word match with live color-only mirroring and scoring', async ({ context }) => {
  const host = await openPage(context);
  const code = await hostGame(host, 'ALPHA', { ...FAST, mode: 'classic', words: 3 });
  const guest = await openPage(context);
  await joinGame(guest, code, 'BRAVO');
  await host.waitForFunction(() => window.__friendle.state().players.length === 2);
  const [hostId, guestId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));

  await startGame(host, [host, guest]);

  // ---------- word 1: guest plays via the real on-screen keyboard ----------
  await waitRound(guest, 1);
  await waitUnlocked(guest);
  const word1 = await secret(host);
  expect(word1).toMatch(/^[a-z]{5}$/);

  const typed = wrongWords(word1, 1)[0];
  for (const ch of typed) await guest.click(`[data-testid="key-${ch}"]`);
  // physical keyboard works too: finish with Enter
  await guest.keyboard.press('Enter');
  await guest.waitForFunction(() => {
    const s = window.__friendle.state();
    return (s.round.grids[s.selfId] || []).length === 1;
  });

  // guest sees own letters; host sees COLORS ONLY on the mirror grid
  const gs = await state(guest);
  expect(gs.round.grids[guestId][0].word).toBe(typed);
  expect(gs.round.grids[guestId][0].colors).toMatch(/^[gyx]{5}$/);

  await host.waitForFunction((gid) => {
    const s = window.__friendle.state();
    return (s.round.grids[gid] || []).length === 1;
  }, guestId);
  const hs = await state(host);
  expect(hs.round.grids[guestId][0].colors).toBe(gs.round.grids[guestId][0].colors);
  expect(hs.round.grids[guestId][0].word).toBeUndefined(); // never the letters

  // the DOM mirror shows colored tiles with EMPTY text
  const oppTile = host.locator(`[data-testid="opp-${guestId}-0-0"]`);
  await expect(oppTile).toHaveClass(new RegExp(`\\b${gs.round.grids[guestId][0].colors[0]}\\b`));
  await expect(oppTile).toHaveText('');

  // the secret never crossed the wire before the reveal
  for (const line of await wireLog(guest)) {
    const env = JSON.parse(line);
    if (env.t !== 'reveal') expect(line).not.toContain(`"${word1}"`);
  }

  // host solves -> first-solver points; guest finishes the word without solving
  await waitUnlocked(host);
  await guessWait(host, word1);
  await failWord(guest, word1);
  await waitReveal(guest, 1);
  const rev1 = await state(guest);
  expect(rev1.lastReveal.word).toBe(word1);
  expect(rev1.lastReveal.winner).toBe(hostId);
  const hostPts = rev1.lastReveal.deltas[hostId];
  expect(hostPts).toBeGreaterThanOrEqual(100); // base + bonuses
  expect(rev1.lastReveal.deltas[guestId]).toBeUndefined(); // failed = nothing

  // ---------- word 2: guest solves first, host solves late for a cut ----------
  await waitRound(host, 2);
  await waitUnlocked(guest);
  const word2 = await secret(host);
  expect(word2).not.toBe(word1); // session never repeats
  await guessWait(guest, word2);
  await host.waitForFunction(() => { // grace window closes before late solve lands
    const s = window.__friendle.state();
    return s.round && s.round.done && Object.keys(s.round.done).length >= 1;
  });
  await guessWait(host, word2);
  await waitReveal(host, 2);
  const rev2 = await state(host);
  expect(rev2.lastReveal.winner).toBe(guestId);
  const winnerPts = rev2.lastReveal.deltas[guestId];
  const latePts = rev2.lastReveal.deltas[hostId];
  expect(winnerPts).toBeGreaterThan(0);
  expect(latePts).toBeGreaterThan(0);
  expect(latePts).toBeLessThan(winnerPts); // later solver gets the smaller cut

  // ---------- word 3: nobody solves ----------
  await waitRound(host, 3);
  await waitUnlocked(host);
  const word3 = await secret(host);
  expect([word1, word2]).not.toContain(word3);
  await Promise.all([failWord(host, word3), failWord(guest, word3)]);
  await waitReveal(guest, 3);
  const rev3 = await state(guest);
  expect(rev3.lastReveal.winner).toBeNull();
  expect(Object.keys(rev3.lastReveal.deltas)).toHaveLength(0);

  // ---------- game over: most points wins ----------
  await waitGameOver(host);
  await waitGameOver(guest);
  const over = await state(guest);
  const standings = over.gameover.standings;
  expect(standings).toHaveLength(2);
  expect(standings[0].score).toBeGreaterThanOrEqual(standings[1].score);
  expect(over.gameover.winner).toBe(standings[0].id);
  await expect(host.locator('#btn-again')).toBeVisible();  // host can rematch
  await expect(guest.locator('#btn-again')).toBeHidden();

  // ---------- rematch returns everyone to the lobby ----------
  await host.click('#btn-again');
  await guest.waitForSelector('#scr-lobby:not(.hidden)');
  await expect(guest.locator('#lobby-players .lobby-player').first()).toContainText('ALPHA');
});
