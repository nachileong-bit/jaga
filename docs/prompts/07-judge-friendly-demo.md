# Prompt 07: make the web demo judge-friendly (scope card, 1-minute tour, reply chips)

You are working in the Jaga repo. Read web/index.html, web/app.js, web/style.css, src/copy/en.ts, src/conversation/flow.ts and src/server.ts first. Plain HTML/CSS/JS, no framework, no build step. Keep the WhatsApp look.

## Problem
A judge opening the demo does not know Jaga only covers a lingering cough, does not know what to try, and can get lost. The demo clock is fictional (it starts on 20 Feb 2026, just after Chinese New Year), so "since before CNY" = "at least 4 days" looks wrong unless the date is shown.

## Changes

1. Scope card, pinned at the top of #chat-body, styled like a WhatsApp system note (pale yellow, small rounded box, centred). `renderTranscript()` clears the chat, so re-insert the card at the top every render. Copy:
   - Title: "Try Jaga (hackathon prototype)"
   - "Covered now: a cough that won't go away."
   - "Coming next, after a doctor checks the rules: fever, mouth ulcer."
   - "Anything else, Jaga will say it can't help yet. It won't guess."
   - "Jaga is not a doctor and never diagnoses. Emergency? Call 995."
   - Buttons: "Start the 1-minute tour" (runs tour step 1) and "x".
   After the first tour step, the first message sent, or x, it collapses to a one-line pill "Covered: cough only · Tour" that re-opens it on tap. Keep that state in a JS variable only (every reload shows the full card).

2. Clock panel: next to the PENDING CLINICIAN REVIEW badge add a small badge "Covered: cough". Add a row at the top of the clock: "Today (demo date)" showing the simulated date, e.g. "Fri 20 Feb 2026", taken from the state. Add `simDate` (ISO string of the simulated "now") to the /api/demo state if it is not there.

3. Judge tour panel at the top of .side-panel, above the clock, titled "1-minute tour". Buttons run steps in order through the existing API calls (reset, sendMessage, advance). Add a `runSteps([...])` helper that awaits each call. While a step runs, disable all tour buttons and show "typing..." in #contact-status. Tick a step when done.
   1. "1. Start as Mr Tan": scenario mr_tan, reset, tap "Add a trusted person". Stops at "What's bothering you?".
   2. "2. Skip to the day-14 nudge": if the clock has not started: send "cough", tap "About a week ago", "No", "No". Then tap "Took medicine", "Correct", advance to the next check-in, tap "Still got". The GP nudge, the reason with its HealthHub link and the clinic card appear. Small hint under the button: "The cough started a week before day 0, so demo day 7 = cough day 14."
   3. "3. Book and see the GP summary": tap "Book appointment", then open the newest GP summary link (summary.html?sessionId=...) in a new tab (same tab on mobile).
   4. "4. Ask a question": send "Which cough medicine should I take?". Enabled only after the clock has started.
   5. "5. Try something not covered": reset Mr Tan, tap "Add a trusted person", send "I have a fever".
   6. "6. Try a warning sign": scenario ms_lim, reset, tap "On my own", send "cough", tap "A few days ago", tap "Yes" (blood). Hint: "Then tap Yes to the next question to see the 995 reply."
   Put the existing Reset, slider, Next check-in and Mei Ling controls under a heading "Manual controls" below the tour.

4. Suggested-reply chips: only when the last Jaga message is the ask-symptom message, replace the quick buttons row with chips that call sendMessage(text):
   - "Cough 3 weeks already, got phlegm"
   - "Cough on and off since last month"
   - "I have a fever" (small grey tag "not covered")
   - "Cut my finger" (small grey tag "not covered")
   Otherwise show the normal "Took medicine / Noticed blood" buttons.

5. Copy in src/copy/en.ts:
   - GREETING: "Hello, I'm Jaga 🐾 I keep count of a cough that won't go away, and tell you when it's time to see a GP. Right now I only cover cough. I'm not a doctor and I don't diagnose."
   - ASK_SYMPTOM: "Tell me about your cough, in your own words. For example: \"cough 3 weeks, got phlegm\". Other symptoms aren't covered yet."
   Update any tests that check the old wording.

6. Mobile (max-width 768px):
   - The tour becomes a sticky horizontal strip of numbered pills ("1 Start", "2 Day 14", "3 GP summary", "4 Ask", "5 Not covered", "6 Warning") directly above the phone frame.
   - Chips scroll sideways in one row, each tap target at least 40px high.
   - After each tour step scroll the chat into view.
   - The clock panel collapses behind a "Show Jaga Clock" toggle.
   - summary.html gets a "Back to the demo" link at the top.

7. Tests: add vitest tests for the copy changes and for `simDate` in the state. Run `npm test` and `npm run timelines`. All must pass. Do not change any policy file or threshold. Do not commit.
