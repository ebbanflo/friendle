import { test, expect } from '@playwright/test';
import { GUESSES } from '../data/guesses.js';
import { matchesConstraint, genConstraint, countPossible, wordPoints } from '../js/tower.js';
import {
  openPage, hostGame, joinGame, startGame, state, engineState, setScore, buy, FAST,
} from './helpers.js';

// find dictionary words satisfying a decree, skipping anything already used
function findWords(constraint, used, n) {
  const out = [];
  const usedSet = new Set(used);
  for (const w of GUESSES) {
    if (!usedSet.has(w) && matchesConstraint(w, constraint)) {
      out.push(w);
      if (out.length === n) break;
    }
  }
  return out;
}
function findNonMatching(constraint, used) {
  const usedSet = new Set(used);
  return GUESSES.find((w) => !usedSet.has(w) && !matchesConstraint(w, constraint));
}

const towerState = (page) => page.evaluate(() => window.__friendle.state().tower);
const usedWords = (page) => page.evaluate(() => window.__friendle.state().tower.rows.map((r) => r.word));

async function climb(page, word) {
  const before = (await towerState(page)).height;
  await page.evaluate((w) => window.__friendle.guess(w), word);
  await page.waitForFunction((h) => window.__friendle.state().tower?.height === h + 1, before, { polling: 50 });
}
async function miss(page, word) {
  const lives = await page.evaluate(() => window.__friendle.state().tower.lives[window.__friendle.selfId]);
  await page.evaluate((w) => window.__friendle.guess(w), word);
  await page.waitForFunction((n) => {
    const st = window.__friendle.state();
    return st.tower?.lives[st.selfId] === n - 1;
  }, lives, { polling: 50 });
}

test.describe('tower mode', () => {
  test('decree generator: every stage is survivable and matching is sound', () => {
    expect(matchesConstraint('crane', { req: ['c', 'e'] })).toBe(true);
    expect(matchesConstraint('crane', { req: ['z'] })).toBe(false);
    expect(matchesConstraint('crane', { reqAt: [{ i: 1, ch: 'r' }] })).toBe(true);
    expect(matchesConstraint('crane', { reqAt: [{ i: 0, ch: 'r' }] })).toBe(false);
    expect(matchesConstraint('crane', { ban: ['z', 'q'] })).toBe(true);
    expect(matchesConstraint('crane', { ban: ['a'] })).toBe(false);
    expect(matchesConstraint('nymph', { ban: ['a', 'e', 'i', 'o', 'u'] })).toBe(true); // no-vowels tier is real
    const used = new Set();
    for (let stage = 1; stage <= 12; stage++) {
      for (let k = 0; k < 5; k++) {
        const c = genConstraint(stage, used);
        expect(countPossible(c, used)).toBeGreaterThanOrEqual(4);
      }
    }
    // RPG numbers scale with stage and combo
    expect(wordPoints('crane', 2, 1)).toBeGreaterThan(wordPoints('crane', 1, 1));
    expect(wordPoints('crane', 1, 5)).toBeGreaterThan(wordPoints('crane', 1, 1));
  });

  test('solo climb: decree, stage ramp, misses cost lives, the tower falls', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    await hostGame(host, 'MASON', {
      ...FAST, mode: 'tower', rampWords: 2, hungerMs: 600000,
    });
    // solo start is allowed in TOWER
    await expect(host.locator('#btn-start')).toBeEnabled();
    await host.click('#btn-start');
    await host.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });

    let t = await towerState(host);
    expect(t.stage).toBe(1);
    expect(t.height).toBe(0);
    expect(t.lives[await host.evaluate(() => window.__friendle.selfId)]).toBe(3);
    await expect(host.locator('#tower-panel')).toBeVisible();
    await expect(host.locator('#decree')).not.toHaveText('');

    // word 1 through the real keyboard
    const [w1] = findWords(t.constraint, [], 1);
    for (const ch of w1) await host.click(`[data-testid="key-${ch}"]`);
    await expect(host.locator('[data-testid="twr-in-0"]')).toHaveText(w1[0].toUpperCase());
    await host.click('[data-testid="key-enter"]');
    await host.waitForFunction(() => window.__friendle.state().tower.height === 1, null, { polling: 100 });
    t = await towerState(host);
    expect(t.rows[0].word).toBe(w1);
    expect(t.rows[0].points).toBe(wordPoints(w1, 1, 1));
    const hostId = await host.evaluate(() => window.__friendle.selfId);
    expect((await state(host)).players.find((p) => p.id === hostId).score).toBe(wordPoints(w1, 1, 1));
    await expect(host.locator('#team-score')).toContainText(wordPoints(w1, 1, 1).toLocaleString('en-US'));

    // word 2 -> rampWords=2 reached -> stage 2, decree changes
    const [w2] = findWords(t.constraint, [w1], 1);
    await climb(host, w2);
    await host.waitForFunction(() => window.__friendle.state().tower.stage === 2, null, { polling: 100 });

    // misses: not-a-word, duplicate, decree-breaker - one life each
    await miss(host, 'zzzzz');
    await miss(host, w1); // already in the tower
    t = await towerState(host);
    const breaker = findNonMatching(t.constraint, [w1, w2]);
    await miss(host, breaker); // life 3 gone -> solo team downed -> the tower falls
    await host.waitForFunction(() => window.__friendle.state().over, null, { polling: 100 });
    const over = (await state(host)).gameover;
    expect(over.reason).toBe('the tower fell');
    expect(over.height).toBe(2);
    await host.waitForSelector('#scr-over:not(.hidden)');
    await expect(host.locator('#over-title')).toContainText('HEIGHT 2');
  });

  test('co-op: downed teammate, revive wordle, hunger bleeds everyone', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    const code = await hostGame(host, 'CLERIC', {
      ...FAST, mode: 'tower', rampWords: 50, hungerMs: 600000,
    });
    const pA = await openPage(context);
    await joinGame(pA, code, 'FALLEN');
    await host.waitForFunction(() => window.__friendle.state().players.length === 2);
    const [hostId, aId] = await host.evaluate(() =>
      window.__friendle.state().players.map((p) => p.id));
    await startGame(host, [host, pA]);
    await host.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    await pA.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });

    // A flames out: three bad words
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await miss(pA, 'jjjjj');
    await pA.waitForFunction(() => window.__friendle.state().inputLocked, null, { polling: 100 });
    await expect(host.locator(`[data-testid="lives-${aId}"]`)).toHaveText('\u{1F480}');
    expect(await pA.evaluate(() => window.__friendle.guess('crane'))).toBe(false);

    // host keeps climbing (solo now), then buys a revive through the UI
    let t = await towerState(host);
    const [w1] = findWords(t.constraint, [], 1);
    await climb(host, w1);
    await setScore(host, hostId, 50000);
    await host.click('[data-testid="shop-revive"]');
    await host.click(`[data-testid="pick-${aId}"]`);
    await host.click('#btn-picker-go');
    await host.waitForFunction(() => !!window.__friendle.state().tower.revives[window.__friendle.selfId], null, { polling: 100 });
    expect((await state(host)).players.find((p) => p.id === hostId).score).toBe(45000);

    // the rescue wordle: one wrong guess (visible to the fallen teammate), then the solve
    const secret = await host.evaluate((pid) => window.__friendle.reviveSecret(pid), hostId);
    expect(secret).toMatch(/^[a-z]{5}$/);
    const wrong = ['crane', 'slimy', 'pouty'].find((w) => w !== secret);
    await host.evaluate((w) => window.__friendle.guess(w), wrong);
    await pA.waitForFunction((h) => {
      const rev = window.__friendle.state().tower.revives[h];
      return rev && rev.rows.length === 1;
    }, hostId, { polling: 100 });
    await expect(pA.locator('[data-testid="rev-0-0"]')).toHaveText(wrong[0].toUpperCase());
    await host.evaluate((w) => window.__friendle.guess(w), secret);
    await pA.waitForFunction((a) => window.__friendle.state().tower.lives[a] === 2, aId, { polling: 100 });
    await pA.waitForFunction(() => !window.__friendle.state().inputLocked, null, { polling: 100 });

    // the revived player can climb again
    t = await towerState(pA);
    const [w2] = findWords(t.constraint, await usedWords(pA), 1);
    await climb(pA, w2);

    // hunger: silence bleeds every living player
    await host.evaluate(() => { window.__friendle.engine.tower.hungerMs = 900; });
    t = await towerState(host);
    const [w3] = findWords(t.constraint, await usedWords(host), 1);
    await climb(host, w3); // re-arms the hunger clock at 900ms
    await host.waitForFunction(([h, a]) => {
      const lv = window.__friendle.state().tower.lives;
      return lv[h] === 2 && lv[a] === 1;
    }, [hostId, aId], { polling: 100 });

    // everyone falls -> game over with the final height
    await miss(host, 'zzzzz');
    await miss(host, 'qqqqq'); // host down
    await miss(pA, 'zzzzz');   // A down -> all down
    await pA.waitForFunction(() => window.__friendle.state().over, null, { polling: 100 });
    const over = (await state(pA)).gameover;
    expect(over.reason).toBe('the tower fell');
    expect(over.height).toBe(3);
  });

  test('bonus hearts: every 10th floor revives a downed teammate; capped at max', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    const code = await hostGame(host, 'PRIEST', {
      ...FAST, mode: 'tower', rampWords: 999, hungerMs: 600000,
    });
    const pA = await openPage(context);
    await joinGame(pA, code, 'DOWNED');
    await host.waitForFunction(() => window.__friendle.state().players.length === 2);
    const aId = await pA.evaluate(() => window.__friendle.selfId);
    await startGame(host, [host, pA]);
    await host.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    await pA.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });

    // no decree noise: any distinct dictionary word is acceptable
    await host.evaluate(() => { window.__friendle.engine.tower.constraint = {}; });

    // A flames out completely (3 misses) while the tower keeps climbing
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await miss(pA, 'jjjjj');
    await pA.waitForFunction(() => window.__friendle.state().inputLocked, null, { polling: 100 });
    expect((await towerState(host)).lives[aId]).toBe(0);

    // host climbs 10 distinct words alone -> height-10 milestone fires
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 30);
    let placed = 0;
    for (const w of words) {
      if (placed >= 10) break;
      const used = new Set(await usedWords(host));
      if (used.has(w)) continue;
      await climb(host, w);
      placed += 1;
    }
    expect(placed).toBe(10);

    await host.waitForFunction(() => window.__friendle.state().tower.height === 10, null, { polling: 100 });
    // the milestone revived the downed teammate...
    await pA.waitForFunction((id) => window.__friendle.state().tower.lives[id] === 1, aId, { polling: 100 });
    await pA.waitForFunction(() => !window.__friendle.state().inputLocked, null, { polling: 100 });
    // ...and the host (who never lost a life) gained one too, capped by maxLives
    const hostId = await host.evaluate(() => window.__friendle.selfId);
    let t = await towerState(host);
    expect(t.lives[hostId]).toBe(4); // 3 start + 1 milestone
    expect(t.lives[aId]).toBe(1);    // 0 -> revived to 1

    // grind to height 50 (5 milestones) to prove the cap holds
    const usedSoFar = new Set(await usedWords(host));
    const more = GUESSES.filter((w) => /^[a-z]{5}$/.test(w) && !usedSoFar.has(w)).slice(0, 60);
    let extra = 0;
    for (const w of more) {
      if (host && (await towerState(host)).height >= 50) break;
      const used = new Set(await usedWords(host));
      if (used.has(w)) continue;
      await climb(host, w);
      extra += 1;
      if (extra > 45) break; // safety valve
    }
    t = await towerState(host);
    expect(t.height).toBeGreaterThanOrEqual(50);
    expect(t.lives[hostId]).toBe(5); // capped at maxLives, not 8
  });

  test('the tower blessing: spelling TOWER down a column grants a bonus heart', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'BARD', {
      ...FAST, mode: 'tower', rampWords: 999, hungerMs: 600000,
    });
    await host.click('#btn-start');
    await host.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    const hostId = await host.evaluate(() => window.__friendle.selfId);

    // clear the decree so any word starting with the target letter qualifies
    await host.evaluate(() => { window.__friendle.engine.tower.constraint = {}; });

    // five real words whose FIRST letters spell T-O-W-E-R down the column
    const wordStartingWith = (ch) => GUESSES.find((w) => /^[a-z]{5}$/.test(w) && w[0] === ch);
    const towerWords = ['t', 'o', 'w', 'e', 'r'].map(wordStartingWith);
    expect(towerWords.every(Boolean)).toBe(true);
    expect(new Set(towerWords).size).toBe(5); // distinct starting letters => distinct words

    for (const w of towerWords.slice(0, 4)) await climb(host, w);
    let t = await towerState(host);
    const before = t.lives[hostId];
    expect(t.height).toBe(4); // not a height-10 milestone - isolates the easter egg

    await climb(host, towerWords[4]);
    await host.waitForFunction((b) => window.__friendle.state().tower.lives[window.__friendle.selfId] === b + 1, before, { polling: 100 });
    t = await towerState(host);
    expect(t.height).toBe(5);
    expect(t.lives[hostId]).toBe(before + 1);
    await expect(host.locator('#toast')).toContainText('T-O-W-E-R');
  });

  test('revive pauses the shared hunger clock; a bystander can keep climbing; resumes fresh after', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    const code = await hostGame(host, 'MONK', {
      ...FAST, mode: 'tower', rampWords: 999, hungerMs: 900,
    });
    const pA = await openPage(context); // will go down, gets revived
    await joinGame(pA, code, 'CASTER');
    const pB = await openPage(context); // bystander: neither reviving nor downed
    await joinGame(pB, code, 'ROGUE');
    await host.waitForFunction(() => window.__friendle.state().players.length === 3);
    const hostId = await host.evaluate(() => window.__friendle.selfId);
    const aId = await pA.evaluate(() => window.__friendle.selfId);
    await startGame(host, [host, pA, pB]);
    await host.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    await pA.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    await pB.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    await host.evaluate(() => { window.__friendle.engine.tower.constraint = {}; });

    // A goes down; host and B stay up
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await miss(pA, 'jjjjj');
    await pA.waitForFunction(() => window.__friendle.state().inputLocked, null, { polling: 100 });

    await setScore(host, hostId, 50000);
    await host.click('[data-testid="shop-revive"]');
    await host.click(`[data-testid="pick-${aId}"]`);
    await host.click('#btn-picker-go');
    await host.waitForFunction(() => !!window.__friendle.state().tower.revives[window.__friendle.selfId], null, { polling: 100 });
    expect((await towerState(host)).hungerPaused).toBe(true);
    await expect(host.locator('#hunger-label')).toBeVisible();
    await pB.waitForFunction(() => window.__friendle.state().tower.hungerPaused, null, { polling: 100 });

    // sit well past hungerMs (900ms) WITHOUT finishing the revive - nobody should bleed
    const livesBefore = (await towerState(host)).lives;
    await host.waitForTimeout(1800);
    expect((await towerState(host)).lives).toEqual(livesBefore); // the clock never fired while paused

    // a completely uninvolved bystander can still climb normally mid-pause
    const bystanderWord = GUESSES.find((w) => /^[a-z]{5}$/.test(w) && !w.startsWith('a'));
    await climb(pB, bystanderWord);
    expect((await towerState(pB)).height).toBe(1);

    // now solve the revive
    const secret = await host.evaluate((pid) => window.__friendle.reviveSecret(pid), hostId);
    await host.evaluate((w) => window.__friendle.guess(w), secret);
    await pA.waitForFunction((id) => window.__friendle.state().tower.lives[id] === 2, aId, { polling: 100 });
    await host.waitForFunction(() => !window.__friendle.state().tower.hungerPaused, null, { polling: 100 });
    await expect(host.locator('#hunger-label')).toBeHidden();

    // the clock resumed fresh: waiting past hungerMs again now DOES bleed
    await host.waitForFunction(([h, a, b]) => {
      const lv = window.__friendle.state().tower.lives;
      return lv[h] < 3 || lv[a] < 2 || lv[b] < 3; // someone bled after resume
    }, [hostId, aId, await pB.evaluate(() => window.__friendle.selfId)], { polling: 100, timeout: 15000 });
  });

  test('lobby DECREE slider: host drags it, 2-10 range, live-syncs to guests, drives real pacing', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'DEALER', FAST);
    const guest = await openPage(context);
    await joinGame(guest, code, 'WATCH');
    await host.waitForFunction(() => window.__friendle.state().players.length === 2);

    // switch to TOWER: the old EASY/MED/HARD/STD/RAMP row disappears,
    // the DECREE slider appears instead, defaulted mid-range
    await host.evaluate(() => window.__friendle.setSettings({ mode: 'tower' }));
    await expect(host.locator('#set-diff')).toBeHidden();
    await expect(host.locator('#set-ramp')).toBeVisible();
    const range = host.locator('#ramp-range');
    await expect(range).toHaveAttribute('min', '2');
    await expect(range).toHaveAttribute('max', '10');
    expect(await range.inputValue()).toBe('5'); // TOWER.defaultRampWords

    // guest cannot drag it (not host) - reflected as disabled
    await expect(guest.locator('#ramp-range')).toBeDisabled();

    // host drags to 2 (the "easy" end, per the counterintuitive finding);
    // fill() on a range input fires input+change, matching real drag behavior
    await range.fill('2');
    await guest.waitForFunction(() => window.__friendle.state().settings?.rampWords === 2, null, { polling: 100 });
    expect(await guest.locator('#ramp-out').textContent()).toBe('2');

    // and it actually drives pacing: stage 2 arrives after just 2 words
    await startGame(host, [host, guest]);
    await host.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    await host.evaluate(() => { window.__friendle.engine.tower.constraint = {}; });
    expect((await host.evaluate(() => window.__friendle.engineState().tower)).rampWords).toBe(2);
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 5);
    await climb(host, words[0]);
    expect((await towerState(host)).stage).toBe(1);
    await climb(host, words[1]);
    await host.waitForFunction(() => window.__friendle.state().tower.stage === 2, null, { polling: 100 });
  });

  test('the visible stack caps at 10 floors and the keyboard never shifts', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'ANCHOR', {
      ...FAST, mode: 'tower', rampWords: 999, hungerMs: 600000,
    });
    await host.click('#btn-start');
    await host.waitForFunction(() => !!window.__friendle.state().tower, null, { polling: 100 });
    await host.evaluate(() => { window.__friendle.engine.tower.constraint = {}; });

    const keyboardY = () => host.locator('#keyboard').boundingBox().then((b) => b.y);
    const yEmpty = await keyboardY();

    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 20);
    for (let i = 0; i < 6; i++) await climb(host, words[i]);
    expect(await keyboardY()).toBe(yEmpty); // fixed footprint from the first word on

    for (let i = 6; i < 14; i++) await climb(host, words[i]);
    expect(await keyboardY()).toBe(yEmpty); // still identical well past the cap

    // exactly 10 rows on screen, and they're the 10 MOST RECENT (5..14, not 1..10)
    const rows = host.locator('.tower-row');
    await expect(rows).toHaveCount(10);
    const cellsOf = async (loc) => (await loc.locator('.tower-cell').allTextContents()).join('').toLowerCase();
    expect(await cellsOf(rows.first())).toBe(words[13]); // newest on top
    expect(await cellsOf(rows.last())).toBe(words[4]);   // oldest still visible
    // word 0 (the very first floor placed) has scrolled off the visible window
    for (let i = 0; i < 10; i++) expect(await cellsOf(rows.nth(i))).not.toBe(words[0]);
    // but it's still real height/score, just not rendered
    expect((await towerState(host)).height).toBe(14);
  });
});
