import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, secret, setSettings,
  waitUnlocked, waitRound, waitReveal, guessWait, wrongWords, FAST,
} from './helpers.js';

test('word timer: running out of time fails the word for the slow', async ({ context }) => {
  const host = await openPage(context);
  // the lobby UI offers 60/90/120s; the engine takes any ms - tests go brisk
  const code = await hostGame(host, 'TIC', { ...FAST, mode: 'classic', words: 2, timerMs: 1500 });
  const guest = await openPage(context);
  await joinGame(guest, code, 'TOC');
  await host.waitForFunction(() => window.__friendle.state().players.length === 2);
  const [hostId, guestId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));

  await startGame(host, [host, guest]);
  await waitRound(host, 1);

  // the timer is on screen
  await expect(host.locator('#hdr-timer')).toBeVisible();

  // word 1: nobody answers in time -> both time out, no points
  await waitReveal(host, 1);
  let s = await state(host);
  expect(s.lastReveal.reason).toBe('timeout');
  expect(s.lastReveal.winner).toBeNull();
  expect(Object.keys(s.lastReveal.deltas)).toHaveLength(0);
  expect(s.round.timeUp).toBe(true);

  // word 2: guest guesses once, then stalls; host solves inside the window
  await waitRound(guest, 2);
  await Promise.all([waitUnlocked(host), waitUnlocked(guest)]);
  const w2 = await secret(host);
  await guessWait(guest, wrongWords(w2, 1)[0]);
  await guessWait(host, w2);
  await waitReveal(guest, 2);
  s = await state(guest);
  expect(s.lastReveal.winner).toBe(hostId);
  expect(s.lastReveal.deltas[hostId]).toBeGreaterThan(0);
  expect(s.lastReveal.deltas[guestId]).toBeUndefined();

  // late input after TIME UP is refused locally
  expect(await guest.evaluate(() => window.__friendle.state().inputLocked)).toBeTruthy();
});
