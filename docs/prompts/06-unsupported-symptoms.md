# Prompt 06: honest handling of symptoms Jaga does not cover yet

You are working in the Jaga repo. Read src/conversation/flow.ts (onSymptom, handleMessage), src/copy/en.ts, src/llm/ScriptedExtractor.ts and tests/unit/apiTests.test.ts first.

## Problem
In the web demo and on WhatsApp, whatever symptom the person types becomes a cough episode. "fever", "I cut my finger" or "my finger is swollen" are treated as a cough, and Jaga then asks "Have you noticed any blood when you cough?". That is wrong and confusing.

## Goal
Jaga only tracks a lingering cough in this prototype. For anything else it must say so plainly, never guess, and point to the right help. Emergency words are always caught first.

## Changes
1. New `src/conversation/symptomScope.ts`:
   - `isCoughMention(text)`: true for cough, coughing, coughed, batuk, kahak, phlegm, "throat itchy and cough" style phrases. Case-insensitive.
   - `isEmergencyMention(text)`: true for these signs (based on the MOH "Getting medical help" emergency list and SCDF's 995 examples): bleeding a lot / won't stop bleeding / heavy bleeding, can't breathe / cannot breathe / difficulty breathing / short of breath / breathless, chest pain, fainted / unconscious / passed out, seizure / fit, sudden confusion, sudden weakness or numbness, face drooping, vomiting blood, coughing blood. Negations ("no chest pain", "not breathless") must not count.
2. `src/copy/en.ts` add (plain text, no emoji, no sticker, no em dashes):
   - `NOT_COVERED_YET`: "Right now I can only keep count for a cough that won't go away. Other symptoms, like fever, cuts or swelling, aren't covered yet, so I won't guess. If you're worried, a GP or pharmacist can help, and the NurseFirst helpline is 6262 6262 for advice that is not an emergency. If it's an emergency, call 995. Is there a cough you'd like me to keep count of?"
   - `EMERGENCY_NOW`: "That sounds like it could be an emergency. Call 995 now, or go to the nearest emergency department."
3. `src/conversation/flow.ts`:
   - In `handleMessage`, before routing, when there is no episode yet and the person typed text: if `isEmergencyMention(text)` say `EMERGENCY_NOW` and stop (stay on the current step).
   - In `onSymptom`: if the text is not a cough mention, say `NOT_COVERED_YET`, keep `pending = "symptom"`, create no episode, and return. Never ask the cough warning-sign questions for a non-cough symptom.
   - If the text mentions a cough AND something else (for example "fever and cough"), track the cough as today.
4. Tests (vitest, new file tests/unit/symptomScope.test.ts):
   - "fever", "I cut my finger", "my finger is swollen", "headache" each get NOT_COVERED_YET, no episode, no question about blood when coughing, phase stays "symptom".
   - After that, "cough since before CNY" starts the normal cough flow.
   - "fever and cough for 2 weeks" starts the cough flow.
   - "my finger is bleeding a lot and won't stop", "I can't breathe", "chest pain" before any episode get EMERGENCY_NOW.
   - "no chest pain, just a cough" starts the cough flow and does NOT get EMERGENCY_NOW.
   - NOT_COVERED_YET and EMERGENCY_NOW contain no emoji and no sticker follows them.
5. Run `npm test` and `npm run timelines`. All must pass. Do not change any policy file or threshold. Do not commit.
