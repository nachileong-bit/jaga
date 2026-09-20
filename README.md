# Jaga

> Nobody was counting the days. Jaga does.

Jaga is a health companion on WhatsApp. It remembers how long a symptom has
been going on, notices when time or context changes what should happen next,
and helps the person get appropriate care.

Hackathon: Tencent Cloud x AI Singapore 2026, Healthcare track, Challenge 1
(Intelligent Self-Triage and Care Navigation).

## Status

**Milestone M1 (core engine) is complete.** No AI, no WhatsApp, no UI yet.

## Run tests

```bash
npm install
npm test          # Vitest unit tests
npm run timelines # Timeline runner (replays synthetic timelines)
```

## What M1 includes

- **Types** (`src/core/types.ts`) — Episode, Observation, Policy, Clock, etc.
- **Clock** (`src/core/clock.ts`) — `RealClock` + `SimulatedClock`. No code
  calls `Date.now()` directly.
- **SQLite store** (`src/core/repository.ts`) — persons, episodes, observations
  via better-sqlite3.
- **Episode state machine** (`src/core/episodeStateMachine.ts`) — state
  transitions, discordance detection, silence handling, min-duration.
- **Policy loader** (`src/core/policyLoader.ts`) — loads `policies/*.json`.
- **Red-flag screen** (`src/core/redFlagScreen.ts`) — runs on every message,
  before clock logic.
- **Policy evaluator** (`src/core/policyEvaluator.ts`) — deterministic, no LLM.
- **Engine** (`src/core/engine.ts`) — ties it all together.
- **Policy data** — `policies/cough.json`, `policies/mouth-ulcer.json`.
- **Timeline runner** — replays `tests/timelines/*.json`, asserts actions.
- **6 starter timelines** — clears before threshold; still there after
  self-treatment; improves then returns; two missed check-ins; red flag on
  day 9; user says better while support person says still coughing.

## Rules that must never be broken

See `docs/SPEC.md` for the full spec. Key invariants enforced in code:

1. The LLM never decides medical urgency — urgency comes only from policy data.
2. Red-flag screening runs on every message before any clock logic.
3. Silence is `unknown` — a missed check-in never becomes "better".
4. Discordance is detected — user says "better" but support person disagrees
   → the worse trajectory is used for safety.
5. Minimum provable duration = now − onset.latestPossible (never invented).
6. All medical thresholds are placeholders pending clinician review.

## Folder layout

```
docs/                 spec
policies/             cough.json, mouth-ulcer.json (data)
src/core/             types, clock, repository, state machine, policy evaluator, engine
tests/unit/           Vitest unit tests
tests/timelines/      *.json synthetic timelines + runner
```
