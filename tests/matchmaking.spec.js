import { test, expect } from '@playwright/test';
import { openPage, hostGame, joinGame, joinViaLink, state, selfId } from './helpers.js';

test.describe('matchmaking', () => {
  test('host gets a clean 4-char code, guests join by code and by share link', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'HOSTY');
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/); // no O/0/I/1 lookalikes

    const g1 = await openPage(context);
    await joinGame(g1, code, 'GUESTA');
    const g2 = await joinViaLink(context, code, 'GUESTB');

    // all three lobbies list all three players, with distinct signature colors
    for (const page of [host, g1, g2]) {
      await page.waitForFunction(() => window.__friendle.state().players.length === 3);
      const s = await state(page);
      expect(s.players.map((p) => p.name).sort()).toEqual(['GUESTA', 'GUESTB', 'HOSTY']);
      const colors = s.players.map((p) => p.color);
      expect(new Set(colors).size).toBe(3);
      expect(s.hostId).toBe(await selfId(host));
    }

    // host sees an enabled START; guests wait
    await expect(host.locator('#btn-start')).toBeEnabled();
    await expect(g1.locator('#btn-start')).toBeHidden();
    await expect(g1.locator('#lobby-wait')).toBeVisible();
  });

  test('joining a dead code fails with a friendly error', async ({ context }) => {
    const page = await openPage(context);
    await page.fill('#inp-name', 'LOST');
    await page.fill('#inp-code', 'ZZZZ');
    await page.click('#btn-join');
    await page.waitForSelector('#scr-dead:not(.hidden)', { timeout: 20000 });
    const msg = await page.textContent('#dead-msg');
    expect(msg).toContain('ZZZZ');
    expect(msg.toLowerCase()).toContain('napping');
  });
});
