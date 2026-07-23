# FRIENDLE 🌈

**Wordle with friends. As a battle.**

Everyone gets the *same* secret 5-letter word. You watch your rivals' grids fill
up **live — colors only, never their letters** — while you race to solve it
first. No accounts, no installs, no app store. One person hosts, friends join
with a 4-letter code, phones and laptops mix freely.

▶ **Play it:** https://ebbanflo.github.io/friendle/

## How a game works

1. One player taps **HOST GAME** and gets a room code (like `U2A1`).
2. Up to 3 friends tap **JOIN** and enter the code — or just open the invite
   link the host copies.
3. The host picks a mode and hits **START**.

Standard Wordle rules per word: 6 guesses,
🟩 right letter right spot, 🟨 right letter wrong spot, ⬛ not in the word.
Solve before your friends — being *first* is where the big points are.

## The three modes

### CLASSIC
The host picks 3, 5, or 10 words. First to solve each word gets full points
(base + speed bonus + fewer-guesses bonus); slower solvers get a consolation
cut; failing all 6 guesses gets nothing. Most points at the end wins.

### ROYALE ∞
Endless words. Everyone starts with **1000 points**, and each word every
survivor antes into a pot (25/50/100 — host's choice). **First solver takes
the whole pot.** Nobody solves it? The pot rolls over and keeps growing.
Hit 0 points and you're eliminated to the spectator bench. Last player
standing wins the ⚔ crown.

### FRIEND 💗
The purest form of the art: one player — the **setter** — secretly types their
own 5-letter word (any real word in the dictionary), and everyone else races
to guess it. The host picks **1 / 3 / 5 / 10 words — each**: every player
sets that many, so 5 words with 3 players is a 15-round night.

Scoring is about **fewest guesses, not speed**: crack it in 3 rows and you
outscore someone who hit enter first but needed all 6. The setter earns
points **for every guesser they stump** — a full-room stump is a jackpot.

Since the setter isn't competing, they get the best seat in the house: every
guesser's grid **with the actual letters**, live, plus an emoji heckle bar
(😂🔥😱👀💀🫠🧠) to react to each terrible guess as it lands. And the moment
*you* solve the word, you join the letter-vision club too — watch the
stragglers flail in full detail. Still-competing guessers only ever see each
other's colors. No power-ups here — it's pure.

### TOWER 🗼
Barely Wordle at all — and gloriously so. **Co-op, 1–4 players** (solo climbs
welcome), endless. The team races to stack real 5-letter words into a tower,
but every word must obey the **DECREE** at the top of the screen. Two
independent settings shape it: **LEVEL** (EASY / MED / HARD / RAMP) picks the
decree's difficulty — EASY/MED/HARD hold steady all game, RAMP starts easy
and climbs to hard, then stays there instead of spiraling into oblivion.
HARD isn't just "no vowels" on repeat, either — expect rare letters, words
where the first and last letter match, exact vowel counts, and other twists
alongside the classic letter-bans, all rotating for variety. **DECREE** is
the separate pacing knob — 3, 5, or 10 words before the decree changes.

Everyone has **3 lives**. A submission that isn't a real word, repeats the
tower, or breaks the decree costs one — and so does silence: leave the
hunger bar to empty and *everyone* bleeds. Lose them all and you're down,
until a teammate spends points on ✨ **Revive** — a classic solo Wordle where
solving brings you back with 2 lives. **Reviving stops the clock**: the
hunger bar freezes (blue, "⏸ REVIVING — TIMER PAUSED") the moment anyone
starts a rescue, so it's a fully untimed puzzle — everyone else can keep
climbing in the meantime. It resumes fresh the instant the last active
revive ends. When the whole team is down, the tower falls; your height is
the trophy.

The tower rewards you for surviving: **every 10th floor**, the whole team
gets a bonus heart — and if anyone's currently down, that heart brings them
back. And keep an eye on the stack: if the letters in any single column of
5 consecutive floors happen to spell **T-O-W-E-R**, the tower blesses you
with a bonus heart for everyone, no matter the height. Hearts cap at 5, so
hoard wisely.

Scoring is full RPG: huge glowing numbers, stage multipliers, team combos,
and +damage popping off every word. Fill the screen.

## The power-up shop (Classic & Royale)

Buy mid-word with your points:

| | Power-up | Cost | What it does |
|--|----------|------|--------------|
| 🔍 | **Peek** | 75 | Reveal one actual letter from an opponent's most recent guess |
| 🧊 | **Freeze** | 100 | All opponents' keyboards lock for 5 seconds |
| 💡 | **Hint** | 75 | Reveal one green letter in your own grid |
| 🗑️ | **Smudge** | 100 | One gray letter on an opponent's keyboard un-grays — poison their memory |
| ⚔️ | **Duel** | stake 0–200 | Challenge a living foe: you alternate guesses on a fresh word while everyone spectates. Loser pays the stake — and in Royale, busts out if they can't cover it |

## Difficulty (Classic & Royale)

The host picks a **LEVEL** in the lobby:

- **STD** — the classic experience: any word from the full ~13,000-word bank,
  biased toward everyday words. Difficulty labels are ignored.
- **EASY / MED / HARD** — every word comes from a curated difficulty band
  (3,000 easy, 4,000 medium, 5,000 hard words, ranked by how common the word
  is plus how nasty its letters are — duplicates and J/Q/X/Z sting).
- **RAMP** — starts easy and climbs: a gentle opener, a mean finish. In
  Royale the climb tops out around word 7 and stays hard forever.

FRIEND mode ignores all of this — its words come from your friends' brains,
which are their own difficulty setting.

## Nice things it also does

- **Optional per-word timer** (60s / 90s / 2 min) — run out and that word is a miss.
- **Pause button** hides your whole screen behind an opaque overlay (nosy
  siblings, coworkers, cats).
- **Drop-in resilience** — someone rage-quits, the game keeps going. If the
  *host* leaves, the room dies (they were the referee).
- **Sound** — all bleeps synthesized live in your browser, toggle on the main menu.
- Rainbow everything when you win. You'll know it when you see it.

## Hosting your own copy

It's a fully static site — fork the repo, enable GitHub Pages, done. No build
step, no server (multiplayer rides on a free Supabase Realtime channel).
Maintainers and the technically curious: see [INSTRUCTIONS.md](INSTRUCTIONS.md).
