import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, joinViaLink, startGame, state, engineState,
  secret, waitUnlocked, waitRound, waitReveal, guessWait, failWord, FAST,
} from './helpers.js';

test('four players: full room, a fifth is bounced, and grids mirror everywhere', async ({ context }) => {
  test.setTimeout(90000);
  const host = await openPage(context);
  const code = await hostGame(host, 'ONE', { ...FAST, mode: 'royale', ante: 25 });
  const p2 = await openPage(context);
  await joinGame(p2, code, 'TWO');
  const p3 = await openPage(context);
  await joinGame(p3, code, 'THREE');
  const p4 = await joinViaLink(context, code, 'FOUR');
  await host.waitForFunction(() => window.__friendle.state().players.length === 4);

  // a fifth wheel is politely rejected
  const p5 = await openPage(context);
  await p5.fill('#inp-name', 'FIVE');
  await p5.fill('#inp-code', code);
  await p5.click('#btn-join');
  await p5.waitForSelector('#scr-dead:not(.hidden)', { timeout: 15000 });
  await expect(p5.locator('#dead-msg')).toContainText('full');
  await p5.close();

  const ids = await host.evaluate(() => window.__friendle.state().players.map((p) => p.id));
  const pages = [host, p2, p3, p4];

  await startGame(host, pages);
  await waitRound(host, 1);

  // 4 antes of 25 in the pot
  expect((await engineState(host)).pot).toBe(100);

  // every page shows three opponent panels
  for (const page of pages) {
    await expect(page.locator('.opp-panel')).toHaveCount(3);
  }

  await Promise.all(pages.map((p) => waitUnlocked(p)));
  const w1 = await secret(host);

  // everyone throws one wrong guess; every page mirrors all four grids
  await Promise.all(pages.map((p, i) => guessWait(p, ['crane', 'slimy', 'pouty', 'vague'][i] === w1 ? 'depth' : ['crane', 'slimy', 'pouty', 'vague'][i])));
  for (const page of pages) {
    await page.waitForFunction((n) => {
      const s = window.__friendle.state();
      return Object.values(s.round.grids).filter((g) => g.length >= 1).length === n;
    }, 4);
    const s = await state(page);
    const mine = await page.evaluate(() => window.__friendle.selfId);
    for (const pid of Object.keys(s.round.grids)) {
      const row = s.round.grids[pid][0];
      expect(row.colors).toMatch(/^[gyx]{5}$/);
      if (pid !== mine) expect(row.word).toBeUndefined(); // colors only, never letters
    }
  }

  // TWO wins the pot; scores update on every page
  await guessWait(p2, w1);
  await waitReveal(p4, 1);
  const s = await state(p4);
  expect(s.lastReveal.winner).toBe(ids[1]);
  expect(s.lastReveal.deltas[ids[1]]).toBe(100);
  expect(s.players.find((p) => p.id === ids[1]).score).toBe(1075);

  // three players quit -> the game folds to a finish for the survivor
  await waitRound(host, 2);
  await p3.close();
  await p4.close();
  await p2.close();
  await host.waitForFunction(() => window.__friendle.state().over, null, { timeout: 20000 });
  const hs = await state(host);
  expect(hs.gameover.winner).toBe(ids[0]);
  await host.waitForSelector('#scr-over:not(.hidden)');
});
