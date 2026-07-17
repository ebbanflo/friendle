import { test, expect } from '@playwright/test';
import {
  openPage, hostGame, joinGame, startGame, state, engineState, secret,
  duelSecret, setScore, buy, waitUnlocked, waitRound, waitReveal, waitGameOver,
  guessWait, failWord, FAST,
} from './helpers.js';

test('royale: ante, rolling pot, duel, elimination, last one standing', async ({ context }) => {
  test.setTimeout(120000);
  const host = await openPage(context);
  const code = await hostGame(host, 'HOSS', { ...FAST, mode: 'royale', ante: 100 });
  const pA = await openPage(context);
  await joinGame(pA, code, 'AAAA');
  const pB = await openPage(context);
  await joinGame(pB, code, 'BBBB');
  await host.waitForFunction(() => window.__friendle.state().players.length === 3);
  const [hostId, aId, bId] = await host.evaluate(() =>
    window.__friendle.state().players.map((p) => p.id));
  const all = [host, pA, pB];

  await startGame(host, all);

  // ---------- word 1: everyone antes 100; nobody solves; pot rolls ----------
  await waitRound(host, 1);
  let es = await engineState(host);
  expect(es.pot).toBe(300);
  expect(es.players.map((p) => p.score)).toEqual([900, 900, 900]);

  const w1 = await secret(host);
  for (const p of all) await waitUnlocked(p);
  await Promise.all(all.map((p) => failWord(p, w1)));
  await waitReveal(pB, 1);
  let s = await state(pB);
  expect(s.lastReveal.winner).toBeNull();
  expect(s.lastReveal.pot).toBe(300); // rolled over

  // ---------- word 2: pot grows to 600; A takes it all ----------
  await waitRound(pA, 2);
  es = await engineState(host);
  expect(es.pot).toBe(600);
  await waitUnlocked(pA);
  const w2 = await secret(host);
  await guessWait(pA, w2);
  await waitReveal(pA, 2);
  s = await state(pA);
  expect(s.lastReveal.winner).toBe(aId);
  expect(s.lastReveal.deltas[aId]).toBe(600);
  expect(s.players.find((p) => p.id === aId).score).toBe(1400); // 800 + 600
  expect(s.lastReveal.pot).toBe(0);

  // ---------- word 3: A duels B for 200 mid-word ----------
  await waitRound(host, 3);
  await waitUnlocked(pA);
  const scoresBefore = Object.fromEntries((await engineState(host)).players.map((p) => [p.id, p.score]));
  await buy(pA, 'duel', bId, 200);
  await pB.waitForFunction(() => {
    const st = window.__friendle.state();
    return st.duel && !st.duel.over;
  });
  s = await state(pB);
  expect(s.duel.a).toBe(aId);
  expect(s.duel.stake).toBe(200);
  expect(s.round.suspended).toBe(true);
  // suspended word rejects guesses (host-side too)
  expect(await pB.evaluate(() => window.__friendle.guess('crane'))).toBe(false);

  const dw = await duelSecret(host);
  // alternate: A wrong, B wrong, A solves
  const wrong = ['pouty', 'slimy', 'crane'].filter((w) => w !== dw).slice(0, 2);
  await pA.evaluate((w) => window.__friendle.guess(w), wrong[0]);
  await pB.waitForFunction((me) => window.__friendle.state().duel?.turn === me, bId);
  await pB.evaluate((w) => window.__friendle.guess(w), wrong[1]);
  await pA.waitForFunction((me) => window.__friendle.state().duel?.turn === me, aId);
  await pA.evaluate((w) => window.__friendle.guess(w), dw);

  // spectator (host) watched the duel WITH letters - it's a public spectacle
  await host.waitForFunction(() => !!window.__friendle.state().lastDuel, null, { polling: 100 });
  s = await state(host);
  expect(s.lastDuel.rows[0].word).toBe(wrong[0]);
  expect(s.lastDuel.rows[2].word).toBe(dw);
  expect(s.lastDuel.rows[2].solved).toBe(true);
  expect(s.lastDuel.result.winner).toBe(aId);

  // stake settled: A +200, B -200
  await host.waitForFunction(([a, b, sb]) => {
    const st = window.__friendle.engineState();
    const A = st.players.find((p) => p.id === a).score;
    const B = st.players.find((p) => p.id === b).score;
    return A === sb[a] + 200 && B === sb[b] - 200;
  }, [aId, bId, scoresBefore]);

  // the word resumes after the duel and can still be won
  await host.waitForFunction(() => {
    const st = window.__friendle.state();
    return st.round && st.round.suspended === false;
  });
  const w3 = await secret(host);
  await waitUnlocked(host);
  await guessWait(host, w3);
  await waitReveal(host, 3);
  s = await state(host);
  expect(s.lastReveal.winner).toBe(hostId);

  // ---------- eliminations: hit 0 at reveal = out ----------
  await waitRound(host, 4);
  await setScore(host, bId, 60); // B can't cover the next ante fully
  await waitUnlocked(host);
  const w4 = await secret(host);
  await guessWait(host, w4); // host wins the pot; B stays at 0
  await waitReveal(pB, 4);

  // word 4's ante was taken before setScore, so B still had 60 at reveal 4;
  // word 5's ante drains B to exactly 0 -> eliminated at reveal 5
  await waitRound(host, 5);
  es = await engineState(host);
  const bNow = es.players.find((p) => p.id === bId);
  expect(bNow.score).toBe(0); // 60 - min(100,60) = 0 after ante
  await waitUnlocked(host);
  const w5 = await secret(host);
  await guessWait(host, w5);
  await waitReveal(host, 5);
  s = await state(host);
  expect(s.lastReveal.eliminated).toContain(bId);
  await pB.waitForFunction(() => window.__friendle.state().players.find(
    (p) => p.id === window.__friendle.selfId).spectator);
  expect(await pB.evaluate(() => window.__friendle.state().inputLocked)).toBeTruthy();

  // ---------- finish him: A busts, host is last standing ----------
  await waitRound(host, 6);
  await setScore(host, aId, 10);
  await waitUnlocked(host);
  const w6 = await secret(host);
  await guessWait(host, w6);
  await waitReveal(host, 6);

  await waitRound(host, 7);
  await waitUnlocked(host);
  const w7 = await secret(host);
  await guessWait(host, w7);

  await waitGameOver(host);
  await waitGameOver(pA);
  s = await state(pA);
  expect(s.gameover.winner).toBe(hostId);
  expect(s.gameover.reason).toBe('last one standing');
  await pA.waitForSelector('#scr-over:not(.hidden)');
});
