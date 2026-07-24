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
node-importable, unit-tested). Tower submissions are NOT pre-validated
client-side - pressing enter on a bad word is how lives are lost, by design
(only the revive wordle gets the friendly local dictionary check). Scoring
is deliberately RPG-huge (`wordPoints`: base + letter values, x stage, x
combo).

**Decree generation is three hand-vetted difficulty pools, not an endless
escalation ladder.** `js/tower.js` exports `EASY`/`MEDIUM`/`HARD` arrays of
generator functions (each returns a constraint: `req`/`reqAt`/`ban` plus the
newer predicates `rep` (needs a double letter), `uniq` (no repeats),
`vmin`/`vmax` (vowel-count bounds), `bookend` (first letter === last), and
`dvowel` (two vowels adjacent somewhere)). `genConstraint(stage, used,
difficulty, rampWords)` picks a pool by `difficulty` directly for
`'easy'`/`'medium'`/`'hard'`, or by `stage` for `'ramp'` (<=2 easy, <=5
medium, else hard - and it STAYS in hard, rotating through its varied
generators, instead of piling on more bans forever). Every candidate passes
TWO independent gates before being accepted (40 retries, then a pool
downgrade as a last resort):

1. `countPossible(c, used) >= minWords` (over the fresh, unused GUESSES pool)
   where `minWords = Math.max(poolFloor, rampWords)` - the `rampWords` term is
   load-bearing: a decree that can't mathematically supply that many distinct
   legal words would strand the team permanently.
2. `countRecognizable(c, recogFloor) >= recogFloor` (over the static SOLUTIONS
   bank - the curated "answers people know", ~13k of the 14.8k guesses).
   HARD's floor is 25, easy/medium higher. This is what stops a "hard" decree
   that's technically survivable but only via obscure scraps (`lymph`,
   `pshaw`, `tsars`, `raser`) - the exact "some decrees didn't work / barely
   recognizable words, not fun" report. `countRecognizable` early-exits once
   the floor is met, so it's cheap for word-rich decrees.

The HARD pool was rebuilt around this: the old obscure-forcers (no-vowels +
no-repeats -> 23 words; bookend + a slotted letter -> ~17 near-non-words)
were cut in favor of recognizable-but-hard twists. The pool is deliberately
WIDE (11 generators) so hard keeps cycling rather than converging: STARTS
WITH / ENDS IN a letter, first==last (optionally + 2 vowels), a rare required
letter, ban a common vowel (NO E/A/O, Gadsby-style), exactly-one-vowel (+ a
pinned interior consonant), a double letter (+ exactly one vowel, or + a
required common letter), a 3-required-letters decree that always includes a
vowel. Plain NO VOWELS is STILL in the mix but as just one of eleven options,
and because its whole pool is only ~57 words it also fails the survivability
floor once a long game has consumed them - so it's occasional spice (~1-4% of
hard decrees, trending to 0% deep in a game), never the place hard "defaults"
to. If you add a new predicate, update `matchesConstraint` AND
`describeConstraint` together, and re-run the empirical vetting against
BOTH `GUESSES` (survivability) and `SOLUTIONS` (recognizability) - see the
"decree difficulty pools" test in `tests/tower.spec.js`, which asserts every
sampled decree clears `countRecognizable >= 20`, that no-vowels stays under
20% of hard decrees, and that >15 distinct hard decree shapes appear.
`describeConstraint` renders slot-1 reqAt as `STARTS WITH x` and slot-5 as
`ENDS IN x` for readability.

**DECREE (words-per-decree) and LEVEL (decree difficulty) are two
independent host settings**, both plain lobby seg-button rows reusing the
generic `.seg`/`data-setting` wiring already in `ui.js` (no bespoke JS
needed). `settings.rampWords` (default `TOWER.defaultRampWords` = 5, choices
3/5/10 via `#set-ramp`) is words-per-decree pacing. `settings.difficulty`
(the shared Classic/Royale enum, `#set-diff`) doubles as TOWER's decree
difficulty - `'standard'` (the meaningless-for-tower global default) is
auto-upgraded to `'ramp'` inside `engine.setSettings()` the moment
`mode === 'tower'`, and the LEVEL row hides its STD button in tower mode
(`#diff-standard`) so nothing shows as unselected. Neither setting is
clamped server-side - `initTower()` accepts whatever `settings.rampWords`/
`settings.difficulty` hold, and tests intentionally pass values like `999`
to freeze a stage. `TOWER.hungerMs` remains a flat constant (not
difficulty-keyed) - `settings.hungerMs` is a separate debug-only override.

**Visible stack is a fixed-size window, not the full tower.** The engine
keeps every floor (`tower.rows`, capped at 60 for memory, `.slice(-40)` on
resync) - height/scoring are never affected. The window size lives in config
as `TOWER.visibleRows` (10), the single source of truth shared by three
places that must agree: `ui.js renderTowerStack()` renders the newest
`TOWER.visibleRows`; `.tower-stack` in style.css is a fixed `height` (not
`min-height`) sized for exactly that many rows; and the engine's
duplicate-word rule (below) uses the same window. If you ever change it,
update the CSS height in lockstep (10 rows = 10 * 1.7rem tiles + 9 * .22rem
gaps = 19rem) or the keyboard will drift again. Fixed DOM height + fixed row
count is what makes the keyboard immovable from the first floor onward.

**Duplicate-word rule is ON-SCREEN only.** `engine.towerOnScreen(word)`
checks just the newest `TOWER.visibleRows` floors, NOT all history: a word
that has scrolled past the visible window becomes playable again (climb 10+
new floors and your opening word is fair game). `tower.used` still
accumulates every word ever placed, but purely to feed `genConstraint`'s
survivability check - it is deliberately NOT the duplicate gate. (Using the
full history there would keep excluding words the player can no longer even
see, which is what the "buggy was rejected 10 floors later" report was
about.) Guests never duplicate-check (host-authoritative), so this is a
one-file rule; the client just renders the resulting miss toast.

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

**Mobile: the revive board REPLACES the tower stack, never adds to it.**
`ui.js renderRevive()` hides `#tower-stack` and shows `#revive-box` (or vice
versa) whenever any revive starts/ends; both are fixed at the identical
`19rem` CSS height so the swap causes zero layout shift. `#tower-input`
(the current-guess row) is NEVER hidden - `renderTowerInput()` blanks its
tile text for the active reviewer instead (their typing already renders
live inside the revive board) because hiding it would shrink the panel and
move the keyboard, the exact class of bug this was built to avoid. The
`#hunger-label` ("REVIVING — TIMER PAUSED") toggles via a `visibility`-based
`.inactive` class, not `display:none`, for the same reason: its space in
`.tower-hud` must stay reserved even when hidden, or a revive starting would
shift everything below it by one text line. `.tower-row` needs an explicit
`justify-content: center` - `.tower-stack` is `width: 100%` (so an empty
stack doesn't collapse to zero width under `.game-panel`'s
`align-items: center`), which stretches each row to full width and left-
justifies its content by default.

**iOS PWA: `#scr-game` needs BOTH safe-area insets, not just the bottom
one.** `apple-mobile-web-app-status-bar-style: black-translucent` (set for
the home-screen icon) makes standalone iOS render edge-to-edge under the
notch/status bar. Without `env(safe-area-inset-top)` in `#scr-game`'s
padding, the header (`#btn-pause`/`#btn-help`/`#btn-quit` - shared by every
mode) sits partly under the status bar and becomes untappable. Headless
Chromium always resolves that env() to 0, so this can't be reproduced
directly in Playwright - the regression test locks in the CSS rule's
existence textually instead of the real geometry.

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
   exists. Don't introduce absolute `/paths`. This includes `manifest.json`'s
   own paths (`icons/...`, `start_url: "."`, `scope: "."`) - keep them
   relative or "Add to Home Screen" breaks on the Pages subpath.
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

## App icon / "Add to Home Screen"

`icons/*.png` (apple-touch-icon at 180/152/167, icon-192, icon-512) are
rasterized once from a source SVG (2x2 tile grid in the four
`PLAYER_COLORS`, full-bleed with NO pre-rounded corners - iOS applies its
own corner mask, so a pre-rounded icon double-rounds or shows background
through the gap) via headless Chromium screenshot - there's no ImageMagick/
sharp dependency, just `chromium.launch()` + `page.screenshot()` on an
`<img>` tag pointed at a `data:image/svg+xml;base64,...` URL. Regenerate by
recreating that render script if the design ever changes; the SVG source
itself isn't checked in (only the rendered PNGs are - this repo has no
build step, and the icons are small/static enough not to need one).
`manifest.json` + the `apple-mobile-web-app-*` meta tags in `index.html`
make "Add to Home Screen" launch standalone (no Safari chrome), not just
bookmark the page with a custom icon.

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
- **Word-safety is three tiers, EXACT-MATCH ONLY** (`SLURS`/`CRUDE`/
  `SOFT_BAD` in build-words.mjs) — never prefix/stem matching. An earlier
  version blocked by 4-5 letter stem against LDNOOBW (a generic third-party
  filter list), which silently ate ~130 ordinary words as GUESSES: "spice"/
  "spicy" (stem "spic", shared with a slur), "grope"/"sucks"/"tushy"/"fecal"
  (LDNOOBW's own over-broad literal entries), "butte"/"cocky"/"dicky"/
  "booby"/"nudes" (innocent words sharing a prefix with an unrelated flagged
  word) — and "whore" itself, an exact-listed word that was never a stem
  victim but got caught because the SAME filter was wrongly applied to the
  whole guess dictionary, not just the solution pool. `tests/words.spec.js`
  is the regression test. Current policy: `SLURS` (small, hand-reviewed
  ethnic/racial slurs — excluded from BOTH guesses and solutions, since being
  wrong in the permissive direction here is a real harm) vs. `CRUDE` (real,
  vulgar-but-mainstream dictionary words like "whore"/"bitch"/"pussy" — fully
  valid GUESSES, matching what the actual official Wordle list allows, but
  never auto-picked as the publicly-revealed solution) vs. `SOFT_BAD`
  (dual-use words with an innocent primary meaning: "lynch", "jihad", … —
  same guessable-not-a-solution treatment as CRUDE, kept as a separate tier
  only for readability). A FRIEND-mode setter can still knowingly choose a
  CRUDE word as their secret (they pick from the full guess dictionary
  already) — that's a deliberate human choice, unlike an auto-pick, and
  intentionally not restricted further.
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
