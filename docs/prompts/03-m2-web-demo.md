Read @docs/SPEC.md sections 1, 3, 4 and the M2 milestone. M1 and M1.1 are done and
committed. Build Milestone M2 only (web demo page). No LLM, no WhatsApp. Do not start M3.

CREDIT BUDGET: work in small steps, do not re-read files you have already read, do not
refactor M1 code unless a change below requires it, run the full test suite at most twice.

1. SERVER. src/server.ts with Fastify. Serves /web as static files and a small JSON API.
   Each browser session gets its own in-memory SQLite store and its own SimulatedClock.
   - POST /api/demo/reset    { scenario: "mr_tan" | "ms_lim" }  -> starts fresh at day 0
   - POST /api/demo/message  { text?: string, button?: string, reporter?: "user" | "support_person" }
   - POST /api/demo/advance  { toDay: number }  -> moves the simulated clock forward only
   - GET  /api/demo/state    -> { day, mode, transcript[], clockPanel, lastResult }

2. SCRIPTED EXTRACTOR (stands in for the LLM until M3). src/llm/ScriptedExtractor.ts behind
   an Extractor interface. Maps button taps and a few canned phrases to structured
   observations. Must include: "still got" -> same, "better" -> better, "worse" -> worse,
   "comes and goes" -> intermittent, "gone" -> gone, "took medicine" -> self_treatment
   (item.confirmed false until the user taps Confirm), "noticed blood" -> redFlags.blood reported.
   Add "gone" to the Trajectory type. For policy rules treat "gone" like "better". The episode
   only becomes RESOLVED when policy.resolvedAfterSymptomFreeDays is set and met; while it is
   null the state is IMPROVING. Add unit tests for this.

3. CONVERSATION FLOW. src/core stays pure. Put the flow in src/conversation/.
   - Scenario mr_tan: mode supported, support person "Mei Ling". Scenario ms_lim: mode independent.
   - First message: Jaga asks "on my own, or add a trusted person?" (buttons). Then symptom
     mention, then the red-flag questions from the policy, then the clock starts.
   - When the simulated clock passes a check-in day (policy.checkinEveryDays), Jaga sends
     "Still coughing?" with buttons [Still got] [Better] [Gone].
   - If the clock is advanced past a check-in with no answer, record a "silence" observation.
     Silence is never "better".
   - On SEE_GP: show the rule's explain text, the source link, and a placeholder card
     labelled "PROTOTYPE DATA" that says care navigation arrives in M4.
   - On a red flag: direct plain instruction, no persona. In supported mode also add a
     transcript line "Mei Ling notified (as agreed)". In independent mode nobody is notified.
   - followUps ASK_CLARIFICATION: Jaga asks one neutral question to the user.
   - All user-facing strings live in src/copy/en.ts. Every check-in message ends with:
     "You can seek medical care at any time if you're concerned."
     Jaga never says "it's fine" or names a disease.

4. PAGE. web/index.html, web/style.css, web/app.js. Plain HTML, CSS, vanilla JS. No framework,
   no build step. Layout: phone-frame WhatsApp-style chat on the left; on the right a "Jaga Clock"
   panel and the controls.
   - Jaga Clock panel shows: mode, symptom, onset raw text, minimum duration in days,
     confidence, trajectory, state, red flags (reported / denied / unknown with who and when),
     self-treatment items with confirmed or unconfirmed, discordance, missed check-ins,
     policy id + version with a visible "PENDING CLINICIAN REVIEW" badge, last rule fired.
   - Controls: day slider 0 to 60 (forward only, plus a Reset button), "Next check-in" button,
     scenario switch (Mr Tan, supported / Ms Lim, independent), a "Speak as Mei Ling" toggle
     that is only enabled in supported mode, quick buttons: "Took medicine", "Noticed blood".
   - A permanent label near the slider: "Simulated clock. Time is compressed for the demo."
   - Large readable type, works at phone width, no horizontal scroll.

5. TESTS. API tests using the simulated clock: full Mr Tan run to SEE_GP; Ms Lim run reaches
   the same action on the same day as Mr Tan given the same answers (mode parity); silence
   stays unknown; red flag on day 9 then "no lah" on day 10 stays SEE_DOCTOR_TODAY;
   nothing is "notified" in independent mode.

6. `npm run dev` starts the server and prints the URL. Update README.

When done: run tests and timelines, commit as "M2 web demo", and report what changed, how to
run it, test results, and anything you disagreed with.
