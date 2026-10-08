# Prompt 09: fixes from an older-adult UX review and a judge walkthrough

You are working in the Jaga repo after prompt 08. Read src/llm/ScriptedExtractor.ts, src/conversation/flow.ts, src/copy/en.ts, knowledge/kb.json, web/app.js, web/style.css first. Keep every policy PENDING_CLINICIAN_REVIEW. No em dashes in any copy.

## Bugs found by testers on the live demo

1. False alarm: "Can my blood pressure medicine cause cough?" was recorded as "blood: reported". In ScriptedExtractor, never treat these as blood reports: blood pressure, blood test, blood sugar, blood donation, donated blood, blood thinner, high blood, BP. Add tests for each, plus "coughing blood" and "blood in my phlegm" still reporting.

2. Wrong day on a warning sign: the clock panel showed "blood: reported by user on day 50" on day 0. The reportedAt day must be the simulated demo day. Fix and test.

3. Over-triage of mild breathlessness: "a bit breathless when climb stairs" got "Call 995 now". Split the breathless sign:
   - Breathless at rest, can't breathe, struggling to breathe, chest pain or chest tightness: EMERGENCY_995 (as now).
   - Breathless only on effort (stairs, walking, climbing, exercise, "a bit breathless", "slightly breathless"): SEE_DOCTOR_TODAY, message "Feeling breathless with a cough should be checked by a doctor today. If it gets worse, or you feel breathless at rest or have chest pain, call 995. For advice, NurseFirst is on 6262 6262." Source: HealthHub Cough ("difficulty breathing ... see a doctor"). Mark the split "needs clinician confirmation" in the policy explain.

4. Mixed messages after an emergency: after a 995 or emergency-department message, do NOT send "Thanks. I've started counting..." or a sticker in the same turn. Hold routine check-ins until the person replies. The next routine check-in first asks "Did you get checked?" with Yes / Not yet.

5. Unanswered warning-sign question: if a warning-sign question is still unanswered when the next check-in comes, ask it again first, before "Still coughing?". After 2 unanswered check-ins in Supported mode, draft a message to the trusted person (shown to the user first, like other shares).

6. Knowledge base miss: "What can I take for cough ah" must return the cough_medicine answer. Add keywords "take", "eat", "can take", "what to take" to that entry and make the lookup ignore Singlish particles (lah, ah, leh, lor, meh, hor). Test it.

7. Chinese, Malay or Tamil text gets no reply. If the message has Chinese characters or is clearly not English, reply: "Sorry, I can only read English for now. 抱歉，我目前只看得懂英文。Maaf, buat masa ini saya hanya faham Bahasa Inggeris." Keep the step where it was. Test it.

7b. Nudge at intake: if a rule already fires when the clock starts (for example "cough 3 weeks already" meets three_weeks_any), show the GP nudge, the reason with its source and the clinic card right after the warning-sign questions. Do not wait for the next check-in. Test: "cough 3 weeks already", No, No gives the nudge on day 0.

7c. Most urgent sign wins: when a new warning sign is reported, the message must be for the most urgent sign reported so far (EMERGENCY_995 above SEE_DOCTOR_TODAY above SEE_GP). Test: "fever 39 since yesterday" then "no lah, got blood in phlegm" gives the blood emergency message. Repeating the same message for a sign that was already reported is not allowed; if nothing new was reported, answer the message normally.

## Older-adult readability (web demo)

8. Chat text 18px, line height 1.5. Reply buttons at least 48px tall, 17px text, full-width on phones. Keep the WhatsApp look.
9. After a button is tapped, grey out and disable all buttons in that same message and older messages, so only the newest buttons can be pressed.
10. Button wording: "Took medicine" becomes "I took medicine" (keep the old label working for tests and WhatsApp numbered replies).

## Tests and checks
11. Add vitest tests for every item above. Run `npm test` and `npm run timelines`. All must pass. Do not change thresholds other than item 3. Do not commit.
