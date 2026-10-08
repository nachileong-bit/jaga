// src/llm/ScriptedExtractor.ts
// Stands in for the LLM until M3. Maps button taps and a few canned phrases
// to structured observations. No network, no AI — just keyword matching.

import type {
  ExtractedObservation,
  Extractor,
  ExtractorInput,
} from "./Extractor.js";
import type { Trajectory } from "../core/types.js";

// Button -> trajectory mapping
const BUTTON_TRAJECTORY: Record<string, Trajectory> = {
  "Still got": "same",
  Better: "better",
  Gone: "gone",
  Worse: "worse",
  "Comes and goes": "intermittent",
};

// Phrase -> trajectory mapping (case-insensitive substring match)
const PHRASE_TRAJECTORY: Array<{ phrases: string[]; trajectory: Trajectory }> = [
  { phrases: ["still got", "still have it", "still there", "still coughing"], trajectory: "same" },
  { phrases: ["better", "improving", "getting better"], trajectory: "better" },
  { phrases: ["worse", "getting worse", "deteriorating"], trajectory: "worse" },
  { phrases: ["comes and goes", "on and off", "intermittent"], trajectory: "intermittent" },
  { phrases: ["gone", "all gone", "cleared up", "no more"], trajectory: "gone" },
];

// Onset phrase recognition (spec rule 3: never invent precision)
// Maps a time phrase in the user's text to a latestPossible ISO date.
export interface OnsetMatch {
  rawText: string;
  latestPossible: string;
  confidence: "approximate";
}

export function extractOnset(text: string): OnsetMatch | null {
  // "before CNY" / "before Chinese New Year": CNY 2026 is 17 Feb, so the latest
  // possible onset is 16 Feb. rawText is always the user's OWN words (spec rule 3).
  const match = text.match(/(since\s+)?before\s+(cny|chinese new year)/i);
  if (match) {
    return {
      rawText: match[0].trim(),
      latestPossible: "2026-02-16T08:00:00.000Z",
      confidence: "approximate",
    };
  }
  return null;
}

// Warning-sign phrases. Kept broad on purpose: a false alarm costs a question,
// a missed one could cost much more.
const BLOOD_REPORT =
  /\b(noticed|saw|see|got|have|has|had|there'?s|with|some|spit|spat|coughing|coughed|cough(ing)? up|cough out)\b[^.?!]{0,20}\bblood|\bblood(y)?\b[^.?!]{0,25}\b(cough|phlegm|spit|sputum|mucus)|\b(bloody|pink frothy|blood[- ]stained|blood[- ]streaked)\b[^.?!]{0,15}\b(phlegm|sputum|mucus|spit)/;
const NEGATED_BLOOD =
  /\b(no|not|never|didn'?t|don'?t|haven'?t|hasn'?t|without|nope)\b[^.?!]{0,20}\bblood/;
const BREATHLESS_REPORT =
  /\b(breathless|out of breath|short(ness)? of breath|can'?t breathe|cannot breathe|hard to breathe|difficult(y)? (to )?breath(e|ing)|trouble breathing|chest (pain|hurts|tight)|tight(ness)? (in (my|the) )?chest|pain in (my|the) chest)/;
const NEGATED_BREATHLESS =
  /\b(no|not|never|didn'?t|don'?t|haven'?t|hasn'?t|without|nope)\b[^.?!]{0,15}\b(breathless|out of breath|short(ness)? of breath|chest)/;

export class ScriptedExtractor implements Extractor {
  extract(input: ExtractorInput): ExtractedObservation[] {
    const results: ExtractedObservation[] = [];
    const text = (input.text ?? "").trim();
    const button = (input.button ?? "").trim();
    const lower = text.toLowerCase();

    // 1. Button tap → trajectory check-in
    if (button && BUTTON_TRAJECTORY[button]) {
      results.push({
        kind: "checkin",
        trajectory: BUTTON_TRAJECTORY[button],
        rawText: button,
      });
    }

    // 2. Phrase-based trajectory
    if (text) {
      for (const { phrases, trajectory } of PHRASE_TRAJECTORY) {
        if (phrases.some((p) => lower.includes(p))) {
          // Only add if not already covered by the button
          const alreadyHas = results.some(
            (r) => r.trajectory === trajectory
          );
          if (!alreadyHas) {
            results.push({
              kind: "checkin",
              trajectory,
              rawText: text,
            });
          }
          break;
        }
      }
    }

    // 3. "took medicine" → self_treatment (item.confirmed = false until Confirm tapped)
    if (
      button === "Took medicine" ||
      lower.includes("took medicine") ||
      lower.includes("took cough syrup") ||
      lower.includes("took some medicine") ||
      lower.includes("took a pill")
    ) {
      results.push({
        kind: "self_treatment",
        item: { label: "Cough syrup", confirmed: false },
        rawText: button === "Took medicine" ? "Took medicine" : text,
      });
    }

    // 4. "Confirm" button → confirm the most recent self_treatment item
    if (button === "Confirm") {
      // The caller (conversation flow) handles confirmation by updating
      // the existing observation. Here we just signal it.
      results.push({
        kind: "self_treatment",
        item: { label: "Confirmed", confirmed: true },
        rawText: "Confirm",
      });
    }

    // 5 and 6. Blood: reported, or denied. A negation near "blood" is a denial,
    // anything else that pairs blood with coughing or phlegm is a report.
    const bloodNegated = NEGATED_BLOOD.test(lower) || lower.includes("no lah");
    if (button === "Noticed blood" || (!bloodNegated && BLOOD_REPORT.test(lower))) {
      results.push({
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
        rawText: button === "Noticed blood" ? "Noticed blood" : text,
      });
    } else if (bloodNegated) {
      results.push({
        kind: "redflag_answer",
        redFlags: { blood: "denied" },
        rawText: text,
      });
    }

    // 6b. Breathless or chest pain, in free text. Only reports are read here;
    // a denial still needs the Yes / No question.
    if (BREATHLESS_REPORT.test(lower) && !NEGATED_BREATHLESS.test(lower)) {
      results.push({
        kind: "redflag_answer",
        redFlags: { breathless_or_chest_pain: "reported" },
        rawText: text,
      });
    }

    // 7. If nothing was extracted but there is text, treat it as a mention
    if (results.length === 0 && text) {
      results.push({
        kind: "mention",
        rawText: text,
      });
    }

    // 8. If nothing was extracted and no text/button, return a mention with empty text
    //    (shouldn't normally happen, but keeps the flow safe)
    if (results.length === 0 && !text && !button) {
      results.push({
        kind: "mention",
        rawText: "",
      });
    }

    return results;
  }
}
