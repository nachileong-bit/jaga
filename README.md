# Jaga

**Built by [ZES Consulting](https://zesconsulting.com).** ZES helps companies put AI to work safely. Jaga shows how we build: fixed rules, an audit trail, and a human sign-off.

Live demo: https://jaga-production-dc96.up.railway.app/web/

> Nobody was counting the days. Jaga does.

Jaga is a health companion on WhatsApp. It remembers how long a symptom has
been going on, notices when time or context changes what should happen next,
and helps the person get appropriate care.

Hackathon: Tencent Cloud x AI Singapore 2026, Healthcare track, Challenge 1
(Intelligent Self-Triage and Care Navigation).

Knowledge base: https://jaga-production-dc96.up.railway.app/web/knowledge.html

Demo video: https://jaga-production-dc96.up.railway.app/web/video.html

<img src="web/brand/jaga.png" alt="Jaga, a red panda in a white singlet, green shorts and blue slippers" width="220">

Jaga's mascot is a red panda dressed like the uncle at the kopitiam. It sends WhatsApp stickers at friendly moments. Warning-sign messages stay plain.

Built with Tencent CodeBuddy alongside other AI coding assistants (multiple LLMs).

## Status

Working prototype: core rule engine, web demo, care navigation, GP summary,
WhatsApp bridge, a sourced knowledge base and mascot stickers. All medical rules and answers are
marked PENDING_CLINICIAN_REVIEW.

## Knowledge base

`knowledge/kb.json` holds short answers copied from official Singapore sources
(HealthHub, MOH, SCDF), each with its link and the date it was checked.
`src/knowledge/kb.ts` looks answers up by keyword, with no AI, so Jaga can only
ever reply with a stored, sourced answer. If nothing matches, Jaga says it does
not know and points to a pharmacist, GP or the NurseFirst helpline. It never
names an illness. Warning signs are screened before any question is answered.

## Run tests

```bash
npm install
npm test          # Vitest unit tests
npm run timelines # Timeline runner (replays synthetic timelines)
```

## Run the demo

```bash
npm install
npm run dev      # starts Fastify at http://localhost:3000
```

Open `http://localhost:3000/web/` in your browser. Pick a scenario
(Mr Tan — supported / Ms Lim — independent), use the day slider to advance
the simulated clock, and tap the check-in buttons.

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

## What M2 adds

- **Web demo page** — `web/index.html`, `web/style.css`, `web/app.js`. Plain
  HTML/CSS/vanilla JS, no framework, no build step. Phone-frame chat on the
  left, Jaga Clock panel and controls on the right.
- **Fastify server** (`src/server.ts`) — serves `/web` as static files and a
  small JSON API (`reset`, `message`, `advance`, `state`). Each browser session
  gets its own in-memory SQLite store and SimulatedClock.
- **Scripted extractor** (`src/llm/ScriptedExtractor.ts`) — stands in for the
  LLM until M3. Maps button taps and canned phrases to structured observations.
- **Conversation flow** (`src/conversation/`) — orchestrates the scripted
  extractor and the engine, produces the chat transcript.
- **Copy strings** (`src/copy/en.ts`) — all user-facing strings in one file.
- **"gone" trajectory** — added to the Trajectory type, treated like "better"
  for policy rules and state transitions.

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
policies/             cough.json, mouth_ulcer.json (data)
src/core/             types, clock, repository, state machine, policy evaluator, engine
src/llm/              Extractor interface, ScriptedExtractor
src/conversation/     demo conversation flow
src/copy/             user-facing strings (en.ts)
src/server.ts         Fastify app
web/                  demo page: phone frame + day slider + live Jaga Clock panel
tests/unit/           Vitest unit tests
tests/timelines/      *.json synthetic timelines + runner
```

## Licence

Copyright (c) 2026 ZES Consulting. All rights reserved. See `LICENSE`.
