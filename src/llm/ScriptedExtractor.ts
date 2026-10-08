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

// Default base date = the Jaga demo clock start (day 0).
const DEFAULT_BASE = "2026-02-20T08:00:00.000Z";

// Month names for "since September" style parsing. Count from the 1st of
// that month, approximate.
const MONTH_NAMES: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

export function extractOnset(text: string, nowIso?: string): OnsetMatch | null {
  const base = nowIso ?? DEFAULT_BASE;

  // "before CNY" / "since before CNY" / "since CNY" / "since Chinese New Year"
  // CNY 2026 was 17 Feb. "before CNY" -> latest = 16 Feb. "since CNY" -> 17 Feb.
  const cnySinceMatch = text.match(/\bsince\s+(cny|chinese new year)\b/i);
  if (cnySinceMatch) {
    return {
      rawText: cnySinceMatch[0].trim(),
      latestPossible: "2026-02-17T08:00:00.000Z",
      confidence: "approximate",
    };
  }
  const cnyBeforeMatch = text.match(/(since\s+)?before\s+(cny|chinese new year)/i);
  if (cnyBeforeMatch) {
    return {
      rawText: cnyBeforeMatch[0].trim(),
      latestPossible: "2026-02-16T08:00:00.000Z",
      confidence: "approximate",
    };
  }

  const lower = text.toLowerCase();

  // "since <MonthName>" e.g. "since September" -> 1st of that month
  const sinceMonthMatch = lower.match(/\bsince\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/);
  if (sinceMonthMatch) {
    const monthName = sinceMonthMatch[1];
    const monthIdx = MONTH_NAMES[monthName];
    const baseDate = new Date(base);
    const year = baseDate.getUTCFullYear();
    const target = new Date(Date.UTC(year, monthIdx, 1, 8, 0, 0));
    // If the 1st of that month is after the base date, it must be last year.
    if (target.getTime() > baseDate.getTime()) {
      target.setUTCFullYear(year - 1);
    }
    return {
      rawText: sinceMonthMatch[0].trim(),
      latestPossible: target.toISOString(),
      confidence: "approximate",
    };
  }

  // "3 weeks" / "2 weeks" / "three weeks"
  let m = lower.match(/\b(\d+)\s+weeks?\b/);
  if (m) {
    const weeks = parseInt(m[1], 10);
    return {
      rawText: m[0],
      latestPossible: isoDaysAgoFromBase(weeks * 7, base),
      confidence: "approximate",
    };
  }
  m = lower.match(/\bthree\s+weeks?\b/);
  if (m) {
    return {
      rawText: m[0],
      latestPossible: isoDaysAgoFromBase(21, base),
      confidence: "approximate",
    };
  }

  // "few weeks" -> approximate 2-3 weeks, use 14 days as a conservative min
  if (/\bfew\s+weeks?\b/.test(lower)) {
    return {
      rawText: matchPhrase(lower, ["few weeks", "a few weeks"]),
      latestPossible: isoDaysAgoFromBase(14, base),
      confidence: "approximate",
    };
  }

  // "since last week" / "last week" / "a week ago" / "about a week ago"
  if (/\b(since\s+last\s+week|last\s+week|about\s+a\s+week\s+ago|a\s+week\s+ago)\b/.test(lower)) {
    return {
      rawText: matchPhrase(lower, ["about a week ago", "since last week", "last week", "a week ago"]),
      latestPossible: isoDaysAgoFromBase(7, base),
      confidence: "approximate",
    };
  }

  // "yesterday" -> 1 day ago
  if (/\byesterday\b/.test(lower)) {
    return {
      rawText: "yesterday",
      latestPossible: isoDaysAgoFromBase(1, base),
      confidence: "approximate",
    };
  }

  // "this morning" -> 0 days (today)
  if (/\bthis\s+morning\b/.test(lower)) {
    return {
      rawText: "this morning",
      latestPossible: base,
      confidence: "approximate",
    };
  }

  // "1 month" / "since last month" / "a month" / "a month ago" / "last month"
  if (/\b(\d+\s+months?|since\s+last\s+month|a\s+month\b|a\s+month\s+ago|last\s+month)\b/.test(lower)) {
    const mm = lower.match(/\b(\d+)\s+months?\b/);
    const months = mm ? parseInt(mm[1], 10) : 1;
    return {
      rawText: mm ? mm[0] : matchPhrase(lower, ["since last month", "last month", "a month ago", "a month"]),
      latestPossible: isoDaysAgoFromBase(months * 30, base),
      confidence: "approximate",
    };
  }

  // "a few days" / "since a few days" / "few days"
  if (/\b(a\s+few\s+days|few\s+days)\b/.test(lower)) {
    return {
      rawText: matchPhrase(lower, ["a few days", "few days"]),
      latestPossible: isoDaysAgoFromBase(2, base),
      confidence: "approximate",
    };
  }

  return null;
}

function matchPhrase(lower: string, phrases: string[]): string {
  for (const p of phrases) {
    if (lower.includes(p)) return p;
  }
  return phrases[0];
}

/** Compute an ISO date `days` before the given base ISO string. */
function isoDaysAgoFromBase(days: number, baseIso: string): string {
  return new Date(new Date(baseIso).getTime() - days * 86_400_000).toISOString();
}

// Warning-sign phrases. Kept broad on purpose: a false alarm costs a question,
// a missed one could cost much more.
const BLOOD_REPORT =
  /\b(noticed|saw|see|got|have|has|had|there'?s|with|some|spit|spat|coughing|coughed|cough(ing)? up|cough out)\b[^.?!]{0,20}\bblood|\bblood(y)?\b[^.?!]{0,25}\b(cough|phlegm|spit|sputum|mucus)|\b(bloody|pink frothy|blood[- ]stained|blood[- ]streaked)\b[^.?!]{0,15}\b(phlegm|sputum|mucus|spit)|\b(batuk\s+darah|darah\s+.*\bbatuk|batuk\s+.*\bdarah)\b/i;
// Phrases where "blood" is NOT about coughing blood (Bug 1: false alarm).
const NON_BLOOD_REPORT =
  /\b(blood\s+pressure|blood\s+test|blood\s+sugar|blood\s+donation|donated\s+blood|blood\s+thinner|high\s+blood|bp)\b/i;
const NEGATED_BLOOD =
  // The negation must directly describe the blood ("no blood", "didn't see any blood",
  // "no got blood"). Fillers like "no lah, got blood" are NOT a denial.
  /\b(no|not|never|didn'?t|don'?t|haven'?t|hasn'?t|without|nope)(\s+(any|see|seen|saw|notice|noticed|spot|spotted|find|found|got|have|had))*\s+blood\b/;
const BREATHLESS_REPORT =
  /\b(breathless|out of breath|short(ness)? of breath|can'?t breathe|cannot breathe|hard to breathe|difficult(y)? (to )?breath(e|ing)|trouble breathing|chest (pain|hurts|tight)|tight(ness)? (in (my|the) )?chest|pain in (my|the) chest)/;
// "not breathless but chest pain" must still report breathless_or_chest_pain.
// Only suppress when the whole phrase is a clear denial (e.g. "no chest pain",
// "not short of breath"). If there is a "but"/"however"/"though" that introduces
// the symptom, it is still a report.
const BREATHLESS_DENIAL_WITH_OVERRIDE =
  /\b(no|not|never|didn'?t|don'?t|haven'?t|hasn'?t|without|nope)\b[^.?!]{0,15}\b(breathless|out of breath|short(ness)? of breath|chest)\b[^.?!]{0,10}\b(but|however|though)\b/i;
const BREATHLESS_DENIAL =
  /\b(no|not|never|didn'?t|don'?t|haven'?t|hasn'?t|without|nope)\b[^.?!]{0,15}\b(breathless|out of breath|short(ness)? of breath|chest)/i;

// Bug 3: effort-only breathlessness (stairs, walking, climbing, exercise,
// "a bit breathless", "slightly breathless") is SEE_DOCTOR_TODAY, not 995.
const BREATHLESS_EFFORT_ONLY =
  /\b(a\s+bit\s+breathless|slightly\s+breathless|breathless\s+(when|on|after|if)\s+(climb|walking|stairs|exercise|exert)|breathless\s+on\s+(stairs|walking|climbing|effort|exertion)|on\s+effort|on\s+exertion|climb(?:ing)?\s+stairs)\b/i;

// New "see a GP soon" warning signs (action SEE_GP, sticky, source HealthHub Cough)
const HIGH_FEVER_REPORT = /(\bfever\s+(3[89](\.\d+)?|39(\.\d+)?)\b|\btemperature\s+(above|over|higher than)\s+38\.6\b|\b(high\s+fever)\b)/i;
const WEIGHT_LOSS_REPORT = /\b(lost\s+weight|losing\s+weight|weight\s+loss|lost\s+some\s+weight)\b/i;
const NIGHT_SWEATS_REPORT = /\b(night\s+sweats?|sweating\s+at\s+night|sweats?\s+at\s+night)\b/i;
const COLOURED_PHLEGM_REPORT = /\b(yellow\s+phlegm|green\s+phlegm|thick\s+yellow|thick\s+green)\b/i;
const WHEEZING_REPORT = /\b(wheezing|wheezy|wheeze)\b/i;

export class ScriptedExtractor implements Extractor {
  extract(input: ExtractorInput): ExtractedObservation[] {
    const results: ExtractedObservation[] = [];
    const text = (input.text ?? "").trim();
    const button = (input.button ?? "").trim();
    const lower = text.toLowerCase();

    // 1. Button tap -> trajectory check-in
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

    // 3. "took medicine" -> self_treatment (item.confirmed = false until Confirm tapped)
    //    Item 10: "I took medicine" is the new label; keep "Took medicine" working.
    if (
      button === "Took medicine" ||
      button === "I took medicine" ||
      lower.includes("took medicine") ||
      lower.includes("i took medicine") ||
      lower.includes("took cough syrup") ||
      lower.includes("took some medicine") ||
      lower.includes("took a pill")
    ) {
      results.push({
        kind: "self_treatment",
        item: { label: "Cough syrup", confirmed: false },
        rawText: button === "Took medicine" ? "Took medicine" : button === "I took medicine" ? "I took medicine" : text,
      });
    }

    // 4. "Confirm" button -> confirm the most recent self_treatment item
    if (button === "Confirm") {
      results.push({
        kind: "self_treatment",
        item: { label: "Confirmed", confirmed: true },
        rawText: "Confirm",
      });
    }

    // 5. Blood: reported or denied. A negation only counts as a denial when it
    //    is specifically about blood ("no blood", "didn't see blood").
    //    "no lah" anywhere no longer means "no blood".
    //    Bug 1: never treat "blood pressure", "blood test", etc. as blood reports.
    const bloodNegated = NEGATED_BLOOD.test(lower);
    if (button === "Noticed blood" || (!bloodNegated && BLOOD_REPORT.test(lower) && !NON_BLOOD_REPORT.test(lower))) {
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
    // Bug 3: effort-only breathlessness (stairs, walking, "a bit breathless")
    // is a separate key (breathless_effort) with SEE_DOCTOR_TODAY urgency.
    // "not breathless but chest pain" must report breathless_or_chest_pain.
    if (BREATHLESS_REPORT.test(lower) && !BREATHLESS_DENIAL.test(lower)) {
      const key = BREATHLESS_EFFORT_ONLY.test(lower) ? "breathless_effort" : "breathless_or_chest_pain";
      results.push({
        kind: "redflag_answer",
        redFlags: { [key]: "reported" },
        rawText: text,
      });
    } else if (BREATHLESS_REPORT.test(lower) && BREATHLESS_DENIAL_WITH_OVERRIDE.test(lower)) {
      results.push({
        kind: "redflag_answer",
        redFlags: { breathless_or_chest_pain: "reported" },
        rawText: text,
      });
    }

    // 6c. New "see a GP soon" warning signs (sticky, action SEE_GP from the policy).
    const newFlags: Record<string, "reported"> = {};
    if (HIGH_FEVER_REPORT.test(lower)) {
      // Make sure it's actually a high fever: a number of 38.6 or below is not.
      let isHigh = true;
      const feverNumMatch = lower.match(/\bfever\s+(\d{2}(\.\d+)?)\b/i);
      if (feverNumMatch) {
        const temp = parseFloat(feverNumMatch[1]);
        if (temp <= 38.6) isHigh = false;
      }
      if (isHigh) newFlags.high_fever = "reported";
    }
    if (WEIGHT_LOSS_REPORT.test(lower)) newFlags.weight_loss = "reported";
    if (NIGHT_SWEATS_REPORT.test(lower)) newFlags.night_sweats = "reported";
    if (COLOURED_PHLEGM_REPORT.test(lower)) newFlags.coloured_phlegm = "reported";
    if (WHEEZING_REPORT.test(lower)) newFlags.wheezing = "reported";

    if (Object.keys(newFlags).length > 0) {
      results.push({
        kind: "redflag_answer",
        redFlags: newFlags,
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
