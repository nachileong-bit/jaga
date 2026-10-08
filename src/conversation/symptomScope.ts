// src/conversation/symptomScope.ts
// Jaga only tracks a lingering cough in this prototype. Anything else gets a
// plain "not covered yet" reply. Emergency signs are always caught first.

const COUGH_PATTERNS: RegExp[] = [
  /\bcough\b/i,
  /\bcoughing\b/i,
  /\bcoughed\b/i,
  /\bbatuk\b/i, // Malay for cough
  /\bkahak\b/i, // Malay for phlegm
  /\bphlegm\b/i,
  /\bsputum\b/i,
  /\bmucus\b/i,
  // "throat itchy and cough" style phrases
  /\bthroat\b[^.?!]{0,20}\bcough\b/i,
  /\bcough\b[^.?!]{0,20}\bthroat\b/i,
];

const EMERGENCY_PATTERNS: RegExp[] = [
  // Bleeding a lot / won't stop bleeding / heavy bleeding
  /\bbleeding\s+(a\s+lot|heavily|won'?t\s+stop|wont\s+stop)\b/i,
  /\b(heavy|a\s+lot\s+of)\s+bleeding\b/i,
  /\bwon'?t\s+stop\s+bleeding\b/i,
  /\bcannot\s+stop\s+bleeding\b/i,
  // Can't breathe / cannot breathe / difficulty breathing / short of breath / breathless
  /\bcan'?t\s+breathe\b/i,
  /\bcannot\s+breathe\b/i,
  /\bdifficult(y)?\s+breath(e|ing)\b/i,
  /\bshort\s+of\s+breath\b/i,
  /\bbreathless\b/i,
  /\bout\s+of\s+breath\b/i,
  // Chest pain
  /\bchest\s+pain\b/i,
  // Fainted / collapsed / unconscious / passed out
  /\bfainted\b/i,
  /\bunconscious\b/i,
  /\bcollapsed\b/i,
  /\bpassed\s+out\b/i,
  // Can't wake / cannot wake
  /\bcan'?t\s+wake\b/i,
  /\bcannot\s+wake\b/i,
  // Seizure / fit
  /\bseizure\b/i,
  /\bfit\b/i,
  // Heart attack
  /\bheart\s+attack\b/i,
  // Stroke
  /\bstroke\b/i,
  // Sudden confusion
  /\bsudden\s+confusion\b/i,
  // Sudden weakness or numbness
  /\bsudden\s+(weakness|numbness)\b/i,
  // Face drooping
  /\bface\s+drooping\b/i,
  // Vomiting blood
  /\bvomiting\s+blood\b/i,
  /\bvomit\s+blood\b/i,
  // Coughing blood
  /\bcoughing\s+(up\s+)?blood\b/i,
  /\bcoughed\s+(up\s+)?blood\b/i,
];

// Effort-only breathlessness (stairs, walking, "a bit breathless") is
// SEE_DOCTOR_TODAY, not an emergency. Must NOT count as an emergency.
const EFFORT_BREATHLESS_PATTERN =
  /\b(a\s+bit\s+breathless|slightly\s+breathless|breathless\s+(when|on|after|if)\s+(climb|walking|stairs|exercise|exert)|breathless\s+on\s+(stairs|walking|climbing|effort|exertion)|on\s+effort|on\s+exertion|climb(?:ing)?\s+stairs)\b/i;

const NEGATION_PATTERN =
  /\b(no|not|never|didn'?t|don'?t|doesn'?t|haven'?t|hasn'?t|without|nope)\b/i;

// Non-cough symptom words. When the clock is running and the user mentions
// one of these without a cough word, Jaga says NOT_COVERED_YET.
const NON_COUGH_SYMPTOM_PATTERNS: RegExp[] = [
  /\bfever\b/i,
  /\bcut\b/i,
  /\brash\b/i,
  /\bswell(ing|en)?\b/i,
  /\bheadache\b/i,
  /\bdizz(y|iness)\b/i,
  /\bvomit(ing)?\b/i,
  /\bdiarrh(ea|oea)\b/i,
  /\bsore\s+throat\b/i,
  /\bn?stomach\s+(ache|pain|cramp)\b/i,
  /\babdominal\s+pain\b/i,
  /\bnausea\b/i,
  /\bsprain\b/i,
  /\bburn\b/i,
  /\bwound\b/i,
  /\blump\b/i,
  /\bbump\b/i,
  /\bbleed(ing)?\b/i, // "bleeding" without a cough mention
];

export function isNonCoughSymptom(text: string): boolean {
  return NON_COUGH_SYMPTOM_PATTERNS.some((re) => re.test(text));
}

/** Detect "fever" with no temperature number. */
export function isFeverWithoutNumber(text: string): boolean {
  const lower = text.toLowerCase();
  if (!/\bfever\b/.test(lower)) return false;
  // Check if there's a number after "fever" (e.g. "fever 38.5")
  return !/\bfever\s+\d{2}(\.\d+)?\b/.test(lower) && !/\btemperature\s+\d{2}(\.\d+)?\b/.test(lower);
}

export function isCoughMention(text: string): boolean {
  return COUGH_PATTERNS.some((re) => re.test(text));
}

// Phrases that clearly describe the person's OWN cough, not just mention cough
// as a topic. Used to distinguish "I have a cough, what can I take?" from
// "what can I take for cough ah" at the symptom step.
const OWN_COUGH_PATTERNS: RegExp[] = [
  /\bi\s+(have|had|ve|have got|got|am|feel)\b[^.?!]{0,15}\b(cough|coughing|coughed|phlegm|sputum|mucus)\b/i,
  /\b(cough|coughing|coughed|phlegm|sputum|mucus)\b[^.?!]{0,15}\b(for|since|from|about)\s+\w+/i,
  /\bmy\s+(cough|phlegm|sputum|mucus)\b/i,
  /\bi'?ve\s+been\s+coughing\b/i,
  /\bi'?m\s+coughing\b/i,
  /\bcough\s+\d+\s+weeks?\b/i,
  /\bcough\s+since\b/i,
];

export function isOwnCoughReport(text: string): boolean {
  return OWN_COUGH_PATTERNS.some((re) => re.test(text));
}

export function isEmergencyMention(text: string): boolean {
  const lower = text.toLowerCase();
  // Effort-only breathlessness (stairs, walking, "a bit breathless") is NOT
  // an emergency. It is the see-a-doctor-today sign.
  const isEffortOnly = EFFORT_BREATHLESS_PATTERN.test(lower);
  for (const re of EMERGENCY_PATTERNS) {
    const match = lower.match(re);
    if (!match) continue;
    // "breathless" matches effort-only: skip it as an emergency.
    if (isEffortOnly && /\bbreathless\b/.test(match[0])) continue;
    // Check for negation in the 20 characters before the match.
    const start = Math.max(0, match.index! - 20);
    const before = lower.slice(start, match.index! + match[0].length);
    if (NEGATION_PATTERN.test(before)) continue;
    return true;
  }
  return false;
}
