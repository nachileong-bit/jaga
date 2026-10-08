// tests/unit/symptomScope.test.ts
// Prompt 06: honest handling of symptoms Jaga does not cover yet.

import { describe, it, expect } from "vitest";
import { createSession, getSession } from "../../src/conversation/flow.js";
import type { DemoState, TranscriptEntry } from "../../src/conversation/types.js";
import * as copy from "../../src/copy/en.js";

let counter = 0;
function fresh(scenario: "mr_tan" | "ms_lim" = "ms_lim") {
  const sid = `scope-${++counter}`;
  createSession(sid, scenario);
  return sid;
}
const tap = (sid: string, button: string) =>
  getSession(sid)!.handleMessage({ button });
const say = (sid: string, text: string) =>
  getSession(sid)!.handleMessage({ text });

const jaga = (s: DemoState) => s.transcript.filter((t) => t.role === "jaga");
const lastJaga = (s: DemoState): TranscriptEntry =>
  jaga(s).filter((t) => !t.sticker)[jaga(s).filter((t) => !t.sticker).length - 1];
const allText = (s: DemoState) => s.transcript.map((t) => t.text).join("\n");

/** Reach the symptom prompt (mode has been chosen). */
async function toSymptom(scenario: "mr_tan" | "ms_lim" = "ms_lim") {
  const sid = fresh(scenario);
  await tap(sid, scenario === "mr_tan" ? "Add a trusted person" : "On my own");
  return sid;
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;

describe("unsupported symptoms get NOT_COVERED_YET", () => {
  const unsupported = ["fever", "I cut my finger", "my finger is swollen", "headache"];

  for (const symptom of unsupported) {
    it(`"${symptom}" gets NOT_COVERED_YET, no episode, no blood question, phase stays symptom`, async () => {
      const sid = await toSymptom("ms_lim");
      const state = await say(sid, symptom);

      expect(lastJaga(state).text).toBe(copy.NOT_COVERED_YET);
      expect(state.clockPanel.symptom).toBeNull();
      expect(allText(state)).not.toContain("blood when you cough");
      expect(state.phase).toBe("symptom");
    });
  }
});

describe("after NOT_COVERED_YET, a cough mention starts the normal cough flow", () => {
  it("fever then 'cough since before CNY' starts the cough flow", async () => {
    const sid = await toSymptom("ms_lim");
    let state = await say(sid, "fever");
    expect(lastJaga(state).text).toBe(copy.NOT_COVERED_YET);

    state = await say(sid, "cough since before CNY");
    // Onset was recognised inline, so Jaga acknowledges and starts red-flag screening.
    expect(allText(state)).toContain("Noted:");
    expect(state.clockPanel.symptom).toBe("cough");
    expect(state.phase).toBe("redflag");
  });
});

describe("cough mentioned alongside another symptom starts the cough flow", () => {
  it("'fever and cough for 2 weeks' starts the cough flow", async () => {
    const sid = await toSymptom("ms_lim");
    const state = await say(sid, "fever and cough for 2 weeks");

    expect(lastJaga(state).text).not.toBe(copy.NOT_COVERED_YET);
    // No onset phrase recognised, so Jaga asks roughly when it started.
    expect(lastJaga(state).text).toBe(copy.ASK_ONSET);
    expect(state.phase).toBe("onset");
  });
});

describe("emergency mentions before any episode get EMERGENCY_NOW", () => {
  const emergencies = [
    "my finger is bleeding a lot and won't stop",
    "I can't breathe",
    "chest pain",
  ];

  for (const text of emergencies) {
    it(`"${text}" gets EMERGENCY_NOW before any episode`, async () => {
      const sid = await toSymptom("ms_lim");
      const state = await say(sid, text);

      expect(lastJaga(state).text).toBe(copy.EMERGENCY_NOW);
      expect(state.clockPanel.symptom).toBeNull();
    });
  }
});

describe("negated emergency with cough starts the cough flow", () => {
  it("'no chest pain, just a cough' starts the cough flow and does NOT get EMERGENCY_NOW", async () => {
    const sid = await toSymptom("ms_lim");
    const state = await say(sid, "no chest pain, just a cough");

    expect(allText(state)).not.toContain(copy.EMERGENCY_NOW);
    expect(lastJaga(state).text).not.toBe(copy.NOT_COVERED_YET);
    // "cough" without an onset phrase -> Jaga asks when it started.
    expect(lastJaga(state).text).toBe(copy.ASK_ONSET);
    expect(state.phase).toBe("onset");
  });
});

describe("NOT_COVERED_YET and EMERGENCY_NOW have no emoji and no sticker follows", () => {
  it("NOT_COVERED_YET has no emoji and no sticker follows it", async () => {
    const sid = await toSymptom("ms_lim");
    const state = await say(sid, "fever");

    expect(EMOJI.test(copy.NOT_COVERED_YET)).toBe(false);
    // The last jaga entry must be the text message, not a sticker.
    const entries = jaga(state);
    const last = entries[entries.length - 1];
    expect(last.text).toBe(copy.NOT_COVERED_YET);
    expect(last.sticker).toBeUndefined();
  });

  it("EMERGENCY_NOW has no emoji and no sticker follows it", async () => {
    const sid = await toSymptom("ms_lim");
    const state = await say(sid, "chest pain");

    expect(EMOJI.test(copy.EMERGENCY_NOW)).toBe(false);
    const entries = jaga(state);
    const last = entries[entries.length - 1];
    expect(last.text).toBe(copy.EMERGENCY_NOW);
    expect(last.sticker).toBeUndefined();
  });
});
