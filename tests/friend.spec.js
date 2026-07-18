import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, waitUnlocked, waitRound,
  waitReveal, waitGameOver, guessWait, failWord, wrongWords, wireLog, FAST,
} from './helpers.js';

test('friend mode: typed secrets, letter-vision, fewest-guess scoring, per-stump setter points', async ({ context }) => {
  test.setTimeout(90000);
  const host = await openPage(context);
  // "1 word" = one word EACH as setter -> 3 players = 3 rounds total
  const code = await hostGame(host, 'HOSTE', { ...FAST, mode: 'friend', words: 1 });
  const pA = await openPage(context);
  await joinGame(pA, code, 'ANNA');
  const pB = await openPage(context);
  await joinGame(pB, code, 'BORIS');
  await host.waitForFunction(() => window.__friendle.state().players.length === 3);
  const [hostId, aId, bId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));

  await startGame(host, [host, pA, pB]);

  // ---------- word 1: host sets; solver gains letter-vision ----------
  await host.waitForFunction(() => window.__friendle.state().round?.phase === 'set');
  let s = await state(host);
  expect(s.round.setterId).toBe(hostId);
  await expect(host.locator('#setter-panel')).toBeVisible();
  await expect(pA.locator('#setter-banner')).toContainText('HOSTE');

  // an invalid word is bounced by the dictionary
  await host.evaluate(() => window.__friendle.guess('zzzzz'));
  await expect(host.locator('#toast')).toContainText('dictionary');
  expect((await state(host)).round.phase).toBe('set');

  await host.evaluate(() => window.__friendle.guess('gloom'));
  await waitRound(pA, 1);

  // 1-each x 3 players = 3 total, shown in the header
  expect((await state(pA)).round.total).toBe(3);
  await expect(pA.locator('#hdr-round')).toContainText('WORD 1/3');
  await expect(pA.locator('#shop')).toBeHidden(); // no shop in FRIEND

  // the typed secret never appears in plaintext on the wire before reveal
  for (const line of await wireLog(pB)) {
    const env = JSON.parse(line);
    if (env.t !== 'reveal') expect(line).not.toContain('gloom');
  }

  await Promise.all([waitUnlocked(pA), waitUnlocked(pB)]);
  await guessWait(pA, 'crane');

  // the setter sees A's actual letters live; rival B sees colors only
  await host.waitForFunction((a) => {
    const st = window.__friendle.state();
    return st.round?.grids[a]?.[0]?.word === 'crane';
  }, aId, { polling: 100 });
  await expect(host.locator(`[data-testid="opp-${aId}-0-0"]`)).toHaveText('C');
  await expect(host.locator('#board')).toBeHidden();
  await pB.waitForFunction((a) => (window.__friendle.state().round?.grids[a] || []).length === 1, aId, { polling: 100 });
  expect((await state(pB)).round.grids[aId][0].word).toBeUndefined();
  await expect(pB.locator(`[data-testid="opp-${aId}-0-0"]`)).toHaveText('');

  // heckle bar: setter only; brain emoji present; spam brake; guessers can't
  await expect(host.locator(`[data-react-for="${aId}"]`)).toBeVisible();
  await expect(host.locator(`[data-testid="react-${aId}-\u{1F9E0}"]`)).toBeVisible();
  await expect(pB.locator(`[data-react-for="${aId}"]`)).toBeHidden();
  await host.evaluate((a) => {
    window.__friendle.react('\u{1F9E0}', a);
    window.__friendle.react('\u{1F480}', a);
  }, aId);
  for (const p of [host, pA, pB]) {
    await p.waitForFunction(() => window.__friendle.state().reactions.length >= 1, null, { polling: 100 });
  }
  await pB.waitForTimeout(300);
  const rxs = (await state(pB)).reactions;
  expect(rxs).toHaveLength(1);
  expect(rxs[0].emoji).toBe('\u{1F9E0}');
  expect(await pB.evaluate((a) => window.__friendle.react('\u{1F525}', a), aId)).toBe(false);

  // B solves (1 row) -> B earns letter-vision over A's ongoing grid
  await guessWait(pB, 'gloom');
  await guessWait(pA, 'slimy');
  await pB.waitForFunction((a) => {
    const st = window.__friendle.state();
    const g = st.round?.grids[a] || [];
    return g[0]?.word === 'crane' && g[1]?.word === 'slimy'; // backfill + live feed
  }, aId, { polling: 100 });
  await expect(pB.locator(`[data-testid="opp-${aId}-1-0"]`)).toHaveText('S');
  // ...but A, still competing, gets nothing about B's letters
  expect((await state(pA)).round.grids[bId][0].word).toBeUndefined();

  // A fails out -> reveal: B wins (only solver), setter scores 1 stump
  await failWord(pA, 'gloom');
  await waitReveal(pA, 1);
  s = await state(pA);
  expect(s.lastReveal.word).toBe('gloom');
  expect(s.lastReveal.winner).toBe(bId);
  expect(s.lastReveal.deltas[bId]).toBe(200);   // solved in 1 row: 100 + 5*20
  expect(s.lastReveal.deltas[aId]).toBeUndefined();
  expect(s.lastReveal.deltas[hostId]).toBe(100); // one stumped guesser

  // ---------- word 2: rotates to ANNA; fewest guesses beats fastest ----------
  await pA.waitForFunction(() => window.__friendle.state().round?.phase === 'set'
    && window.__friendle.state().round?.no === 2);
  expect((await state(pA)).round.setterId).toBe(aId);
  await pA.evaluate(() => window.__friendle.guess('crypt'));
  await waitRound(host, 2);
  await Promise.all([waitUnlocked(host), waitUnlocked(pB)]);

  // host burns 5 guesses then solves FIRST in time (6 rows total)...
  for (const w of wrongWords('crypt', 5)) await guessWait(host, w);
  await guessWait(host, 'crypt');
  // ...then B solves later but in a single row -> B outranks host
  await guessWait(pB, 'crypt');
  await waitReveal(pB, 2);
  s = await state(pB);
  expect(s.lastReveal.winner).toBe(bId);
  expect(s.lastReveal.deltas[bId]).toBe(200);  // 1 row
  expect(s.lastReveal.deltas[hostId]).toBe(100); // 6 rows, no late-cut in FRIEND
  expect(s.lastReveal.deltas[aId]).toBeUndefined(); // nobody stumped

  // ---------- word 3: rotates to BORIS; total stump pays per player ----------
  await pB.waitForFunction(() => window.__friendle.state().round?.phase === 'set'
    && window.__friendle.state().round?.no === 3);
  expect((await state(pB)).round.setterId).toBe(bId);
  await pB.evaluate(() => window.__friendle.guess('spore'));
  await waitRound(host, 3);
  await Promise.all([
    waitUnlocked(host).then(() => failWord(host, 'spore')),
    waitUnlocked(pA).then(() => failWord(pA, 'spore')),
  ]);
  await waitReveal(host, 3);
  s = await state(host);
  expect(s.lastReveal.winner).toBeNull();
  expect(s.lastReveal.deltas[bId]).toBe(200); // two stumped guessers x 100

  // ---------- game over after 3 rounds (1 per setter) ----------
  await waitGameOver(pA);
  s = await state(pA);
  expect(s.gameover.winner).toBe(bId); // BORIS: 200 + 200 + 200
  expect(s.gameover.standings[0].score).toBe(600);
});
