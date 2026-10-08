# Prompt 08: fixes from a GP safety review

You are working in the Jaga repo. Read policies/cough.json, policies/mouth_ulcer.json, knowledge/kb.json, src/core/policyEvaluator.ts, src/core/redFlagScreen.ts, src/llm/ScriptedExtractor.ts, src/conversation/flow.ts, src/conversation/symptomScope.ts, src/copy/en.ts and web/knowledge.html first. Every medical rule must cite a source that is already in knowledge/kb.json or listed below. Keep every policy status PENDING_CLINICIAN_REVIEW. Bump policy versions to 0.2.0.

Verified sources (checked 9 Oct 2026):
- HealthHub Cough (reviewed 8 Jan 2026) https://www.healthhub.sg/a-z/diseases-and-conditions/cough : see a doctor if not better in 2 weeks with self-treatment, gets worse, or lasts more than 8 weeks; also thick yellow or green phlegm, fever higher than 38.6°C, weight loss, a large amount of phlegm or bloody or pink frothy phlegm, night sweats, difficulty breathing, wheezing or chest pains.
- HealthHub Tuberculosis (reviewed 8 May 2026) https://www.healthhub.sg/a-z/diseases-and-conditions/tuberculosis : "If you have a cough that persists longer than three weeks ... see your doctor immediately."
- HealthHub Fever (reviewed 8 Jan 2026) https://www.healthhub.sg/a-z/diseases-and-conditions/fever : adults: 37.5°C and above is a fever, above 38.5°C is a high fever; see a doctor if high fever, fever lasts more than 5 days, pregnant, or on medicine that suppresses the immune system, or other concerning symptoms (severe headache, severe sore throat, rash, confusion, fits, pain when urinating, severe neck pain and others).
- HealthHub Mouth Ulcer (reviewed 8 Jan 2026) https://www.healthhub.sg/a-z/diseases-and-conditions/mouth-ulcers : see a doctor if not better after 7 days of treatment with gels or mouthwash, not healed within 14 days without treatment, worse during self-treatment, fever or rash, or ulcers very often.
- MOH Getting medical help https://www.moh.gov.sg/seeking-healthcare/getting-medical-help/ : coughing or vomiting of blood is a sign of a medical emergency (go to the emergency department).

## Changes

1. policies/cough.json
   - New rule `three_weeks_any`: minDurationDays 21, any self-treatment, trajectory not "gone" -> SEE_GP. explain: "Your cough has lasted more than three weeks. Please see a GP." Source: HealthHub Tuberculosis (add it to the policy's sources).
   - Rules `worsening` and `long_duration`: change explain to start with "Please see a GP." instead of "Consider seeing a GP."
   - Red flag `blood`: action EMERGENCY_995. Its message (in copy) becomes: "Coughing up blood can be serious. Go to the nearest emergency department now. If there is a lot of blood or you are breathless, call 995." Source: MOH Getting medical help.
   - New "see a GP soon" warning signs (action SEE_GP, sticky like other red flags, source HealthHub Cough): `high_fever` (fever above 38.6°C), `weight_loss`, `night_sweats`, `coloured_phlegm` (thick yellow or green phlegm), `wheezing`. Message: "With a cough, HealthHub says <sign> should be checked by a doctor. Please see a GP in the next day or two." No sticker, no emoji.
2. policies/mouth_ulcer.json: match HealthHub exactly. Rules: not healed in 14 days without treatment; not better after 7 days of gels or mouthwash (needs self-treatment); getting worse; fever or rash -> SEE_GP. Remove the 21-day rule and the unsourced "spreading or growing" red flag. Keep "difficulty swallowing or breathing" as EMERGENCY_995 but mark its explain "Warning sign list needs clinician review".
3. src/llm/ScriptedExtractor.ts
   - Remove the rule that "no lah" anywhere means "no blood". A denial only counts when it is about blood ("no blood", "didn't see blood"). An unclear or mixed answer to a warning-sign question must re-ask, never record "denied".
   - "not breathless but chest pain" must report breathless_or_chest_pain.
   - Recognise Malay "batuk darah" and "darah" with batuk as blood.
   - Detect the five new signs in free text: "fever 39", "fever 38.7", "temperature above 38.6", "high fever", "lost weight", "losing weight", "night sweats", "sweating at night", "yellow phlegm", "green phlegm", "wheezing", "wheezy". A fever number of 38.6 or below is not high_fever.
   - Onset parsing: "since last week", "a week ago", "2 weeks", "3 weeks", "three weeks", "1 month", "since last month", "a few days" give a minimum day count (rawText stays the person's own words, confidence "approximate"). Keep the CNY rule.
4. src/conversation/flow.ts
   - At every weekly check-in, after "Still got", ask once: "Since we last spoke, any blood when you cough, breathlessness or chest pain?" with Yes / No. Yes leads to the existing warning-sign questions. No continues as today.
   - After the clock has started, if a message mentions fever without a number, reply with the HealthHub cough answer about fever (from the knowledge base, with its link) and record nothing. If it mentions a non-cough symptom (cut, rash, swelling, headache...) reply NOT_COVERED_YET. Never reply "Noted." to those.
   - "Not now" for the clinic card must still let Jaga speak again if the cough gets worse or a warning sign appears.
5. src/copy/en.ts
   - SEE_GP_INTRO: remove "Most of the time it is nothing serious." Use "A doctor can check what is going on."
   - Knowledge base answer when_995: add "If it gets worse, see a GP." at the end.
6. knowledge/kb.json: add entries (with sources above): `cough_three_weeks` (HealthHub Tuberculosis), `fever_adult_when_doctor` (HealthHub Fever, adults only, topic "care"), and update mouth ulcer entries if needed. Add the Tuberculosis and Fever pages to sources with sourceReviewed dates above and checkedByJaga "2026-10-09".
7. web/knowledge.html: add a "Clinical safety" box at the top:
   - "Jaga does not diagnose. Fixed rules copied from HealthHub and MOH decide when to nudge. AI never decides how urgent something is."
   - "Warning signs are checked first and at every check-in. Coughing blood, trouble breathing or chest pain always point to emergency care."
   - "These rules are a prototype waiting for review by a Singapore-registered doctor. For adults only. If you're worried, see a GP or call NurseFirst on 6262 6262. In an emergency, call 995."
8. Tests (vitest): one test per change above, including: 21-day rule fires without medicine; blood gives the emergency message; "no lah, got blood in phlegm" reports blood; "fever 39" reports high_fever but "fever 38.2" does not; "cough 3 weeks already" gives at least 21 days; check-in asks the warning-sign question; "fever" after the clock starts gives the sourced fever answer, not "Noted."; no em dashes in copy; every rule and kb entry cites a source with an https link. Update existing tests and timelines only where the new rules change the expected result, and explain each change in your summary.
9. Run `npm test` and `npm run timelines`. All must pass. Do not commit.
