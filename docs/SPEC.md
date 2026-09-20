# Jaga: build spec

Tagline: "Nobody was counting the days. Jaga does."

Jaga is a health companion on WhatsApp. It remembers how long a symptom has been going on,
notices when time or context changes what should happen next, and helps the person get
appropriate care. Hackathon: Tencent Cloud x AI Singapore 2026, Healthcare track, Challenge 1
(Intelligent Self-Triage and Care Navigation).

Read this whole file before writing code. Build ONE milestone at a time. Stop after each
milestone and summarise what you built and how to run it.

## 1. Rules that must never be broken

1. The LLM never decides medical urgency. Urgency comes only from the policy layer
   (`policies/*.json`), which is plain data evaluated by plain code.
2. The LLM never names a disease as a diagnosis and never gives or invents a medication dose.
3. Never invent precision. "Since before CNY" is stored as an approximate onset with a
   minimum provable duration and `confidence: "approximate"`. Never a made-up exact date.
4. Silence is `unknown`. A missed check-in never becomes "better".
5. An AI reading of a medicine label is `unconfirmed` until the user taps to confirm it.
   Unconfirmed readings are never stored as fact.
6. Red-flag screening runs on EVERY incoming message, before any clock logic.
7. Minimising by the user or by a support person can never delay a red-flag escalation,
   and can never overwrite recorded history.
8. Every check-in message ends with the escape hatch:
   "You can seek medical care at any time if you're concerned."
9. Jaga never says "it's fine" or "you're fine until day X".
10. Nothing is sent to a support person without the user's prior consent, and only at
    thresholds the user agreed to.
11. Independent mode (no support person) is the complete product. It must never get a
    weaker or later escalation than Supported mode.
12. Anything simulated (clinic, slot, price, subsidy, booking) carries a visible
    "PROTOTYPE DATA" label in the UI and `simulated: true` in the data.
13. All medical thresholds in this repo are PLACEHOLDERS pending clinician review.
    Every policy file carries `"status": "PENDING_CLINICIAN_REVIEW"`.

## 2. Pipeline

voice / text / photo
→ AI extraction (LLM)
→ structured observation (typed JSON, "unknown" is a valid value)
→ user confirmation where needed
→ validated longitudinal state (the Jaga Clock)
→ deterministic policy evaluation (no LLM)
→ care action (check-in, escalate, navigate, summarise, follow up)

## 3. Stack

- Node.js 20+, TypeScript, run with `tsx`. Tests with Vitest.
- HTTP server: Fastify.
- Storage: SQLite via better-sqlite3 (single file, easy to deploy on Railway).
- Front end: one static page, plain HTML + CSS + vanilla JS. No framework.
- LLM: behind one interface `src/llm/LlmClient.ts` so the provider can be swapped.
  Default to an OpenAI-compatible endpoint configured by env vars
  `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. Include a `MockLlmClient` for tests.
- WhatsApp: WAHA HTTP API (env `WAHA_URL`, `WAHA_API_KEY`, `WAHA_SESSION`) behind
  `src/channels/Channel.ts`. The web demo page is a second Channel implementation.
- A `Clock` interface provides "now". Production uses real time. The demo uses a
  simulated clock that the time-machine slider controls. No code may call `Date.now()` directly.

## 4. Folder layout

```
docs/                 this spec, diagrams
policies/             cough.json, mouth-ulcer.json  (data, versioned)
src/core/             episode model, state machine, policy evaluator, red-flag screen
src/llm/              LlmClient, prompts, extraction schemas
src/channels/         Channel interface, waha.ts, webdemo.ts
src/navigation/       care navigation (prototype data), summary builder
src/server.ts         Fastify app
web/                  demo page: phone frame + day slider + live Jaga Clock panel
tests/                unit tests + timeline tests
tests/timelines/      *.json synthetic timelines
```

## 5. Data model (TypeScript types, then SQLite tables)

```ts
type Mode = "independent" | "supported" | "assisted";
type Trajectory = "better" | "same" | "worse" | "intermittent" | "unknown";
type EpisodeState = "ACTIVE" | "IMPROVING" | "RESOLVED" | "RECURRENT";
type Confidence = "exact" | "approximate" | "unknown";
type Reporter = "user" | "support_person";

interface Person { id; displayName; ageBand?; language; mode: Mode;
  supportPersonId?; consent: { shareAtThresholds: boolean; emergencyContact?: string;
  pausedAt?: string } }

interface Onset { rawText: string;           // "since before CNY"
  earliestPossible?: string; latestPossible: string;   // ISO dates
  confidence: Confidence }
// duration used by policy = now - latestPossible  (the MINIMUM provable duration)

interface Observation { id; episodeId; at; reporter: Reporter;
  kind: "mention" | "checkin" | "redflag_answer" | "self_treatment" | "silence";
  trajectory?: Trajectory; redFlags?: Record<string, "reported"|"denied"|"unknown">;
  item?: { label: string; confirmed: boolean }; rawText?: string }

interface Episode { id; personId; symptom: "cough" | "mouth_ulcer";
  onset: Onset; state: EpisodeState; trajectory: Trajectory;
  discordance: boolean; missedCheckins: number;
  policyId: string; policyVersion: string; lastActionAt?: string }
```

## 6. Policy file format (data, not code)

```json
{
  "id": "cough", "version": "0.1.0",
  "status": "PENDING_CLINICIAN_REVIEW",
  "reviewer": null,
  "sources": [{ "label": "HealthHub: Cough", "url": "https://www.healthhub.sg/a-z/diseases-and-conditions/cough" }],
  "redFlags": [
    { "key": "blood", "action": "SEE_DOCTOR_TODAY" },
    { "key": "breathless_or_chest_pain", "action": "EMERGENCY_995" }
  ],
  "rules": [
    { "id": "not_better_after_self_treatment",
      "when": { "minDurationDays": 14, "selfTreatment": true, "trajectoryIn": ["same","worse","intermittent"] },
      "action": "SEE_GP", "explain": "placeholder text", "sourceIndex": 0 },
    { "id": "worsening", "when": { "trajectoryIn": ["worse"] }, "action": "SEE_GP", "sourceIndex": 0 },
    { "id": "long_duration", "when": { "minDurationDays": 56 }, "action": "SEE_GP", "sourceIndex": 0 }
  ],
  "checkinEveryDays": 7,
  "resolvedAfterSymptomFreeDays": null
}
```

Actions: `KEEP_WATCHING` | `SEE_GP` | `SEE_DOCTOR_TODAY` | `EMERGENCY_995`.
The evaluator returns the action, the rule id that fired, the policy version and the source.
All numbers above are placeholders. Do not present them as medical advice anywhere.

## 7. Milestones

**M1. Core engine (no AI, no WhatsApp, no UI).**
Types, SQLite schema, Clock interface with simulated clock, episode state machine,
policy loader + evaluator, red-flag screen, discordance detection, silence handling.
Vitest unit tests. A timeline test runner that replays `tests/timelines/*.json`
(a dated list of events) and asserts the expected action on each day.
Include 6 starter timelines: clears before threshold; still there after self-treatment;
improves then returns; two missed check-ins; red flag on day 9; user says better while
support person says still coughing.

**M2. Web demo page.** Phone-frame chat, day slider driving the simulated clock, live
Jaga Clock panel, mode switch (Independent / Supported / Assisted). Tap buttons for
check-ins. Works with scripted input only, no LLM yet.

**M3. LLM extraction.** Prompts + JSON schemas for: symptom and fuzzy onset, trajectory,
red-flag mentions inside long messages, medicine label reading from a photo. English,
Singlish, Mandarin. Confirmation step for every label reading. MockLlmClient for tests.

**M4. Care navigation + GP summary.** Prototype-data clinic card (labelled),
"When can you go?" plan buttons, reminder, "Did you manage to go?", one-page GP summary
(HTML to PDF). No diagnostic claims in the summary.

**M5. WhatsApp channel (WAHA).** Same engine, second channel. Text fallback
"reply 1, 2 or 3" if buttons are not available.

**M6. Evaluation.** 100+ timelines, metrics report page (red-flag recall, late escalation,
over-escalation, silence handling, mode parity, consent integrity, by language).

## 8. Style

- Small files, pure functions in `src/core`, no LLM or network calls inside `src/core`.
- Every medical string shown to users lives in `policies/` or `src/copy/`, never inline in logic.
- README explains how to run tests and the demo in under 10 lines.
