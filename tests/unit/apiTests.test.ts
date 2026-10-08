// tests/unit/apiTests.test.ts
// Conversation-level tests driven through DemoSession with the simulated clock.
// Covers the M2.1 fixes (A1 to A7) and the M4 care navigation journey (B1 to B7).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, getSession } from "../../src/conversation/flow.js";
import type { DemoState, TranscriptEntry } from "../../src/conversation/types.js";
import * as copy from "../../src/copy/en.js";
import { CLINICS } from "../../src/navigation/prototypeData.js";

let counter = 0;
function fresh(scenario: "mr_tan" | "ms_lim") {
  const sid = `t-${++counter}`;
  createSession(sid, scenario);
  return sid;
}
const tap = (sid: string, button: string, reporter?: "user" | "support_person") =>
  getSession(sid)!.handleMessage({ button, reporter });
const say = (sid: string, text: string, reporter?: "user" | "support_person") =>
  getSession(sid)!.handleMessage({ text, reporter });
const go = (sid: string, toDay: number) => getSession(sid)!.handleAdvance({ toDay });

const jaga = (s: DemoState) => s.transcript.filter((t) => t.role === "jaga");
const lastJaga = (s: DemoState): TranscriptEntry => jaga(s)[jaga(s).length - 1];
const allText = (s: DemoState) => s.transcript.map((t) => t.text).join("\n");
const count = (s: DemoState, needle: string) =>
  s.transcript.filter((t) => t.text.includes(needle)).length;

/** Setup up to the point where monitoring has started (day 0). */
async function start(scenario: "mr_tan" | "ms_lim", symptomText = "cough a bit since before CNY, just a cough lah") {
  const sid = fresh(scenario);
  await tap(sid, scenario === "mr_tan" ? "Add a trusted person" : "On my own");
  await say(sid, symptomText);
  await tap(sid, "No");
  const state = await tap(sid, "No");
  return { sid, state };
}

/** Same answers for both people: took medicine day 7, still got on days 7 and 14. */
async function runToSeeGp(scenario: "mr_tan" | "ms_lim") {
  const { sid } = await start(scenario);
  await go(sid, 7);
  await tap(sid, "Still got");
  await tap(sid, "Took medicine");
  await tap(sid, "Correct");
  await go(sid, 14);
  const state = await tap(sid, "Still got");
  return { sid, state };
}

describe("A1 onset: never invent the user's words", () => {
  it("keeps the user's own phrase and the minimum provable duration", async () => {
    const { state } = await start("mr_tan");
    expect(state.clockPanel.onsetRawText?.toLowerCase()).toBe("since before cny");
    expect(state.clockPanel.minDurationDays).toBe(4); // 16 Feb -> 20 Feb
    expect(state.clockPanel.confidence).toBe("approximate");
    expect(allText(state)).not.toContain("started a few days ago");
  });

  it("asks roughly when, and maps the button to the MINIMUM duration", async () => {
    const sid = fresh("ms_lim");
    await tap(sid, "On my own");
    let state = await say(sid, "my cough is annoying");
    expect(lastJaga(state).text).toBe(copy.ASK_ONSET);
    expect(lastJaga(state).buttons).toEqual(copy.ONSET_BUTTONS);
    state = await tap(sid, "About a week ago");
    expect(state.clockPanel.minDurationDays).toBe(7);
    expect(state.clockPanel.confidence).toBe("approximate");
  });
});

describe("A2 consent copy", () => {
  it("says the trusted person only hears at thresholds and the user sees it first", async () => {
    const sid = fresh("mr_tan");
    const state = await tap(sid, "Add a trusted person");
    const text = allText(state);
    expect(text).toContain("will only hear from me if something has gone on long enough");
    expect(text).toContain("You will see what I send her first");
    expect(text).not.toContain("kept in the loop");
  });

  it("respects 'On my own' even in the Mr Tan scenario", async () => {
    const sid = fresh("mr_tan");
    const state = await tap(sid, "On my own");
    expect(state.mode).toBe("independent");
  });
});

describe("A3 silence", () => {
  it("asks once on the check-in day and records nothing as silence yet", async () => {
    const { sid } = await start("ms_lim");
    const state = await go(sid, 7);
    expect(count(state, "Still coughing?")).toBe(1);
    expect(allText(state)).not.toContain("No reply");
    expect(state.clockPanel.missedCheckins).toBe(0);
  });

  it("records silence only when the NEXT check-in arrives unanswered, never as better", async () => {
    const { sid } = await start("ms_lim");
    await go(sid, 7);
    const state = await go(sid, 14);
    expect(count(state, copy.SILENCE_RECORDED)).toBe(1);
    expect(count(state, "Still coughing?")).toBe(2); // day 7 and day 14, never the same one twice
    expect(state.clockPanel.trajectory).not.toBe("better");
    expect(state.clockPanel.trajectory).not.toBe("gone");
  });
});

describe("A4 red flags are sticky and notify once", () => {
  it("blood then 'no lah': advice stays, trusted person told once", async () => {
    const { sid } = await start("mr_tan");
    await go(sid, 9);
    let state = await tap(sid, "Noticed blood");
    expect(state.lastResult?.action).toBe("SEE_DOCTOR_TODAY");
    state = await say(sid, "no lah nothing");
    expect(state.lastResult?.action).toBe("SEE_DOCTOR_TODAY");
    expect(lastJaga(state).text).toContain("my advice stays the same");
    expect(count(state, "Sent to Mei Ling")).toBe(1);
  });

  it("a red flag buried in a long message is caught", async () => {
    const { sid } = await start("ms_lim");
    await go(sid, 9);
    const state = await say(sid, "aiya still the same lor, this morning saw blood a bit but never mind, going market later");
    expect(state.lastResult?.action).toBe("SEE_DOCTOR_TODAY");
  });

  it("independent mode: nobody is ever told", async () => {
    const { sid } = await start("ms_lim");
    await go(sid, 9);
    const state = await tap(sid, "Noticed blood");
    expect(state.lastResult?.action).toBe("SEE_DOCTOR_TODAY");
    expect(allText(state)).not.toContain("Sent to");
    expect(getSession(sid)!.getSentToSupport()).toHaveLength(0);
  });
});

describe("A5 self-treatment needs confirmation", () => {
  it("shows unconfirmed until the user taps Correct", async () => {
    const { sid } = await start("ms_lim");
    let state = await tap(sid, "Took medicine");
    expect(lastJaga(state).text).toContain("Is that correct?");
    expect(state.clockPanel.selfTreatment).toEqual([{ label: "Cough syrup", confirmed: false }]);
    state = await tap(sid, "Correct");
    expect(state.clockPanel.selfTreatment).toEqual([{ label: "Cough syrup", confirmed: true }]);
  });

  it("'Not right' drops the label but keeps the fact that something was taken", async () => {
    const { sid } = await start("ms_lim");
    await tap(sid, "Took medicine");
    const state = await tap(sid, "Not right");
    expect(state.clockPanel.selfTreatment).toEqual([{ label: "unspecified", confirmed: false }]);
  });
});

describe("B2 to B6 care navigation: Mr Tan, supported", () => {
  it("full journey: SEE_GP, card, book, share preview, reminder, did you go, summary", async () => {
    let { sid, state } = await runToSeeGp("mr_tan");
    expect(state.lastResult?.action).toBe("SEE_GP");
    expect(state.lastResult?.ruleId).toBe("not_better_after_self_treatment");

    const cardMsg = lastJaga(state);
    expect(cardMsg.card?.simulated).toBe(true);
    expect(cardMsg.card?.label).toContain("PROTOTYPE DATA");
    expect(cardMsg.buttons).toEqual([
      "Book appointment",
      "Show other clinics",
      "Remind me later today",
      "Not now",
      "Ask Mei Ling to help",
    ]);
    expect(jaga(state).some((m) => m.sourceUrl?.includes("healthhub.sg"))).toBe(true);

    state = await tap(sid, "Book appointment");
    expect(allText(state)).toContain("Appointment (prototype): tomorrow, 10:30am at ABC Family Clinic");
    expect(jaga(state).some((m) => m.link?.href === "summary.html")).toBe(true);

    // Nothing leaves without [Send]
    expect(lastJaga(state).text).toContain("I'd like to tell Mei Ling:");
    expect(lastJaga(state).buttons).toEqual(["Send", "Don't send"]);
    expect(getSession(sid)!.getSentToSupport()).toHaveLength(0);
    state = await tap(sid, "Send");
    const sent = getSession(sid)!.getSentToSupport();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("cough has lasted at least");
    expect(count(state, "Sent to Mei Ling")).toBe(1);

    state = await go(sid, 15);
    expect(allText(state)).toContain("Reminder: your appointment (prototype) is today at 10:30am");
    state = await go(sid, 16);
    expect(lastJaga(state).text).toBe(copy.DID_YOU_GO);
    state = await tap(sid, "Yes");
    expect(lastJaga(state).text).toBe(copy.ASK_DOCTOR_SAID);
    state = await say(sid, "come back if still coughing after 2 weeks");

    const summary = getSession(sid)!.getSummary()!;
    expect(summary.onset.inTheirWords.toLowerCase()).toBe("since before cny");
    expect(summary.ruleFired?.policyStatus).toBe("PENDING CLINICIAN REVIEW");
    expect(summary.selfTreatment).toEqual([{ label: "Cough syrup", status: "confirmed by user" }]);
    expect(summary.timeline.some((r) => r.what.startsWith("Saw a doctor"))).toBe(true);
    expect(summary.footer).toBe("This is a record of what was reported. It is not a diagnosis.");
  });

  it("'Don't send' sends nothing", async () => {
    const { sid } = await runToSeeGp("mr_tan");
    await tap(sid, "Book appointment");
    const state = await tap(sid, "Don't send");
    expect(getSession(sid)!.getSentToSupport()).toHaveLength(0);
    expect(allText(state)).not.toContain("Sent to Mei Ling");
  });

  it("after the first offer, later check-ins get a short reminder, not the full card", async () => {
    const { sid } = await runToSeeGp("mr_tan");
    await tap(sid, "Remind me later today");
    await go(sid, 21);
    const before = jaga(getSession(sid)!.getState()).filter((m) => m.card).length;
    await tap(sid, "Not now");
    await tap(sid, "Not now");
    const state = await tap(sid, "Still got");
    expect(jaga(state).filter((m) => m.card).length).toBe(before);
  });
});

describe("Mode parity: Ms Lim, independent, gets the complete journey", () => {
  it("same action, same rule, same day, minus anything involving a support person", async () => {
    const tan = await runToSeeGp("mr_tan");
    const lim = await runToSeeGp("ms_lim");
    expect(lim.state.lastResult?.action).toBe(tan.state.lastResult?.action);
    expect(lim.state.lastResult?.ruleId).toBe(tan.state.lastResult?.ruleId);
    expect(lim.state.day).toBe(tan.state.day);
    expect(lim.state.clockPanel.minDurationDays).toBe(tan.state.clockPanel.minDurationDays);

    expect(lastJaga(lim.state).buttons).toEqual([
      "Book appointment",
      "Show other clinics",
      "Remind me later today",
      "Not now",
    ]);
    let state = await tap(lim.sid, "Book appointment");
    expect(allText(state)).toContain("Appointment (prototype)");
    expect(jaga(state).some((m) => m.link)).toBe(true);
    expect(allText(state)).not.toContain("I'd like to tell");
    state = await go(lim.sid, 15);
    expect(allText(state)).toContain("Reminder: your appointment");
    state = await go(lim.sid, 16);
    expect(lastJaga(state).text).toBe(copy.DID_YOU_GO);
    expect(getSession(lim.sid)!.getSentToSupport()).toHaveLength(0);
  });
});

describe("B3 'Not now' is respected", () => {
  it("declining twice leads to exactly one re-ask, 7 days later, then never again", async () => {
    const { sid } = await runToSeeGp("ms_lim");
    let state = await tap(sid, "Not now");
    expect(lastJaga(state).text).toBe(copy.ASK_WHEN);
    state = await tap(sid, "Not now");
    expect(lastJaga(state).text).toBe(copy.NOT_NOW_LOGGED);

    state = await go(sid, 20);
    expect(count(state, "A week ago you said not now")).toBe(0);
    state = await go(sid, 21);
    expect(count(state, "A week ago you said not now")).toBe(1);

    await tap(sid, "Not now");
    state = await go(sid, 60);
    expect(count(state, "A week ago you said not now")).toBe(1);
    expect(allText(state)).toContain("I won't ask again");
  });

  it("choosing a time stores the plan and follows up the day after", async () => {
    const { sid } = await runToSeeGp("ms_lim");
    await tap(sid, "Not now");
    let state = await tap(sid, "Tomorrow morning");
    expect(allText(state)).toContain("Okay: tomorrow morning");
    state = await go(sid, 16);
    expect(lastJaga(state).text).toBe(copy.DID_YOU_GO);
    state = await tap(sid, "Not yet");
    expect(lastJaga(state).buttons).toContain("This weekend");
  });
});

describe("Disagreement is not a medical rule", () => {
  it("user says better, trusted person says still coughing: one neutral question, no escalation", async () => {
    const { sid } = await start("mr_tan");
    await go(sid, 7);
    await tap(sid, "Better");
    const state = await say(sid, "he is still coughing every night", "support_person");
    expect(state.clockPanel.discordance).toBe(true);
    expect(state.lastResult?.action).toBe("KEEP_WATCHING");
    expect(count(state, "One quick check")).toBe(1);
    expect(state.clockPanel.trajectory).not.toBe("better");
  });
});

describe("B1 and B7 copy safety", () => {
  const banned = ["cancer", "tuberculosis", "pneumonia", "infection", "you have", "it's fine", "you are fine", "you're fine"];

  it("everything Jaga says in a full run avoids disease names and false reassurance", async () => {
    const { sid } = await runToSeeGp("mr_tan");
    await tap(sid, "Book appointment");
    await tap(sid, "Send");
    await go(sid, 16);
    await tap(sid, "Yes");
    const state = await say(sid, "watch for fever");
    const spoken = jaga(state).map((m) => m.text).join("\n").toLowerCase();
    const summary = JSON.stringify(getSession(sid)!.getSummary()).toLowerCase();
    for (const word of banned) {
      expect(spoken, `chat contains "${word}"`).not.toContain(word);
      expect(summary.replace("watch for fever", ""), `summary contains "${word}"`).not.toContain(word);
    }
    expect(/\bTB\b/.test(jaga(state).map((m) => m.text).join("\n"))).toBe(false);
  });

  it("every check-in ends with the escape hatch", async () => {
    const { sid } = await start("ms_lim");
    const state = await go(sid, 7);
    expect(lastJaga(state).text.endsWith(copy.ESCAPE_HATCH)).toBe(true);
  });

  it("prototype prices never appear as digits and every clinic is marked simulated", () => {
    for (const c of CLINICS) {
      expect(c.simulated).toBe(true);
      expect(c.label).toContain("PROTOTYPE DATA");
      expect(c.consult).toContain("$XX");
      expect(c.outOfPocket).toContain("$XX");
      expect(/\$\s?\d/.test(c.consult + c.outOfPocket)).toBe(false);
    }
  });

  it("A6: no em dashes or en dashes in user-facing copy or the web page", () => {
    const root = join(__dirname, "..", "..");
    const files = [
      ...readdirSync(join(root, "src", "copy")).map((f) => join(root, "src", "copy", f)),
      ...readdirSync(join(root, "web")).map((f) => join(root, "web", f)),
      join(root, "src", "navigation", "prototypeData.ts"),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text.includes("—") || text.includes("–"), `dash found in ${file}`).toBe(false);
    }
  });
});
