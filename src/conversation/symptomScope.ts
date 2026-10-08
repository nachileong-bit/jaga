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
  // Fainted / unconscious / passed out
  /\bfainted\b/i,
  /\bunconscious\b/i,
  /\bpassed\s+out\b/i,
  // Seizure / fit
  /\bseizure\b/i,
  /\bfit\b/i,
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

const NEGATION_PATTERN =
  /\b(no|not|never|didn'?t|don'?t|doesn'?t|haven'?t|hasn'?t|without|nope)\b/i;

export function isCoughMention(text: string): boolean {
  return COUGH_PATTERNS.some((re) => re.test(text));
}

export function isEmergencyMention(text: string): boolean {
  const lower = text.toLowerCase();
  for (const re of EMERGENCY_PATTERNS) {
    const match = lower.match(re);
    if (!match) continue;
    // Check for negation in the 20 characters before the match.
    const start = Math.max(0, match.index! - 20);
    const before = lower.slice(start, match.index! + match[0].length);
    if (NEGATION_PATTERN.test(before)) continue;
    return true;
  }
  return false;
}
