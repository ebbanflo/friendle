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

  // ---------- setter spectator view: letters + reactions ----------
  await waitUnlocked(pA);
  await guessWait(pA, 'crane');

  // the setter sees A's ACTUAL letters, live...
  await host.waitForFunction((a) => {
    const st = window.__friendle.state();
    return st.round?.grids[a]?.[0]?.word === 'crane';
  }, aId, { polling: 100 });
  await expect(host.locator(`[data-testid="opp-${aId}-0-0"]`)).toHaveText('C');
  // ...their own board folds away in favor of the big rival grids
  await expect(host.locator('#board')).toBeHidden();
  await expect(host.locator('#opponents')).toHaveClass(/setter-view/);

  // rival B still gets colors only - they're competing
  await pB.waitForFunction((a) => {
    const st = window.__friendle.state();
    return (st.round?.grids[a] || []).length === 1;
  }, aId, { polling: 100 });
  expect((await state(pB)).round.grids[aId][0].word).toBeUndefined();
  await expect(pB.locator(`[data-testid="opp-${aId}-0-0"]`)).toHaveText('');

  // heckle bar shows for the setter only
  await expect(host.locator(`[data-react-for="${aId}"]`)).toBeVisible();
  await expect(pB.locator(`[data-react-for="${aId}"]`)).toBeHidden();

  // setter fires two emoji back-to-back: the first lands everywhere, the
  // second dies on the host's spam brake
  await host.evaluate((a) => {
    window.__friendle.react('\u{1F525}', a);
    window.__friendle.react('\u{1F480}', a);
  }, aId);
  for (const p of [host, pA, pB]) {
    await p.waitForFunction(() => window.__friendle.state().reactions.length >= 1, null, { polling: 100 });
  }
  await pB.waitForTimeout(300);
  const rxs = (await state(pB)).reactions;
  expect(rxs).toHaveLength(1);
  expect(rxs[0].emoji).toBe('\u{1F525}');
  expect(rxs[0].target).toBe(aId);
  expect(rxs[0].from).toBe(hostId);

  // a competing guesser cannot react (mirror refuses, host would too)
  expect(await pB.evaluate((a) => window.__friendle.react('\u{1F525}', a), aId)).toBe(false);

  // A solves; B fails -> A scores, setter does not
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

  // rotation carries the perks: ANNA (this word's setter) saw B's letters,
  // while host - a competing guesser - saw B's colors only
  const aView = await state(pA);
  expect(aView.round.grids[bId][0].word).toBe('crane'); // first wrongWords entry
  expect(s.round.grids[bId][0].word).toBeUndefined();
  expect(s.round.grids[hostId].every((r) => /^[gyx]{5}$/.test(r.colors))).toBe(true);

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
