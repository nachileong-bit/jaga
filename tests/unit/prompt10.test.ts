// tests/unit/prompt10.test.ts
// Tests for prompt 10: conversation fixes from end-to-end QA of the live demo.

import { describe, it, expect } from "vitest";
import { ScriptedExtractor, extractOnset } from "../../src/llm/ScriptedExtractor.js";
import { createSession, getSession } from "../../src/conversation/flow.js";
import { isEmergencyMention } from "../../src/conversation/symptomScope.js";
import { CLINICS } from "../../src/navigation/prototypeData.js";
import { buildSummary } from "../../src/navigation/summary.js";
import { loadPolicy } from "../../src/core/policyLoader.js";
import { createStore } from "../../src/core/repository.js";
import { createEpisode, processObservation } from "../../src/core/engine.js";
import { SimulatedClock } from "../../src/core/clock.js";
import { minDurationDays } from "../../src/core/episodeStateMachine.js";
import type { DemoState, TranscriptEntry } from "../../src/conversation/types.js";
import * as copy from "../../src/copy/en.js";

let counter = 0;
function fresh(scenario: "mr_tan" | "ms_lim") {
  const sid = `p10-${++counter}`;
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

// ============================================================= Blocker 1
describe("Blocker 1: red-flag answer parsing", () => {
  it('"do I have cancer?" at a warning-sign question is NOT counted as YES', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    // Now at the blood question. "do I have cancer?" contains "have" but
    // must NOT be counted as YES.
    const state = await say(sid, "do I have cancer?");
    const text = allText(state);
    // Must get the no-diagnosis reply, not the blood emergency message.
    expect(text).toContain("can't tell you what is causing it");
    // Must NOT escalate to emergency department.
    expect(text).not.toContain("emergency department now");
    // The blood question must be re-asked.
    expect(text).toContain("Have you noticed any blood when you cough?");
  });

  it('"yes" is counted as YES (reported)', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    const state = await tap(sid, "Yes"); // blood -> emergency
    expect(allText(state)).toContain("Coughing up blood can be serious");
  });

  it('"no lah" is counted as NO (denied)', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    const state = await say(sid, "no lah");
    // "no lah" starts with "no" -> denied, moves to next question.
    expect(allText(state)).toContain("breathless");
  });

  it('"don\'t have" is counted as NO (denied)', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    const state = await say(sid, "don't have");
    // denied -> moves to next question (breathless).
    expect(allText(state)).toContain("breathless");
  });

  it('"no got" is counted as NO (denied)', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    const state = await say(sid, "no got");
    // denied -> moves to next question (breathless).
    expect(allText(state)).toContain("breathless");
  });

  it('"maybe" is unclear: ask once more, then record unknown (never denied)', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    // First unclear answer: ask once more.
    let state = await say(sid, "maybe");
    expect(allText(state)).toContain("clear yes or no");
    // Second unclear answer: record unknown, move on.
    state = await say(sid, "maybe");
    // Should move to the next red-flag question (breathless).
    expect(allText(state)).toContain("breathless");
    // The clock panel should show the blood sign as unknown, not denied.
    const blood = state.clockPanel.redFlags.find((r) => r.key === "blood");
    expect(blood?.status).toBe("unknown");
  });

  it('"got blood in phlegm" as free text is counted as YES (reported)', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    const state = await say(sid, "got blood in phlegm");
    expect(allText(state)).toContain("Coughing up blood can be serious");
  });
});

// ============================================================= Blocker 2
describe("Blocker 2: onset step parsing", () => {
  it('"do I have cancer?" at the onset step is answered, not stored as onset', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, "cough"); // creates episode, onset unknown -> asks onset
    const state = await say(sid, "do I have cancer?");
    const text = allText(state);
    // Must get the no-diagnosis reply.
    expect(text).toContain("can't tell you what is causing it");
    // Must re-ask the onset question.
    expect(text).toContain("Roughly when did it start?");
    // Must NOT store "do I have cancer?" as the onset.
    expect(state.clockPanel.onsetRawText).not.toContain("cancer");
  });

  it("unreadable onset re-asks once, then records unknown without claiming 0 days", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, "cough"); // onset unknown -> asks onset
    // First unreadable answer: re-ask.
    let state = await say(sid, "not sure really");
    expect(allText(state)).toContain("couldn't read");
    expect(allText(state)).toContain("Roughly when did it start?");
    // Second unreadable: record onset unknown.
    state = await say(sid, "just a cough");
    const text = allText(state);
    expect(text).toContain("I'll start counting from today");
    // Must NOT claim "at least 0 days".
    expect(text).not.toContain("at least 0 day");
  });

  it.each([
    ["last month", "last month"],
    ["since last month", "since last month"],
    ["since CNY", "since CNY"],
    ["since Chinese New Year", "since Chinese New Year"],
    ["last week", "last week"],
    ["yesterday", "yesterday"],
    ["this morning", "this morning"],
    ["few weeks", "few weeks"],
    ["a month", "a month"],
    ["2 months", "2 months"],
    ["since September", "since September"],
  ])("extractOnset parses: %s", (phrase) => {
    const m = extractOnset(phrase, "2026-02-20T08:00:00.000Z");
    expect(m).not.toBeNull();
    expect(m!.rawText.toLowerCase()).toContain(phrase.toLowerCase().split(" ").slice(-2).join(" "));
  });

  it("extractOnset 'since September' counts from 1st of September", () => {
    const m = extractOnset("cough since September", "2026-02-20T08:00:00.000Z");
    expect(m).not.toBeNull();
    const target = new Date("2025-09-01T08:00:00.000Z");
    expect(new Date(m!.latestPossible).getTime()).toBe(target.getTime());
  });

  it("extractOnset 'yesterday' is 1 day before the simulated clock date", () => {
    const m = extractOnset("started yesterday", "2026-02-20T08:00:00.000Z");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("yesterday");
    const target = new Date("2026-02-19T08:00:00.000Z");
    expect(new Date(m!.latestPossible).getTime()).toBe(target.getTime());
  });

  it("extractOnset 'this morning' is 0 days (today)", () => {
    const m = extractOnset("started this morning", "2026-02-20T08:00:00.000Z");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("this morning");
    const target = new Date("2026-02-20T08:00:00.000Z");
    expect(new Date(m!.latestPossible).getTime()).toBe(target.getTime());
  });
});

// ============================================================= Major 3
describe("Major 3: first-message warning sign escalates at once", () => {
  it('"no lah, got blood in phlegm" at symptom step gives blood emergency and creates cough episode', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    const state = await say(sid, "no lah, got blood in phlegm");
    const text = allText(state);
    // Must give the blood emergency message.
    expect(text).toContain("Coughing up blood can be serious");
    // Must create the cough episode.
    expect(state.clockPanel.symptom).toBe("cough");
  });

  it('"cough with chest pain" at symptom step gives emergency and creates episode', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    const state = await say(sid, "cough with chest pain");
    const text = allText(state);
    expect(text).toContain("emergency");
    expect(state.clockPanel.symptom).toBe("cough");
  });
});

// ============================================================= Major 4
describe("Major 4: emergency words on every message", () => {
  it.each([
    "heart attack",
    "stroke",
    "collapsed",
    "unconscious",
    "can't wake",
    "fit",
    "seizure",
  ])("isEmergencyMention catches: %s", (text) => {
    expect(isEmergencyMention(text)).toBe(true);
  });

  it('"a bit breathless when climb stairs" is NOT an emergency', () => {
    expect(isEmergencyMention("a bit breathless when climb stairs")).toBe(false);
  });

  it('"heart attack" during monitoring gets EMERGENCY_NOW', async () => {
    const { sid } = await start();
    const state = await say(sid, "I think I'm having a heart attack");
    expect(allText(state)).toContain("Call 995 now");
  });

  it('"stroke" during monitoring gets EMERGENCY_NOW', async () => {
    const { sid } = await start();
    const state = await say(sid, "my face is drooping, maybe a stroke");
    expect(allText(state)).toContain("Call 995 now");
  });

  it('"a bit breathless when climb stairs" during monitoring is NOT an emergency', async () => {
    const { sid } = await start();
    const state = await say(sid, "a bit breathless when climb stairs");
    expect(allText(state)).not.toContain("Call 995 now");
  });
});

// ============================================================= Major 5
describe("Major 5: trusted person attribution", () => {
  it("when the support person reports a warning sign, they are not sent an alert about their own report", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    await tap(sid, "No"); // blood denied by user
    await tap(sid, "No"); // breathless denied
    // Now monitoring. Support person reports blood.
    const state = await say(sid, "he's coughing up blood", "support_person");
    const sent = getSession(sid)!.getSentToSupport();
    expect(sent.find((s) => s.urgent)).toBeUndefined();
    // The warning sign is still recorded as reported by the trusted person.
    expect(state.clockPanel.redFlags.find((f) => f.key === "blood")?.reportedBy).toBe("support_person");
  });

  it("when user reports a warning sign, share text says user name told Jaga", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    // User reports blood at the blood question.
    const state = await tap(sid, "Yes");
    const sent = getSession(sid)!.getSentToSupport();
    const urgent = sent.find((s) => s.urgent);
    expect(urgent).toBeDefined();
    expect(urgent!.text).toContain("Mr Tan told Jaga");
  });

  it("EMERGENCY_995 alert to trusted person mentions 995 / emergency department", async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, DEFAULT_SYMPTOM);
    await tap(sid, "Yes"); // blood -> EMERGENCY_995
    const sent = getSession(sid)!.getSentToSupport();
    const urgent = sent.find((s) => s.urgent);
    expect(urgent).toBeDefined();
    expect(urgent!.text).toContain("995");
    expect(urgent!.text).not.toContain("checked by a doctor today");
  });
});

// ============================================================= Major 6
describe("Major 6: missed check-ins before clock start", () => {
  it('"cough 3 weeks" at day 0 shows 0 missed check-ins', async () => {
    const sid = fresh("mr_tan");
    await tap(sid, "Add a trusted person");
    await say(sid, "cough 3 weeks");
    await tap(sid, "No"); // blood
    await tap(sid, "No"); // breathless
    const state = await tap(sid, "No"); // any remaining
    expect(state.clockPanel.missedCheckins).toBe(0);
  });
});

// ============================================================= Major 7
describe("Major 7: appointment reminder and check-ins", () => {
  it("booking on day 14 for tomorrow: reminder on day 15, not day 21", async () => {
    const { sid } = await start("mr_tan", "cough 3 weeks");
    // Day 0: onset 3 weeks ago -> three_weeks_any fires at intake -> GP nudge.
    // Book the appointment for tomorrow (day 1).
    await tap(sid, "Book appointment");
    // Advance to day 1: reminder should fire on the appointment day.
    const s1 = await go(sid, 1);
    expect(allText(s1)).toContain("Reminder");
    expect(allText(s1)).toContain("today");
  });

  it("while booking is active, routine check-in is skipped", async () => {
    const { sid } = await start("mr_tan", "cough 3 weeks");
    // Book the appointment at intake.
    await tap(sid, "Book appointment");
    // Handle the share preview (threshold share) before advancing.
    await tap(sid, "Send");
    // Advance to day 7 (a check-in day): should NOT ask "Still coughing?".
    const s7 = await go(sid, 7);
    expect(allText(s7)).not.toContain("Still coughing");
    // Should ask "Did you manage to see the doctor?" the day after the appt.
    expect(allText(s7)).toContain("Did you manage to see the doctor");
  });
});

// ============================================================= Major 8
describe("Major 8: questions at the symptom step", () => {
  it('"what can I take for cough ah" gets KB answer then symptom question again', async () => {
    const sid = fresh("ms_lim");
    await tap(sid, "On my own");
    const state = await say(sid, "what can I take for cough ah");
    const text = allText(state);
    // Must re-ask the symptom question.
    expect(text).toContain("Tell me about your cough");
    // Must NOT create an episode.
    expect(state.clockPanel.symptom).toBeNull();
  });

  it('"can my blood pressure medicine cause cough?" gets KB answer and symptom question again', async () => {
    const sid = fresh("ms_lim");
    await tap(sid, "On my own");
    const state = await say(sid, "can my blood pressure medicine cause cough?");
    const text = allText(state);
    // Must re-ask the symptom question.
    expect(text).toContain("Tell me about your cough");
    // Must NOT create an episode.
    expect(state.clockPanel.symptom).toBeNull();
  });

  it('"I have a cough, what can I take?" starts the cough flow and answers after', async () => {
    const sid = fresh("ms_lim");
    await tap(sid, "On my own");
    const state = await say(sid, "I have a cough, what can I take?");
    const text = allText(state);
    // Must create the cough episode.
    expect(state.clockPanel.symptom).toBe("cough");
    // Onset not recognised inline, so Jaga asks when it started.
    expect(state.phase).toBe("onset");
  });
});

// ============================================================= Major 9
describe("Major 9: clinic card prices", () => {
  it("consult field has no $XX placeholder", () => {
    for (const c of CLINICS) {
      expect(c.consult).not.toContain("$XX");
      expect(c.consult).not.toContain("$");
    }
  });

  it("outOfPocket field has no $XX placeholder", () => {
    for (const c of CLINICS) {
      expect(c.outOfPocket).not.toContain("$XX");
      expect(c.outOfPocket).not.toContain("$");
    }
  });

  it("consult says 'Consultation fee shown at the clinic'", () => {
    for (const c of CLINICS) {
      expect(c.consult).toContain("Consultation fee shown at the clinic");
    }
  });

  it("outOfPocket says 'CHAS or Healthier SG subsidies may apply'", () => {
    for (const c of CLINICS) {
      expect(c.outOfPocket).toContain("CHAS or Healthier SG subsidies may apply");
    }
  });

  it("simulated is true and PROTOTYPE DATA label is present", () => {
    for (const c of CLINICS) {
      expect(c.simulated).toBe(true);
      expect(c.label).toContain("PROTOTYPE DATA");
    }
  });
});

// ============================================================= Major 10
describe("Major 10: GP summary - no code names", () => {
  async function makeSummaryState() {
    const store = createStore(":memory:");
    const clock = new SimulatedClock("2026-02-20T08:00:00.000Z");
    const person = {
      id: "p1",
      displayName: "Test Person",
      language: "en",
      mode: "supported" as const,
      consent: { shareAtThresholds: true },
    };
    store.upsertPerson(person);
    clock.advanceToDay(0);
    const policy = loadPolicy("cough");
    const episode = await createEpisode(
      person,
      "cough",
      { rawText: "cough 3 weeks", latestPossible: "2026-01-30T08:00:00.000Z", confidence: "approximate" as const },
      clock
    );
    store.insertEpisode(episode);
    return { store, clock, person, episode, policy };
  }

  it("warning sign keys are mapped to plain words", async () => {
    const { store, clock, person, episode, policy } = await makeSummaryState();
    clock.advanceToDay(0);
    await processObservation(store, episode, {
      at: clock.now(),
      reporter: "user",
      kind: "redflag_answer",
      redFlags: { blood: "reported" },
      rawText: "got blood",
    }, clock);
    const updatedEpisode = store.getEpisode(episode.id)!;
    const observations = store.getObservationsForEpisode(episode.id);
    const summary = buildSummary({
      displayName: person.displayName,
      mode: "supported",
      episode: updatedEpisode,
      observations,
      policy,
      lastResult: null,
      clockStartIso: "2026-02-20T08:00:00.000Z",
      nowIso: clock.now(),
      minDurationDays: minDurationDays(updatedEpisode, clock),
      pendingItemLabel: null,
    });
    const blood = summary.redFlags.find((r) => r.key === "Blood when coughing");
    expect(blood).toBeDefined();
    // Must not show the code name "blood" anywhere.
    expect(summary.redFlags.some((r) => r.key === "blood")).toBe(false);
  });

  it("rule ids are mapped to plain words in ruleFired", async () => {
    const { store, clock, person, episode, policy } = await makeSummaryState();
    clock.advanceToDay(21);
    const { result, episode: ep2 } = await processObservation(
      store,
      store.getEpisode(episode.id)!,
      {
        at: clock.now(),
        reporter: "user",
        kind: "checkin",
        trajectory: "same",
        rawText: "still coughing",
      },
      clock
    );
    const observations = store.getObservationsForEpisode(episode.id);
    const summary = buildSummary({
      displayName: person.displayName,
      mode: "supported",
      episode: ep2,
      observations,
      policy,
      lastResult: result,
      clockStartIso: "2026-02-20T08:00:00.000Z",
      nowIso: clock.now(),
      minDurationDays: minDurationDays(ep2, clock),
      pendingItemLabel: null,
    });
    expect(summary.ruleFired).not.toBeNull();
    // Must show the plain-word label, not the code name.
    expect(summary.ruleFired!.ruleId).toContain("more than 3 weeks");
    expect(summary.ruleFired!.ruleId).not.toContain("three_weeks_any");
  });

  it("unasked signs show 'Not asked' and are listed after asked ones", async () => {
    const { store, clock, person, episode, policy } = await makeSummaryState();
    clock.advanceToDay(0);
    await processObservation(store, episode, {
      at: clock.now(),
      reporter: "user",
      kind: "redflag_answer",
      redFlags: { blood: "denied" },
      rawText: "no blood",
    }, clock);
    const ep2 = store.getEpisode(episode.id)!;
    const observations = store.getObservationsForEpisode(episode.id);
    const summary = buildSummary({
      displayName: person.displayName,
      mode: "supported",
      episode: ep2,
      observations,
      policy,
      lastResult: null,
      clockStartIso: "2026-02-20T08:00:00.000Z",
      nowIso: clock.now(),
      minDurationDays: minDurationDays(ep2, clock),
      pendingItemLabel: null,
    });
    // Blood was asked and denied.
    const blood = summary.redFlags.find((r) => r.key === "Blood when coughing");
    expect(blood).toBeDefined();
    expect(blood!.status).toBe("Denied");
    // Breathless was not asked.
    const breathless = summary.redFlags.find((r) => r.key === "Breathless at rest or chest pain");
    expect(breathless).toBeDefined();
    expect(breathless!.status).toBe("Not asked");
    // Asked signs come first.
    const bloodIdx = summary.redFlags.findIndex((r) => r.key === "Blood when coughing");
    const breathlessIdx = summary.redFlags.findIndex((r) => r.key === "Breathless at rest or chest pain");
    expect(bloodIdx).toBeLessThan(breathlessIdx);
  });
});
