import { describe, it, expect } from "vitest";
import { createSession, getSession } from "../../src/conversation/flow";

async function start() {
  const id = `qa2-${Math.random()}`;
  createSession(id, "mr_tan");
  const s = getSession(id)!;
  await s.handleMessage({ button: "Add a trusted person", reporter: "user" });
  await s.handleMessage({ text: "Cough 3 weeks already, got phlegm", reporter: "user" });
  await s.handleMessage({ button: "No", reporter: "user" });
  await s.handleMessage({ button: "No", reporter: "user" });
  return s;
}

describe("QA retest 2 (founder's live run, 9 Oct)", () => {
  it("a clinic card left unanswered comes back at the next check-in instead of silence", async () => {
    const s = await start();
    const before = s.getState().transcript.length;
    const st = await s.handleAdvance({ toDay: 7 });
    const added = st.transcript.slice(before);
    expect(added.some((t) => t.text.includes("didn't get to sort out a visit"))).toBe(true);
    expect(added.some((t) => t.buttons?.includes("Book appointment"))).toBe(true);
  });

  it("the Day 14 sticker is not shown for a 21-day cough", async () => {
    const s = await start();
    expect(s.getState().transcript.some((t) => t.sticker === "04-day-14.png")).toBe(false);
  });
});

describe("QA retest 2: small talk and early cough", () => {
  it('"hi" at the symptom step asks about the cough again, not "not covered"', async () => {
    const id = `qa2b-${Math.random()}`;
    createSession(id, "mr_tan");
    const s = getSession(id)!;
    await s.handleMessage({ button: "On my own", reporter: "user" });
    const st = await s.handleMessage({ text: "hi", reporter: "user" });
    const last = st.transcript[st.transcript.length - 1];
    expect(last.text).toContain("Tell me about your cough");
  });

  it("a cough typed before the first choice is acknowledged as kept", async () => {
    const id = `qa2c-${Math.random()}`;
    createSession(id, "mr_tan");
    const s = getSession(id)!;
    const st = await s.handleMessage({ text: "cough 2 weeks", reporter: "user" });
    expect(st.transcript.some((t) => t.text.includes("kept what you said"))).toBe(true);
  });
});
