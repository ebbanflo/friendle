import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, waitUnlocked, waitRound,
  waitReveal, waitGameOver, guessWait, failWord, wireLog, FAST,
} from './helpers.js';

test('friend mode: typed secrets, private setter, rotation, stump-the-room scoring', async ({ context }) => {
  test.setTimeout(90000);
  const host = await openPage(context);
  const code = await hostGame(host, 'HOSTE', { ...FAST, mode: 'friend', words: 3 });
  const pA = await openPage(context);
  await joinGame(pA, code, 'ANNA');
  const pB = await openPage(context);
  await joinGame(pB, code, 'BORIS');
  await host.waitForFunction(() => window.__friendle.state().players.length === 3);
  const [hostId, aId, bId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));
  const pages = { [hostId]: host, [aId]: pA, [bId]: pB };

  await startGame(host, [host, pA, pB]);

  // ---------- word 1: host is the setter and types the secret ----------
  await host.waitForFunction(() => window.__friendle.state().round?.phase === 'set');
  let s = await state(host);
  expect(s.round.setterId).toBe(hostId);
  await expect(host.locator('#setter-panel')).toBeVisible();
  // guests see who is scheming, not the word
  await expect(pA.locator('#setter-banner')).toContainText('HOSTE');

  // an invalid word is bounced by the host's dictionary
  await host.evaluate(() => window.__friendle.guess('zzzzz'));
  await expect(host.locator('#toast')).toContainText('dictionary');
  s = await state(host);
  expect(s.round.phase).toBe('set');

  // a real word starts the round
  await host.evaluate(() => window.__friendle.guess('gloom'));
  await waitRound(pA, 1);

  // shop is a no-show in FRIEND mode
  await expect(pA.locator('#shop')).toBeHidden();

  // the typed secret never appears in plaintext on the wire before reveal
  for (const line of await wireLog(pB)) {
    const env = JSON.parse(line);
    if (env.t !== 'reveal') expect(line).not.toContain('gloom');
  }

  // A solves; B fails -> A scores, setter does not
  await waitUnlocked(pA);
  await guessWait(pA, 'gloom');
  await failWord(pB, 'gloom');
  await waitReveal(pB, 1);
  s = await state(pB);
  expect(s.lastReveal.word).toBe('gloom');
  expect(s.lastReveal.winner).toBe(aId);
  expect(s.lastReveal.deltas[aId]).toBeGreaterThan(0);
  expect(s.lastReveal.deltas[hostId]).toBeUndefined();

  // setter cannot guess their own word (input locked while others play)
  expect(await host.evaluate(() => window.__friendle.state().inputLocked)).toBeTruthy();

  // ---------- word 2: setter rotates to ANNA; nobody solves -> setter scores ----------
  await pA.waitForFunction(() => window.__friendle.state().round?.phase === 'set'
    && window.__friendle.state().round?.no === 2);
  s = await state(pA);
  expect(s.round.setterId).toBe(aId);
  await expect(pA.locator('#setter-panel')).toBeVisible();
  await pA.evaluate(() => window.__friendle.guess('crypt'));
  await waitRound(host, 2);
  await Promise.all([
    waitUnlocked(host).then(() => failWord(host, 'crypt')),
    waitUnlocked(pB).then(() => failWord(pB, 'crypt')),
  ]);
  await waitReveal(host, 2);
  s = await state(host);
  expect(s.lastReveal.winner).toBeNull();
  expect(s.lastReveal.deltas[aId]).toBe(150); // stumped the room

  // the setter watched color-only grids live
  expect(s.round.grids[hostId].every((r) => /^[gyx]{5}$/.test(r.colors))).toBe(true);
  const aView = await state(pA);
  expect(aView.round.grids[bId][0].word).toBeUndefined();

  // ---------- word 3: rotates to BORIS; A solves; then game over ----------
  await pB.waitForFunction(() => window.__friendle.state().round?.phase === 'set'
    && window.__friendle.state().round?.no === 3);
  s = await state(pB);
  expect(s.round.setterId).toBe(bId);
  await pB.evaluate(() => window.__friendle.guess('spore'));
  await waitRound(pA, 3);
  await waitUnlocked(pA);
  await guessWait(pA, 'spore');
  await host.evaluate(() => window.__friendle.guess('spore')); // host also solves late or in-grace
  await waitGameOver(host);
  await waitGameOver(pA);
  s = await state(pA);
  expect(s.gameover.standings[0].id).toBe(aId); // ANNA won two words
  expect(s.gameover.winner).toBe(aId);
});
