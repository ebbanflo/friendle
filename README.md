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
to guess it. Since the setter isn't competing, they get the best seat in the
house: every guesser's grid **with the actual letters**, live, plus an emoji
heckle bar (😂🔥😱👀💀🫠) to react to each terrible guess as it lands.
Guessers still only see each other's colors — they're competing. If *nobody*
cracks the word, the setter scores instead. The role rotates every word, so
everyone gets a turn being the villain. No power-ups here — it's pure.

## The power-up shop (Classic & Royale)

Buy mid-word with your points:

| | Power-up | Cost | What it does |
|--|----------|------|--------------|
| 🔍 | **Peek** | 75 | Reveal one actual letter from an opponent's most recent guess |
| 🧊 | **Freeze** | 100 | All opponents' keyboards lock for 5 seconds |
| 💡 | **Hint** | 75 | Reveal one green letter in your own grid |
| 🗑️ | **Smudge** | 100 | One gray letter on an opponent's keyboard un-grays — poison their memory |
| ⚔️ | **Duel** | stake 0–200 | *Royale only.* Challenge a living foe: you alternate guesses on a fresh word while everyone spectates. Loser pays the stake — and busts out if they can't cover it |

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
