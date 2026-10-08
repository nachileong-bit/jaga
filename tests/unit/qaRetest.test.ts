// tests/unit/qaRetest.test.ts
// Fixes from the second end-to-end QA pass on the live demo.

import { describe, it, expect } from "vitest";
import { createSession, getSession } from "../../src/conversation/flow.js";
import type { DemoState } from "../../src/conversation/types.js";
import * as copy from "../../src/copy/en.js";

let n = 0;
const fresh = (sc: "mr_tan" | "ms_lim") => { const id = `qa2-${++n}`; createSession(id, sc); return getSession(id)!; };
const jaga = (st: DemoState) => st.transcript.filter((t) => t.role === "jaga" && t.text);
const last = (st: DemoState) => jaga(st).at(-1)!;

describe("QA retest fixes", () => {
  it("'heart attack' at a warning-sign question gives 995, alerts the trusted person and asks the question again with buttons", async () => {
    const s = fresh("mr_tan");
    await s.handleMessage({ button: "Add a trusted person" });
    await s.handleMessage({ text: "cough since before CNY" });
    const st = await s.handleMessage({ text: "heart attack" });
    const texts = jaga(st).map((t) => t.text);
    expect(texts).toContain(copy.EMERGENCY_NOW);
    expect(last(st).text).toBe(copy.RED_FLAG_QUESTIONS.blood);
    expect(last(st).buttons).toEqual(copy.YES_NO);
    expect(s.getSentToSupport().some((m) => m.urgent)).toBe(true);
  });

  it("'a bit breathless when climb stairs' at the symptom step says see a doctor today, not 'not covered' and not 995", async () => {
    const s = fresh("mr_tan");
    await s.handleMessage({ button: "Add a trusted person" });
    const st = await s.handleMessage({ text: "a bit breathless when climb stairs" });
    const texts = jaga(st).map((t) => t.text);
    expect(texts).toContain(copy.BREATHLESS_EFFORT_NO_COUGH);
    expect(texts).not.toContain(copy.NOT_COVERED_YET);
    expect(texts).not.toContain(copy.EMERGENCY_NOW);
    expect(st.phase).toBe("symptom");
  });

  it("typing a question at the first choice does not silently pick 'On my own'", async () => {
    const s = fresh("ms_lim");
    const st = await s.handleMessage({ text: "do I have cancer?" });
    expect(jaga(st).map((t) => t.text)).toContain(copy.KB_NO_DIAGNOSIS);
    expect(st.phase).toBe("mode");
    expect(last(st).text).toBe(copy.MODE_QUESTION);
  });

  it("asks 'did you go?' the day after the appointment even when the clock jumps a week", async () => {
    const s = fresh("mr_tan");
    await s.handleMessage({ button: "Add a trusted person" });
    await s.handleMessage({ text: "cough 3 weeks already" });
    await s.handleMessage({ button: "No" });
    await s.handleMessage({ button: "No" });
    await s.handleMessage({ button: "Book appointment" });
    await s.handleMessage({ button: "Send" }); // share with Mei Ling
    const st = await s.handleAdvance({ toDay: 7 });
    const went = st.transcript.find((t) => t.text === copy.DID_YOU_GO);
    expect(went?.day).toBe(2);
    expect(st.transcript.filter((t) => t.text?.startsWith("Reminder: your appointment")).map((t) => t.day)).toEqual([1]);
  });
});
