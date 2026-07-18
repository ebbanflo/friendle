import { test, expect } from '@playwright/test';
import { EASY, MEDIUM, HARD } from '../data/tiers.js';
import { SOLUTIONS } from '../data/solutions.js';
import {
  openPage, hostGame, joinGame, startGame, state, secret,
  waitUnlocked, waitRound, waitReveal, guessWait, FAST,
} from './helpers.js';

const easySet = new Set(EASY);
const medSet = new Set(MEDIUM);
const hardSet = new Set(HARD);
const bank = new Set(SOLUTIONS);

test.describe('difficulty settings', () => {
  test('tier data: three disjoint bands of the required size inside the bank', () => {
    expect(EASY.length).toBeGreaterThanOrEqual(1000);
    expect(MEDIUM.length).toBeGreaterThanOrEqual(1000);
    expect(HARD.length).toBeGreaterThanOrEqual(1000);
    expect(SOLUTIONS.length).toBeGreaterThanOrEqual(13000);
    const all = [...EASY, ...MEDIUM, ...HARD];
    expect(new Set(all).size).toBe(all.length); // disjoint
    expect(all.every((w) => bank.has(w))).toBe(true);
  });

  test('classic ramp: easy -> medium -> hard across the match', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'RAMPY', { ...FAST, mode: 'classic', words: 3, difficulty: 'ramp' });
    const guest = await openPage(context);
    await joinGame(guest, code, 'CLIMB');
    await host.waitForFunction(() => window.__friendle.state().players.length === 2);
    await startGame(host, [host, guest]);

    const expectTier = [null, easySet, medSet, hardSet];
    for (let no = 1; no <= 3; no++) {
      await waitRound(host, no);
      const w = await secret(host);
      expect(expectTier[no].has(w)).toBe(true);
      // the tier is announced to every client and shown in the header
      const tierName = ['', 'easy', 'medium', 'hard'][no];
      expect((await state(guest)).round.tier).toBe(tierName);
      await expect(host.locator('#hdr-round')).toContainText(tierName.toUpperCase());
      await Promise.all([waitUnlocked(host), waitUnlocked(guest)]);
      await guessWait(host, w);
      await guessWait(guest, w);
      if (no < 3) await waitReveal(host, no);
    }
  });

  test('royale fixed hard + standard ignores tiers', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    const code = await hostGame(host, 'HARDY', { ...FAST, mode: 'royale', ante: 25, difficulty: 'hard' });
    const guest = await openPage(context);
    await joinGame(guest, code, 'OUCH');
    await host.waitForFunction(() => window.__friendle.state().players.length === 2);
    await startGame(host, [host, guest]);

    for (let no = 1; no <= 2; no++) {
      await waitRound(host, no);
      const w = await secret(host);
      expect(hardSet.has(w)).toBe(true);
      expect((await state(guest)).round.tier).toBe('hard');
      await waitUnlocked(host);
      await guessWait(host, w);
      await waitReveal(host, no);
    }

    // standard: a fresh room where tier is null and the word just comes from
    // the bank (difficulty classifications ignored)
    const h2 = await openPage(context);
    const code2 = await hostGame(h2, 'PLAIN', { ...FAST, mode: 'classic', words: 1, difficulty: 'standard' });
    const g2 = await openPage(context);
    await joinGame(g2, code2, 'VANIL');
    await h2.waitForFunction(() => window.__friendle.state().players.length === 2);
    await startGame(h2, [h2, g2]);
    await waitRound(h2, 1);
    const w = await secret(h2);
    expect(bank.has(w)).toBe(true);
    expect((await state(g2)).round.tier).toBeNull();
    await expect(h2.locator('#hdr-round')).not.toContainText('·');
  });
});
