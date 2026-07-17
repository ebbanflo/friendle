import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, secret,
  waitUnlocked, waitRound, waitReveal, guessWait, FAST,
} from './helpers.js';

// Regression: guests used to get "kicked" a few seconds into a real game -
// the host-presence watchdog started from an empty roster (presence had
// already synced before it attached) and the host's kick clock could start
// on a joiner whose join broadcast outran their presence registration.
test('an idle room outlives the leave-grace window with nobody kicked', async ({ context }) => {
  test.setTimeout(90000);
  const host = await openPage(context);
  const code = await hostGame(host, 'PATIENT', { ...FAST, mode: 'classic', words: 1 });
  const guest = await openPage(context);
  await joinGame(guest, code, 'QUIET');
  await host.waitForFunction(() => window.__friendle.state().players.length === 2);
  const [hostId, guestId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));

  await startGame(host, [host, guest]);
  await waitRound(guest, 1);
  await Promise.all([waitUnlocked(host), waitUnlocked(guest)]);

  // everyone stares at the word in silence, well past LEAVE_GRACE_MS (8s)
  await guest.waitForTimeout(12000);

  // nobody died, nobody got kicked
  const gs = await state(guest);
  expect(gs.roomDead).toBe(false);
  expect(gs.players.every((p) => p.connected)).toBe(true);
  await expect(guest.locator('#scr-game')).toBeVisible();
  await expect(guest.locator('#scr-dead')).toBeHidden();
  const hs = await state(host);
  expect(hs.players.find((p) => p.id === guestId).connected).toBe(true);

  // and the guest can still play and win
  const w = await secret(host);
  await guessWait(guest, w);
  await guessWait(host, w);
  await waitReveal(host, 1);
  expect((await state(host)).lastReveal.winner).toBe(guestId);
});
