// tests/unit/prompt09.test.ts
// Tests for prompt 09: older-adult UX and triage fixes.

import { describe, it, expect } from "vitest";
import { ScriptedExtractor } from "../../src/llm/ScriptedExtractor.js";
import { searchKnowledge } from "../../src/knowledge/kb.js";
import { loadPolicy } from "../../src/core/policyLoader.js";
import { createSession, getSession } from "../../src/conversation/flow.js";
import type { DemoState, TranscriptEntry } from "../../src/conversation/types.js";
import * as copy from "../../src/copy/en.js";

let counter = 0;
function fresh(scenario: "mr_tan" | "ms_lim") {
  const sid = `p9-${++counter}`;
  createSession(sid, scenario);
  return sid;
}
const tap = (sid: string, button: string, reporter?: "user" | "support_person") =>
  getSession(sid)!.handleMessage({ button, reporter });
const say = (sid: string, text: string, reporter?: "user" | "support_person") =>
  getSession(sid)!.handleMessage({ text, reporter });
const go = (sid: string, toDay: number) => getSession(sid)!.handleAdvance({ toDay });

const jaga = (s: DemoState) => s.transcript.filter((t) => t.role === "jaga");
const lastJaga = (s: DemoState): TranscriptEntry =>
  jaga(s).filter((t) => !t.sticker)[jaga(s).filter((t) => !t.sticker).length - 1];
const allText = (s: DemoState) => s.transcript.map((t) => t.text).join("\n");

const DEFAULT_SYMPTOM = "cough a bit since before CNY, just a cough lah";

/** Setup up to the point where monitoring has started (day 0). */
async function start(scenario: "mr_tan" | "ms_lim" = "mr_tan", symptomText = DEFAULT_SYMPTOM) {
  const sid = fresh(scenario);
  await tap(sid, scenario === "mr_tan" ? "Add a trusted person" : "On my own");
  await say(sid, symptomText);
  await tap(sid, "No"); // blood
  const state = await tap(sid, "No"); // breathless
  return { sid, state };
}

const ext = new ScriptedExtractor();

// ------------------------------------------------------------------ Bug 1
describe("Bug 1: false blood alarm", () => {
  const falseAlarms = [
    "Can my blood pressure medicine cause cough?",
    "I just had a blood test",
    "my blood sugar is high",
    "after blood donation I feel tired",
    "I donated blood yesterday",
    "taking blood thinner for my heart",
    "I have high blood pressure",
    "my BP is 140 over 90",
  ];
  for (const text of falseAlarms) {
    it(`does not report blood for "${text}"`, () => {
      const results = ext.extract({ text, button: undefined });
      const blood = results.find((r) => r.redFlags?.blood === "reported");
      expect(blood).toBeUndefined();
    });
  }

  const realReports = [
    "coughing blood",
    "blood in my phlegm",
    "noticed blood when coughing",
    "bloody phlegm",
  ];
  for (const text of realReports) {
    it(`reports blood for "${text}"`, () => {
      const results = ext.extract({ text, button: undefined });
      const blood = results.find((r) => r.redFlags?.blood === "reported");
      expect(blood).toBeDefined();
    });
  }
});

// ------------------------------------------------------------------ Bug 2
describe("Bug 2: reportedAt day on warning sign", () => {
  it("reportedAt day is day 0 when sign reported on day 0", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    await tap(sid, "No"); // blood denied
    const state = await tap(sid, "Yes"); // breathless reported
    const reported = state.clockPanel.redFlags.find(
      (r) => r.key === "breathless_or_chest_pain" && r.status === "reported"
    );
    expect(reported).toBeDefined();
    expect(reported!.reportedAt).toBeDefined();
    // Day 0 means the reportedAt timestamp should convert to day 0.
    const start = new Date("2026-02-20T08:00:00.000Z").getTime();
    const t = new Date(reported!.reportedAt!).getTime();
    const day = Math.floor((t - start) / 86400000);
    expect(day).toBe(0);
  });
});

// ------------------------------------------------------------------ Bug 3
describe("Bug 3: split breathless sign", () => {
  it("effort-only breathlessness reports as breathless_effort", () => {
    const results = ext.extract({ text: "a bit breathless when climb stairs", button: undefined });
    const r = results.find((r) => r.redFlags?.breathless_effort === "reported");
    expect(r).toBeDefined();
  });

  it("slightly breathless on walking reports as breathless_effort", () => {
    const results = ext.extract({ text: "slightly breathless on walking", button: undefined });
    const r = results.find((r) => r.redFlags?.breathless_effort === "reported");
    expect(r).toBeDefined();
  });

  it("breathless at rest reports as breathless_or_chest_pain", () => {
    const results = ext.extract({ text: "I am breathless at rest", button: undefined });
    const r = results.find((r) => r.redFlags?.breathless_or_chest_pain === "reported");
    expect(r).toBeDefined();
  });

  it("can't breathe reports as breathless_or_chest_pain", () => {
    const results = ext.extract({ text: "can't breathe", button: undefined });
    const r = results.find((r) => r.redFlags?.breathless_or_chest_pain === "reported");
    expect(r).toBeDefined();
  });

  it("breathless_effort is SEE_DOCTOR_TODAY in the policy", () => {
    const policy = loadPolicy("cough");
    const rf = policy.redFlags.find((r) => r.key === "breathless_effort");
    expect(rf).toBeDefined();
    expect(rf!.action).toBe("SEE_DOCTOR_TODAY");
  });

  it("breathless_effort message mentions today and NurseFirst", () => {
    const msg = copy.redFlagMessage("SEE_DOCTOR_TODAY", "breathless_effort");
    expect(msg).toContain("today");
    expect(msg).toContain("NurseFirst");
  });
});

// ------------------------------------------------------------------ Bug 4
describe("Bug 4: no routine check-ins after emergency", () => {
  it("does not send CLOCK_STARTED or sticker after emergency at intake", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    // First say a normal cough to create an episode, then report blood at the
    // breathless question (answer Yes to breathless -> emergency).
    await say(sid, DEFAULT_SYMPTOM);
    await tap(sid, "No"); // blood denied
    const state = await tap(sid, "Yes"); // breathless reported -> EMERGENCY_995
    const text = allText(state);
    expect(text).not.toContain("started counting");
  });

  it("holds check-ins until the person replies after emergency", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    await tap(sid, "No"); // blood denied
    await tap(sid, "Yes"); // breathless reported -> EMERGENCY_995
    // Advance to day 7 without the user replying after the emergency.
    const s7 = await go(sid, 7);
    const hasCheckin = s7.transcript.some((t) => t.text.includes("Still coughing"));
    expect(hasCheckin).toBe(false);
  });

  it("asks 'Did you get checked?' at next check-in after emergency", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    await tap(sid, "No"); // blood denied
    await tap(sid, "Yes"); // breathless reported -> EMERGENCY_995
    // User replies to clear emergencyPending.
    await say(sid, "ok I will go");
    // Advance to day 7 - should ask "Did you get checked?"
    const s7 = await go(sid, 7);
    const text = allText(s7);
    expect(text).toContain("Did you get checked?");
  });
});

// ------------------------------------------------------------------ Bug 5
describe("Bug 5: unanswered warning-sign question", () => {
  it("re-asks the warning-sign question before 'Still coughing?'", async () => {
    const { sid } = await start();
    // Day 7 check-in
    await go(sid, 7);
    await tap(sid, "Still got"); // triggers checkin_followup
    // Now don't answer the follow-up. Advance to day 14.
    const s14 = await go(sid, 14);
    const text = allText(s14);
    // Should re-ask the warning-sign question, not "Still coughing?"
    expect(text).toContain("any blood");
  });
});

// ------------------------------------------------------------------ Bug 6
describe("Bug 6: KB miss for Singlish", () => {
  it("'What can I take for cough ah' returns cough_medicine", () => {
    const ans = searchKnowledge("What can I take for cough ah", "cough");
    expect(ans).not.toBeNull();
    expect(ans!.entry.id).toBe("cough_medicine");
  });

  it("ignores Singlish particles lah, ah, leh, lor, meh, hor", () => {
    const ans = searchKnowledge("what medicine lah", "cough");
    expect(ans).not.toBeNull();
    expect(ans!.entry.id).toBe("cough_medicine");
  });
});

// ------------------------------------------------------------------ Bug 7
describe("Bug 7: non-English reply", () => {
  it("replies with standard message for Chinese text", async () => {
    const { sid } = await start();
    const state = await say(sid, "我咳嗽怎么办");
    const last = lastJaga(state);
    expect(last.text).toContain("only read English");
  });

  it("keeps the step where it was", async () => {
    const { sid, state: beforeState } = await start();
    const beforePhase = beforeState.phase;
    const state = await say(sid, "我咳嗽怎么办");
    expect(state.phase).toBe(beforePhase);
  });
});

// ------------------------------------------------------------------ Bug 7b
describe("Bug 7b: nudge at intake", () => {
  it("shows GP nudge on day 0 for cough 3 weeks already", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, "cough 3 weeks already");
    await tap(sid, "No"); // blood
    await tap(sid, "No"); // breathless
    const state = await tap(sid, "No"); // high_fever? -> actually just blood and breathless
    const text = allText(state);
    expect(text).toContain("see a GP");
  });
});

// ------------------------------------------------------------------ Bug 7c
describe("Bug 7c: most urgent sign wins", () => {
  it("does not repeat the same emergency message for already-reported sign", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    // Answer blood "Yes" -> blood reported -> EMERGENCY_995.
    await tap(sid, "Yes"); // blood reported -> EMERGENCY_995
    await tap(sid, "No"); // breathless
    // User replies to clear emergencyPending.
    await say(sid, "ok");
    // Advance to day 7. "Did you get checked?" is asked.
    await go(sid, 7);
    // Answer "Not yet" -> resume normal check-in.
    await tap(sid, "Not yet");
    // Now answer "Still got" to the normal check-in.
    await tap(sid, "Still got");
    // The follow-up question is asked. Answer "No" (no new warning signs).
    const state = await tap(sid, "No");
    const text = allText(state);
    // Should not repeat the blood emergency message again.
    const count = text.split("Coughing up blood can be serious").length - 1;
    expect(count).toBe(1);
  });
});

// ------------------------------------------------------------------ Item 10
describe("Item 10: 'I took medicine' button", () => {
  it("recognises 'I took medicine' button", () => {
    const results = ext.extract({ text: undefined, button: "I took medicine" });
    const r = results.find((r) => r.kind === "self_treatment");
    expect(r).toBeDefined();
  });

  it("still recognises old 'Took medicine' button", () => {
    const results = ext.extract({ text: undefined, button: "Took medicine" });
    const r = results.find((r) => r.kind === "self_treatment");
    expect(r).toBeDefined();
  });
});
