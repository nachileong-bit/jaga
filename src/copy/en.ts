// src/copy/en.ts
// All user-facing strings live here. No medical advice, no disease names,
// no "it's fine". Every check-in message ends with the escape hatch.
// Jaga never names a disease.

import type { ActionType, Mode } from "../core/types.js";

export const ESCAPE_HATCH = "You can seek medical care at any time if you're concerned.";

// ---- Opening / mode selection ----

export const GREETING = "Hello! I'm Jaga. I'll help you keep track of how you're doing.";

export const MODE_QUESTION = "Would you like to go through this on your own, or add a trusted person to the loop?";

export const MODE_BUTTONS: Record<string, string> = {
  on_my_own: "On my own",
  add_trusted: "Add a trusted person",
};

export const MODE_CONFIRM_INDEPENDENT = "Got it. I'll check in with you regularly. You're in charge.";
export const MODE_CONFIRM_SUPPORTED = (supportName: string) =>
  `Got it. ${supportName} will be kept in the loop as you agreed. You can change this anytime.`;

// ---- Symptom mention ----

export const ASK_SYMPTOM = "What's bothering you? Tell me in your own words.";

export const SYMPTOM_ACKNOWLEDGED = (rawText: string) =>
  `Noted — "${rawText}". I'll start counting from the earliest you're sure about.`;

// ---- Red-flag questions ----

export const ASK_RED_FLAG_BLOOD = "Have you noticed any blood when you cough?";

export const ASK_RED_FLAG_BREATHLESS = "Have you felt breathless or had any chest pain?";

export const RED_FLAG_BUTTONS: Record<string, string> = {
  yes: "Yes",
  no: "No",
};

// ---- Clock starts ----

export const CLOCK_STARTED = "I've started the clock. I'll check in with you every few days to see how it's going.";

// ---- Check-in messages ----

export const CHECKIN_PROMPT = "Still coughing?";

export const CHECKIN_BUTTONS: string[] = ["Still got", "Better", "Gone"];

export function checkinMessage(): string {
  return `${CHECKIN_PROMPT} ${ESCAPE_HATCH}`;
}

// ---- Action messages ----

export function actionMessage(
  action: ActionType,
  explain?: string,
  sourceLabel?: string,
  sourceUrl?: string
): string {
  switch (action) {
    case "KEEP_WATCHING":
      return `I'll keep an eye on this with you. ${ESCAPE_HATCH}`;
    case "SEE_GP": {
      let msg = explain ?? "Based on how this has been going, it would be good to see a GP.";
      if (sourceLabel && sourceUrl) {
        msg += `\n\nSource: ${sourceLabel} — ${sourceUrl}`;
      }
      msg += `\n\n[PROTOTYPE DATA] Care navigation arrives in a future update.`;
      return msg;
    }
    case "SEE_DOCTOR_TODAY":
      return `Please see a doctor today. ${ESCAPE_HATCH}`;
    case "EMERGENCY_995":
      return `If this feels like an emergency, call 995 now. Don't wait.`;
    default:
      return ESCAPE_HATCH;
  }
}

// ---- Red flag direct instruction (no persona) ----

export function redFlagMessage(action: ActionType, redFlagKey?: string): string {
  switch (action) {
    case "SEE_DOCTOR_TODAY":
      return `Blood in your cough needs attention. Please see a doctor today.`;
    case "EMERGENCY_995":
      return `Breathlessness or chest pain can be an emergency. Call 995 now.`;
    default:
      return `Please seek medical care without delay.`;
  }
}

// ---- Support person notification (supported mode only) ----

export const SUPPORT_NOTIFIED = (supportName: string) =>
  `${supportName} notified (as agreed).`;

// ---- Clarification (discordance) ----

export const ASK_CLARIFICATION_MSG =
  "You and your trusted person have reported different things. Can you tell me a bit more about how it's been today?";

// ---- Misc ----

export const SILENCE_RECORDED = "No response recorded for this check-in. I'll keep watching.";

export const CLOCK_PANEL_TITLE = "Jaga Clock";

export const PENDING_REVIEW_BADGE = "PENDING CLINICIAN REVIEW";

export const PROTOTYPE_LABEL = "PROTOTYPE DATA";

export const SUPPORT_PERSON_MR_TAN = "Mei Ling";

export function supportPersonName(mode: Mode): string | null {
  return mode === "supported" ? SUPPORT_PERSON_MR_TAN : null;
}
