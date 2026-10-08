// src/copy/en.ts
// All user-facing strings live here. No medical advice, no disease names,
// no "it's fine". Every check-in message ends with the escape hatch.
// No em dashes or en dashes in user-facing copy.

import type { ActionType } from "../core/types.js";

export const ESCAPE_HATCH = "You can seek medical care at any time if you're concerned.";

// ---- Opening / mode selection ----

export const GREETING =
  "Hello, I'm Jaga 🐾 I keep count of a cough that won't go away, and tell you when it's time to see a GP. Right now I only cover cough. I'm not a doctor and I don't diagnose.";

export const MODE_QUESTION =
  "Would you like to do this on your own, or have someone you trust in the loop?";

export const MODE_BUTTONS = {
  on_my_own: "On my own",
  add_trusted: "Add a trusted person",
};

export const MODE_CONFIRM_INDEPENDENT =
  "Got it. It is just you and me. Nobody else sees anything. You can add a trusted person later if you ever want to.";

export const MODE_CONFIRM_SUPPORTED = (supportName: string) =>
  `Done. ${supportName} will only hear from me if something has gone on long enough to need checking. You will see what I send her first. You can remove her or pause this any time.`;

export const MODE_NO_SUPPORT_IN_SCENARIO =
  "In this demo scenario there is no trusted person set up, so it is just you and me. Everything works the same.";

// ---- Symptom mention and onset ----

export const ASK_SYMPTOM = "Tell me about your cough, in your own words. For example: \"cough 3 weeks, got phlegm\". Other symptoms aren't covered yet.";

export const SYMPTOM_ACKNOWLEDGED = (rawText: string, minDays: number) =>
  `Noted: "${rawText}". That is at least ${minDays} day${minDays === 1 ? "" : "s"}. I'll count from there.`;

export const ASK_ONSET = "Roughly when did it start?";

export const ONSET_BUTTONS: string[] = [
  "Today",
  "A few days ago",
  "About a week ago",
  "More than 2 weeks ago",
];

// Button -> MINIMUM provable duration in days (never invent precision)
export const ONSET_BUTTON_MIN_DAYS: Record<string, number> = {
  Today: 0,
  "A few days ago": 2,
  "About a week ago": 7,
  "More than 2 weeks ago": 14,
};

// ---- Red-flag questions ----

export const RED_FLAG_QUESTIONS: Record<string, string> = {
  blood: "Have you noticed any blood when you cough?",
  breathless_or_chest_pain: "Have you felt breathless or had any chest pain?",
  breathless_effort: "Have you felt breathless only when climbing stairs or walking?",
  high_fever: "Have you had a fever above 38.6 degrees C?",
  weight_loss: "Have you lost weight without trying?",
  night_sweats: "Have you had night sweats?",
  coloured_phlegm: "Have you coughed up thick yellow or green phlegm?",
  wheezing: "Have you been wheezing?",
  fever_or_rash: "Do you have a fever or a rash?",
};

export const YES_NO: string[] = ["Yes", "No"];

export const CLOCK_STARTED = (everyDays: number) =>
  `⏱️ Thanks. I've started counting. I'll check in every ${everyDays} days. ${ESCAPE_HATCH}`;

// ---- Check-ins ----

export const CHECKIN_BUTTONS: string[] = ["Still got", "Better", "Gone"];

export const checkinMessage = () => `👋 Still coughing? ${ESCAPE_HATCH}`;

export const CHECKIN_FOLLOWUP =
  "Since we last spoke, any blood when you cough, breathlessness or chest pain?";

export const CHECKIN_ACK_SAME = `Understood. I'll keep counting. ${ESCAPE_HATCH}`;
export const CHECKIN_ACK_BETTER = `Good to hear. I'll keep counting in case it comes back. ${ESCAPE_HATCH}`;
export const CHECKIN_ACK_GONE = `Good to hear it's gone. I'll check once more next time, in case it returns. ${ESCAPE_HATCH}`;
export const GENERIC_ACK = `Noted. ${ESCAPE_HATCH}`;

export const SILENCE_RECORDED =
  "(No reply to the last check-in. Recorded as unknown, not as better.)";

// ---- Self-treatment confirmation (spec rule 5) ----

export const ASK_SELF_TREATMENT_CONFIRM = (label: string) => `I noted: ${label}. Is that correct?`;
export const SELF_TREATMENT_BUTTONS: string[] = ["Correct", "Not right"];
export const SELF_TREATMENT_CONFIRMED = "Thanks. I've logged it.";
export const SELF_TREATMENT_NOT_RIGHT =
  "No problem. I've noted that you took something, without a name. If you are unsure what it is, a pharmacist can tell you.";

// ---- Red flags ----

// Warning-sign display names for the "see a GP soon" messages.
const WARNING_SIGN_NAMES: Record<string, string> = {
  high_fever: "a fever above 38.6 degrees C",
  weight_loss: "weight loss",
  night_sweats: "night sweats",
  coloured_phlegm: "thick yellow or green phlegm",
  wheezing: "wheezing",
  fever_or_rash: "a fever or rash",
};

export function redFlagMessage(action: ActionType, key: string): string {
  if (action === "EMERGENCY_995") {
    if (key === "blood") {
      return "Coughing up blood can be serious. Go to the nearest emergency department now. If there is a lot of blood or you are breathless, call 995.";
    }
    return "Breathlessness or chest pain can be an emergency. Call 995 now.";
  }
  if (key === "blood") {
    return "Coughing up blood can be serious. Go to the nearest emergency department now. If there is a lot of blood or you are breathless, call 995.";
  }
  if (key === "breathless_effort") {
    return "Feeling breathless with a cough should be checked by a doctor today. If it gets worse, or you feel breathless at rest or have chest pain, call 995. For advice, NurseFirst is on 6262 6262.";
  }
  const signName = WARNING_SIGN_NAMES[key] ?? key.replace(/_/g, " ");
  return `With a cough, HealthHub says ${signName} should be checked by a doctor. Please see a GP in the next day or two.`;
}

export const RED_FLAG_DENY_REPLY = (key: string) => {
  const name = key === "blood" ? "blood when coughing" : key === "breathless_or_chest_pain" || key === "breathless_effort" ? "breathlessness or chest pain" : key.replace(/_/g, " ");
  const advice = key === "blood" || key === "breathless_or_chest_pain" ? "please go to the nearest emergency department or call 995" : key === "breathless_effort" ? "please see a GP today" : "please see a GP";
  return `Thanks for telling me. Because ${name} was mentioned earlier, my advice stays the same: ${advice}.`;
};

export const RED_FLAG_REMINDER = "My earlier advice still stands. Please get this checked as I said before.";

export const SUPPORT_URGENT_TEXT = (userName: string) =>
  `${userName} told Jaga about a warning sign that should be checked by a doctor today. Please check in with them.`;

export const SENT_TO_SUPPORT = (supportName: string, text: string, urgent = false) =>
  `Sent to ${supportName}${urgent ? " (urgent signs, as you agreed)" : ""}: "${text}"`;

// ---- Disagreement (not a medical rule, only a clarifying question) ----

export const ASK_CLARIFICATION_MSG =
  "Thanks both. One quick check: in the last 3 nights, did the cough wake you or anyone at home?";
export const CLARIFY_BUTTONS: string[] = ["Yes", "No", "Not sure"];
export const CLARIFY_ACK = `Thanks, noted. ${ESCAPE_HATCH}`;

// ---- Care navigation ----

export const SEE_GP_INTRO = (minDays: number) =>
  `You've been dealing with this for at least ${minDays} days. That is long enough that it should be checked. A doctor can check what is going on.`;

export const SEE_GP_WHY = (explain: string) => `Why I'm saying this: ${explain}`;

export const NAV_BUTTONS = {
  book: "Book appointment",
  others: "Show other clinics",
  later: "Remind me later today",
  notNow: "Not now",
  askSupport: (name: string) => `Ask ${name} to help`,
};

export const NAV_REMINDER_SHORT = (minDays: number) =>
  `This has now gone on for at least ${minDays} days. My suggestion to get it checked still stands.`;

export const REMIND_LATER_ACK = "Sure. I'll ask again this evening.";
export const REMIND_LATER_PROMPT = "You asked me to remind you. Shall we sort out a visit?";

export const ASK_WHEN = "No problem. When could you go?";
export const PLAN_BUTTONS: string[] = ["Tomorrow morning", "Tomorrow afternoon", "This weekend"];
export const PLAN_SET = (plan: string) =>
  `Okay: ${plan.toLowerCase()}. I'll check in with you after that.`;
export const NOT_NOW_LOGGED = "Understood. I won't keep asking. I'll raise it once more in a week.";
export const NOT_NOW_FINAL = `Understood. I've noted that, and I won't ask again. ${ESCAPE_HATCH}`;
export const NAV_REASK = (minDays: number) =>
  `A week ago you said not now. It has been at least ${minDays} days. Would you like to sort out a visit?`;

export const BOOKED = (clinic: string, slot: string) =>
  `✅ Appointment (prototype): ${slot.toLowerCase()} at ${clinic}.`;
export const APPT_REMINDER = (clinic: string, time: string) =>
  `Reminder: your appointment (prototype) is today at ${time}, at ${clinic}.`;
export const DID_YOU_GO = "🩺 Did you manage to see the doctor?";
export const WENT_BUTTONS: string[] = ["Yes", "Not yet"];
export const ASK_DOCTOR_SAID = "Good. What did the doctor ask you to watch for?";
export const DOCTOR_SAID_ACK = `Thanks, I've saved that. I'll keep checking in. ${ESCAPE_HATCH}`;
export const NOT_YET_REPLY = "That's okay. When could you go?";

export const SUMMARY_OFFER =
  "I've prepared a one-page summary for the doctor, so you don't have to rely on memory.";
export const SUMMARY_LINK_LABEL = "Open GP summary";

// ---- Sharing with a trusted person (supported / assisted only) ----

export const SHARE_PREVIEW = (name: string, text: string) => `I'd like to tell ${name}: "${text}" OK?`;
export const SHARE_BUTTONS: string[] = ["Send", "Don't send"];
export const SHARE_NOT_SENT = "Okay, nothing was sent.";
export const THRESHOLD_TEXT = (userName: string, symptom: string, minDays: number) =>
  `${userName}'s ${symptom} has lasted at least ${minDays} days and should be checked by a doctor. ${userName} is okay with you helping to arrange a visit.`;
export const HELP_TEXT = (userName: string, symptom: string, minDays: number) =>
  `${userName}'s ${symptom} has lasted at least ${minDays} days and should be checked by a doctor. ${userName} would like your help to book a visit.`;

// ---- Labels ----

export const PENDING_REVIEW_BADGE = "PENDING CLINICIAN REVIEW";
export const PROTOTYPE_LABEL = "PROTOTYPE DATA · SIMULATED";
export const SUMMARY_FOOTER = "This is a record of what was reported. It is not a diagnosis.";

// ---- Knowledge base answers ----

export const KB_NO_ANSWER =
  "I don't have checked information on that, so I won't guess. A pharmacist or your GP can help. For advice that is not an emergency, the NurseFirst helpline is 6262 6262.";

export const KB_NO_DIAGNOSIS =
  "I can't tell you what is causing it. Only a doctor can. What I can do is keep count of how long it has gone on and tell you when it is time to get it checked.";

export const KB_FOOTER = "Not a diagnosis.";

// ---- Unsupported symptoms and emergencies (prompt 06) ----

export const NOT_COVERED_YET =
  "Right now I can only keep count for a cough that won't go away. Other symptoms, like fever, cuts or swelling, aren't covered yet, so I won't guess. If you're worried, a GP or pharmacist can help, and the NurseFirst helpline is 6262 6262 for advice that is not an emergency. If it's an emergency, call 995. Is there a cough you'd like me to keep count of?";

export const EMERGENCY_NOW =
  "That sounds like it could be an emergency. Call 995 now, or go to the nearest emergency department.";

// Bug 4: after an emergency message, the next routine check-in asks this first.
export const DID_YOU_GET_CHECKED = "Did you get checked?";
export const DID_YOU_GET_CHECKED_BUTTONS: string[] = ["Yes", "Not yet"];

// Bug 7: non-English message reply.
export const NON_ENGLISH_REPLY =
  "Sorry, I can only read English for now. \u62b1\u6b49\uff0c\u6211\u76ee\u524d\u53ea\u770b\u5f97\u61c2\u82f1\u6587\u3002Maaf, buat masa ini saya hanya faham Bahasa Inggeris.";
