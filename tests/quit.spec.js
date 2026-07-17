import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, secret,
  waitUnlocked, waitRound, waitReveal, waitGameOver, guessWait, FAST,
} from './helpers.js';

test.describe('quitting and drop-in resilience', () => {
  test('a guest leaving mid-word does not stall the game', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'STAYS', { ...FAST, mode: 'classic', words: 1 });
    const g1 = await openPage(context);
    await joinGame(g1, code, 'ALSO');
    const g2 = await openPage(context);
    await joinGame(g2, code, 'FLAKY');
    await host.waitForFunction(() => window.__friendle.state().players.length === 3);
    const [hostId, , flakyId] = await host.evaluate(() =>
      window.__friendle.state().players.map((p) => p.id));

    await startGame(host, [host, g1, g2]);
    await waitRound(host, 1);
    await Promise.all([waitUnlocked(host), waitUnlocked(g1)]);
    const w1 = await secret(host);

    // FLAKY closes the tab mid-word
    await g2.close();
    await host.waitForFunction((fid) => {
      const s = window.__friendle.state();
      return s.players.find((p) => p.id === fid)?.connected === false;
    }, flakyId, { timeout: 15000 });

    // the word still completes for everyone else
    await guessWait(host, w1);
    await guessWait(g1, w1); // late solve; the leaver is no longer waited on
    await waitReveal(g1, 1);
    await waitGameOver(g1);
    const s = await state(g1);
    expect(s.gameover.winner).toBe(hostId);
  });

  test('host leaving kills the room for the guests', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'BOSS', { ...FAST, mode: 'classic', words: 3 });
    const guest = await openPage(context);
    await joinGame(guest, code, 'ORPHAN');
    const g2 = await openPage(context);
    await joinGame(g2, code, 'WIDOW');
    await host.waitForFunction(() => window.__friendle.state().players.length === 3);

    await startGame(host, [host, guest, g2]);
    await waitRound(guest, 1);

    await host.close(); // pagehide broadcasts ROOM_DEAD

    for (const p of [guest, g2]) {
      await p.waitForSelector('#scr-dead:not(.hidden)', { timeout: 15000 });
      await expect(p.locator('#dead-msg')).toContainText('host');
    }
  });

  test('quit-to-menu works from the lobby for host and guest', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'GONE', FAST);
    const guest = await openPage(context);
    await joinGame(guest, code, 'BRIEF');
    await host.waitForFunction(() => window.__friendle.state().players.length === 2);

    // guest leaves; host's lobby shrinks back to one
    await guest.click('#btn-lobby-quit');
    await guest.waitForSelector('#scr-menu:not(.hidden)');
    await host.waitForFunction(() => window.__friendle.state().players.length === 1);

    // host leaves too; back at the menu
    await host.click('#btn-lobby-quit');
    await host.waitForSelector('#scr-menu:not(.hidden)');
  });
});
