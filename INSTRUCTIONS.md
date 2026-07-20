# FRIENDLE — maintainer's guide

Everything a future contributor (human or model) needs to extend this game
without re-learning its traps. Player-facing docs are in [README.md](README.md).

## What this is

A fully static multiplayer word game: vanilla HTML/CSS/JS ES modules, **no
build step, no framework, no backend logic**. GitHub Pages serves it;
multiplayer rides on **Supabase Realtime broadcast + presence channels only**
— no database tables, no RLS, no auth, no edge functions. It shares a Supabase
project with a sibling game (HMMM?, channel prefix `hmmm:`); FRIENDLE's
channels are **always** prefixed `friendle:<ROOMCODE>`. Never use `hmmm:`.

```
index.html            single page, all screens/overlays
css/style.css         psychedelic-Wordle skin + reduced-motion fallback
js/config.js          every tunable: keys, prices, scoring, timings
js/protocol.js        THE event registry (see trap #1)
js/transport.js       SupabaseTransport, LocalTransport, Net envelope wrapper
js/engine.js          host-authoritative referee (host's browser only)
js/client.js          Mirror: state every peer renders from
js/ui.js              DOM rendering + input
js/audio.js           WebAudio-synthesized sfx (no audio files)
js/words.js           dictionary lookups, biased word picking, Wordle scoring
js/main.js            bootstrap, ?join= routing, ?debug=1 handle
data/solutions.js     ~10k answers, ordered commonest-first (generated)
data/guesses.js       ~14.8k valid guesses (generated)
tools/build-words.mjs regenerates the two files above
vendor/supabase.js    supabase-js v2 UMD build, vendored (no CDN at runtime)
tests/                Playwright E2E suite (LocalTransport only)
```

## Architecture

### Host-authoritative model

The **host's browser is the referee**. It alone:

- picks (or receives, in FRIEND mode) the secret words,
- validates every guess against the dictionary and game state,
- arbitrates who solved first — clients report their own elapsed ms and the
  host holds a **350 ms grace window** (`GRACE_MS`) after the first correct
  solve; when it closes, the smallest reported elapsed wins, so network lag
  never decides a photo finish,
- keeps all scores and pots and validates every power-up purchase.

Guests only send *intents* (`IN.*` in protocol.js) and mirror the host's
broadcasts (`EV.*`). If the host leaves, the room dies — by design.

### Wire format

Every message is one broadcast event named `game` carrying the envelope
`{t, from, d}` — `t` is the type from protocol.js, `from` the sender's peer id,
`d` the payload. **Transports never echo your own sends back**, so anything
that must also apply locally goes through `Net.emit()` = send + local
dispatch. The host's own guesses take the exact same path as guests' (its
mirror listens to its own engine's broadcasts), which keeps the two roles
honest.

Messages stay lean: color strings (`'gyxxg'`) and score deltas, never grids of
letters, never the secret — the single deliberate exception is `EV.RESYNC`,
the full snapshot a rejoining player receives.

### Transport interface

```js
await t.connect();      // resolves when joined; rejects if unreachable
t.send(payload);        // broadcast to all OTHER peers (no self-echo)
t.onMessage(cb);        // cb(payload) for peers' payloads
t.onPresence(cb);       // cb(Set<peerId>) of OTHER peers currently present
await t.leave();
```

- **SupabaseTransport** (production): one public channel per room
  (`friendle:<CODE>`), `broadcast: {self:false}`, presence keyed by peer id.
  A subscribe failure or 12 s timeout surfaces the friendly "server is
  napping" message (`ERR_NAPPING`) — that's what a paused Supabase project
  looks like from the client.
- **LocalTransport** (`?t=local`): BroadcastChannel plus an 800 ms heartbeat
  that doubles as presence (peers unseen for 2.6 s are gone). Same-origin tabs
  of one browser profile form a room. **All automated tests use this** — no
  network involved.

### Event protocol

Intents (player → host): `join, guess, secret, buy, dguess, quit, resyncreq`.

Host broadcasts: `lobby, joinerr, start, word, result, badguess, seterr,
timeup, reveal, scores, shoperr, freeze, hint, peek, smudge, duelstart,
duelrow, duelend, resume, left, gameover, roomdead, resync`.

Round lifecycle: `word{phase:'set'}` (FRIEND only) → `word{phase:'play'}` →
n × `result` (colors only) → `reveal` (word + deltas + eliminations) → next
`word` or `gameover`. Duels wedge in as `duelstart → duelrow* → duelend →
resume` with the word timer suspended.

### Game rules encoded in engine.js

- Scoring (Classic): first solver gets
  `100 + (6 - rowsUsed)*20 + speedBonus(0..50 fading over 60 s)`; later
  solvers get 40% of their own formula; a failed word scores 0.
- Scoring (FRIEND): ranked by FEWEST guesses, not time - every solver gets
  the full `100 + (6 - rowsUsed)*20` (no speed bonus, no late cut), so 3
  rows beats 6 regardless of clock order; ties go to the earlier solve. The
  setter earns `setterPerStump` (100) for EVERY guesser who fails the word.
  The words setting means words EACH as setter (total rounds = words x
  players, and `totalWords()` recomputes if someone leaves).
- Royale: everyone starts at 1000; each word every survivor antes
  `min(ante, score)` into the pot; first solver takes the whole pot; unsolved
  pots roll over. **Elimination check happens at reveal time** — a player at 0
  who wins the pot survives; one who doesn't spectates from then on. Last
  living player wins. Duels run in Classic AND Royale (FRIEND has no shop);
  stakes settle immediately; only in Royale does a loser who can't cover the
  stake bust out on the spot. Trap: anything typed during a duel renders into
  the DUEL grid — the `type` event must route to `renderDuel()`, not the main
  board (this shipped broken once: duelers typed blind).
- FRIEND: the setter's word travels setter → host in the `secret` intent,
  XOR+base64-obfuscated with the room code (`util.obf`). Guess words in
  `guess`/`dguess` intents and the setter's letter feed (`sletters`) use the
  same wrapper, so no guess or secret is casual network-tab reading. **This
  is obfuscation, not cryptography** — broadcast channels are public, and a
  determined dev-tools user could decode any of it. The same caveat applies
  to `hint`/`peek` grants (each leaks one letter to a snooper). Accepted
  trade-off for a no-backend party game; don't pretend otherwise in UI copy.
- FRIEND spectator perks: `round.viewers` (the setter, plus each solver the
  moment they solve) receive every guess's actual letters via addressed
  `sletters` events — a fresh solver gets a backfill of everything they
  missed, and resync honors viewer status. The mirror keeps letters in
  `oppWords`; the UI renders letters for any grid row that has a `word`.
  The setter can also fire emoji reactions (`react` intent → `reaction`
  broadcast) at a guesser — validated host-side (setter-only, allowed emoji
  list, 600 ms cooldown) and rendered as a floating emoji on the target's
  panel everywhere plus a big splash on the target's own board. STILL-
  COMPETING guessers never get each other's letters.

### TOWER mode (co-op, endless)

One shared endless "round" outside the word-cycle machinery: `engine.tower`
holds stage/height/combo/lives/used-words/revives; there is no `round` and no
reveal cycle. Solo starts are allowed (`minPlayers()` is 1 for tower).
Protocol: `twr` (full state on start/stage-change), `twrword` (accepted word:
clients apply the score DELTA locally - lean protocol), `twrmiss` (life
lost), `twrhunger` (silence bled everyone), `twrrev` (revive minigame
start/row/end - letters are public, it's co-op), `twrbonus` (team-wide heart:
`reason` is `'milestone'` or `'spelled'`). Rules live in `js/tower.js` (pure,
node-importable, unit-tested): decree generation walks 8 escalation tiers
then piles on bans; every generated decree is verified to leave at least
`minWordsPerDecree` unused dictionary words. Tower submissions are NOT
pre-validated client-side - pressing enter on a bad word is how lives are
lost, by design (only the revive wordle gets the friendly local dictionary
check). Scoring is deliberately RPG-huge (`wordPoints`: base + letter
values, x stage, x combo).

**DECREE pacing is a direct host setting, not a difficulty label.**
`settings.rampWords` (default `TOWER.defaultRampWords` = 5) is words-per-
decree, host-adjustable 2-10 via a lobby `<input type="range">`
(`#ramp-range`/`#ramp-out`, wired in `ui.js wireGameChrome()` - `input`
updates the live readout only, `change` fires `setSettings` once the drag
ends, to avoid flooding the lobby broadcast on every drag tick). It is
**not** clamped server-side - the UI restricts normal hosts to 2-10, but
tests intentionally pass values like `999` to freeze a stage or `2` to force
rapid escalation, and `initTower()` accepts whatever `settings.rampWords`
holds. Counterintuitively LOWER plays easier (confirmed by playtesting, not
just theory): a small count cycles to a fresh, often-gentler constraint
before the team's vocabulary for the current one is tapped out; a high count
forces them to keep finding NEW distinct words under the SAME constraint
until they run dry. `TOWER.hungerMs` is now a flat constant (not difficulty-
keyed) - `settings.hungerMs` remains a separate debug-only override used by
tests. `settings.difficulty` (the shared Classic/Royale enum) has no effect
on TOWER at all; the lobby hides `#set-diff` and shows `#set-ramp` instead
when `mode === 'tower'`.

**Bonus hearts.** `engine.grantHearts(reason)` adds one life to every active
player, capped at `TOWER.maxLives` (5) - including anyone currently at 0,
which is a deliberate "team saved them" revive-via-milestone. Two triggers,
both checked in `onTowerGuess` right after a word is accepted: (1) a height
multiple of `TOWER.heartEveryHeight` (10) - `Math.floor(height/N) >
Math.floor((height-1)/N)` catches the crossing regardless of how many words
land at once; (2) `checkTowerSpelled()` - the newest 5 rows in `t.rows`, any
single column, read in placement order, equal `'tower'`. Only the newest
window needs checking on each word: any 5-row window's *last* row is unique,
so checking at the moment that row lands covers every possible window
exactly once (no need to rescan history). Both can fire on the same word
(stacking is intended, not a bug).

**Revive pauses the hunger clock.** `pauseHungerForRevive()` /
`resumeHungerIfIdle()` gate on `Object.keys(tower.revives).length` so
concurrent revives don't fight: the clock pauses on the first revive to
start and only resumes (with a FRESH full window, not leftover time) when
the last one ends - success, failure, or the reviver disconnecting mid-puzzle
(`onLeave` synthesizes a `twrrev` `phase:'end', reason:'left'` so the client
UI doesn't leave a stale rescue panel on screen forever). Trap: a
NON-reviving player can still submit ordinary tower words while a teammate
reviving someone else is mid-puzzle - `onTowerGuess`'s success path must
check `hungerPaused` before re-arming, or a bystander's climb would silently
un-pause a clock that's supposed to stay frozen. Client mirrors the same
guard (`onTower`/`onTowerWord` skip touching `hungerAt` while
`tower.hungerPaused`), because a stage-change broadcast can land mid-revive
too.

## Known traps (each one bit us or will bite you)

1. **The event registry.** Every host broadcast type lives in
   `protocol.js EV` and `client.js` **asserts at startup** that it has a
   handler for each one. Add a new host event without wiring the guest
   handler and every page throws immediately — that's the point. Do not
   bypass the registry with ad-hoc event names.
2. **No self-echo.** Neither transport delivers your own send back to you.
   Anything the sender must also process goes through `Net.emit()`. If a new
   feature "works for guests but not the host" (or vice versa), you used
   `send` where you meant `emit`.
3. **Transient state vs. slow observers.** `REVEAL` is wiped by the next
   `WORD`, and `DUEL_END` used to be wiped by `RESUME` in the same tick. The
   mirror pins `lastReveal` / `lastDuel` permanently, and the engine delays
   the post-duel `RESUME` by `revealMs`. If you add a new fleeting broadcast,
   pin it the same way or tests (and humans) will miss it.
4. **Background-tab throttling.** Chrome throttles rAF and timers in
   unfocused pages. The Playwright config launches with
   `--disable-background-timer-throttling` (and friends), and test helpers
   poll with `{polling: 100}` instead of the rAF default. Without both, any
   multi-page test flakes.
5. **Custom CSS properties** (`--sig`, the per-player signature color) must be
   set with `style.setProperty('--sig', v)` — plain `style['--sig'] = v`
   silently does nothing. `util.el` handles this; use it.
6. **Frozen-player tests**: don't click a frozen keyboard and expect
   Playwright's auto-wait to save you — call the mirror/engine directly via
   `page.evaluate` (see powerups.spec.js), which is also how you verify the
   host rejects a raw forged intent.
7. **GitHub Pages subpath**: all URLs in the code are relative and `.nojekyll`
   exists. Don't introduce absolute `/paths`.
8. **Room codes** use an alphabet without O/0/I/1. Keep it that way; support
   tickets about `O` vs `0` are self-inflicted.
9. **Presence is late, sparse, and only fires on change.** Two corollaries,
   both of which shipped as "the second player keeps getting kicked":
   (a) anything that watches presence must get the CURRENT roster replayed on
   attach — `onPresence(cb)` in both transports does this; a watcher that
   starts from an empty set concludes everyone left; (b) never start a
   kicked-for-absence clock on a peer that has not been CONFIRMED present at
   least once (`engine.everSeen`, `seenHost` in the watchdog) — a joiner's
   broadcast regularly outruns their presence registration. Also, any live
   intent from a "disconnected" player reinstates them with a resync, and
   `LEAVE_GRACE_MS` is deliberately roomy (8 s) because phone radios flap.
   tests/stability.spec.js is the regression test.
10. **The dreaded stalled round**: a round only finishes when every guesser is
   `done`. Any new way for a player to stop guessing (new power-up, new
   status) must either mark them done or exclude them from `guessers()`, or
   the game hangs — the leave/timeout/elimination paths all do this.

## Debug handle & tests

`?debug=1` exposes `window.__friendle`:

- `state()` — full mirror snapshot (any page)
- `engineState()`, `secret()`, `duelSecret()`, `setScore(pid, n)`,
  `setSettings(patch)` — host page only
- `guess(word)`, `type/enter/backspace`, `buy(item, target, stake)`, `quit()`
- `window.__wireLog` — every envelope this page saw (tests assert the secret
  never crosses in plaintext before reveal)

Tests also shrink pacing via settings the lobby UI doesn't expose
(`countdownMs`, `revealMs`, arbitrary `timerMs`/`words`) — the engine accepts
any value; the UI only offers the sanctioned choices.

```bash
npm install          # dev-only: @playwright/test
npm test             # full E2E suite over LocalTransport (~35 s)
npm run serve        # localhost:4173; open two tabs with ?t=local to play solo
```

Every spec plays real matches across multiple pages of one browser context
(same-origin BroadcastChannel = the room): matchmaking, full Classic and
Royale matches to a winner (antes, rolling pots, a duel, eliminations),
FRIEND with typed secrets and setter rotation, all four power-ups plus shop
guardrails, timers, quitting (guest and host), and a 4-player room with a
bounced 5th player.

## Word lists & difficulty tiers

`data/solutions.js` (~13.1k), `data/guesses.js` (~14.7k) and `data/tiers.js`
(3k easy / 4k medium / 5k hard) are generated by `tools/build-words.mjs` from
public sources (Wordle valid-guess list, ENABLE + SOWPODS Scrabble
dictionaries, wordnik wordlist, Knuth's five-letter words, dwyl dictionary,
Google Books + OpenSubtitles frequency corpora, worldwide first/surname
lists, LDNOOBW profanity list — URLs in the script header).

Hard-won lessons encoded in that script — read them before "just adding more
words":

- **~13k is the honest ceiling.** The Wordle valid list already subsumes the
  entire Scrabble-legal 5-letter lexicon (ENABLE+SOWPODS add 13 words). Every
  further "growth source" is polluted: dwyl/words_alpha is full of lowercase
  proper names, places, brands and contractions ("salma", "italy", "kodak",
  "thats"); corpus attestation happily confirms them. Admission therefore
  requires Wordle- or Scrabble-legality, words on the worldwide name lists
  survive only if Scrabble says they're real words (smith yes, patel no), and
  Knuth's list is evidence-only (it carries "legos"/"ioctl"-grade corpus
  noise).
- Profanity/slurs are stripped from both lists; a SOFT_BAD tier (dual-use or
  charged words: "lynch", "jihad", …) is excluded from answers but stays
  guessable.
- Solutions ship **ordered commonest-first**; standard mode squares the
  random variate so everyday words dominate play while the deep tail keeps a
  marathon Royale from repeating (used words are tracked per session).
- Tiers are score-ordered slices of the bank: score = commonness percentile
  + structural penalties (duplicate letters +8, J/Q/X/Z +6 each capped) —
  "jazzy" plays harder than its frequency suggests. The deepest ~1k tail is
  unclassified and only ever served by standard mode.

Difficulty plumbing: `settings.difficulty` ∈ standard/easy/medium/hard/ramp
(Classic & Royale; FRIEND ignores it). `engine.resolveTier()` maps word
number → tier (ramp interpolates over the word count in Classic, tops out at
word ~7 in endless Royale); `pickWord(used, tier)` picks uniformly inside a
band, widening to neighbors then the full bank if a marathon drains it. Duel
words inherit the round's tier. The tier rides on the `word` broadcast so
clients can label the header.

## Capacity

The shared free Supabase project allows ~200 concurrent connections and 2M
realtime messages/month. A 4-player game sends a few tiny messages per guess —
negligible — but keep it that way: broadcast deltas, not snapshots (resync
excepted).
