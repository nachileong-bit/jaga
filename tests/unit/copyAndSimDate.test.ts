// tests/unit/copyAndSimDate.test.ts
// Tests for prompt 07: copy changes (GREETING, ASK_SYMPTOM) and simDate in state.

import { describe, it, expect } from "vitest";
import { createSession, getSession } from "../../src/conversation/flow.js";
import * as copy from "../../src/copy/en.js";

describe("Prompt 07 copy changes", () => {
  it("GREETING mentions cough, GP, and the no-diagnosis disclaimer", () => {
    expect(copy.GREETING).toContain("cough");
    expect(copy.GREETING).toContain("GP");
    expect(copy.GREETING).toContain("not a doctor");
    expect(copy.GREETING).toContain("don't diagnose");
  });

  it("ASK_SYMPTOM asks about the cough and says other symptoms are not covered", () => {
    expect(copy.ASK_SYMPTOM).toContain("cough");
    expect(copy.ASK_SYMPTOM).toContain("aren't covered");
    expect(copy.ASK_SYMPTOM).toContain("your own words");
  });

  it("has no em dashes or en dashes in the updated copy", () => {
    expect(copy.GREETING).not.toContain("—");
    expect(copy.GREETING).not.toContain("–");
    expect(copy.ASK_SYMPTOM).not.toContain("—");
    expect(copy.ASK_SYMPTOM).not.toContain("–");
  });
});

describe("simDate in DemoState", () => {
  it("state includes simDate as an ISO string", () => {
    const sid = "simdate-test-1";
    createSession(sid, "mr_tan");
    const state = getSession(sid)!.getState();
    expect(state.simDate).toBeDefined();
    expect(typeof state.simDate).toBe("string");
    // Must be a valid ISO date
    const d = new Date(state.simDate);
    expect(d.getTime()).not.toBeNaN();
  });

  it("simDate is the demo start date on day 0", () => {
    const sid = "simdate-test-2";
    createSession(sid, "mr_tan");
    const state = getSession(sid)!.getState();
    expect(state.day).toBe(0);
    // CLOCK_START in flow.ts = 2026-02-20T08:00:00.000Z
    expect(state.simDate).toBe("2026-02-20T08:00:00.000Z");
  });

  it("simDate advances when the clock moves forward", async () => {
    const sid = "simdate-test-3";
    createSession(sid, "mr_tan");
    const before = getSession(sid)!.getState().simDate;
    await getSession(sid)!.handleAdvance({ toDay: 7 });
    const after = getSession(sid)!.getState().simDate;
    expect(after).not.toBe(before);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});
