// tests/unit/apiTests.test.ts
// API-level tests using the DemoSession and simulated clock.
// Tests: full Mr Tan run to SEE_GP; Ms Lim parity; silence stays unknown;
// red flag sticky after deny; nothing notified in independent mode.

import { describe, it, expect } from "vitest";
import { createSession, getSession, deleteSession } from "../../src/conversation/flow.js";
import type { DemoState } from "../../src/conversation/types.js";

let sessionCounter = 0;
function newSessionId(): string {
  return `test-session-${++sessionCounter}`;
}

async function freshSession(scenario: "mr_tan" | "ms_lim") {
  const sid = newSessionId();
  createSession(sid, scenario);
  return { sid, session: getSession(sid)! };
}

async function send(sessionId: string, text?: string, button?: string, reporter?: "user" | "support_person"): Promise<DemoState> {
  const session = getSession(sessionId)!;
  return session.handleMessage({ text, button, reporter });
}

async function advanceTo(sessionId: string, toDay: number): Promise<DemoState> {
  const session = getSession(sessionId)!;
  return session.handleAdvance({ toDay });
}

describe("Mr Tan full run to SEE_GP", () => {
  it("reaches SEE_GP on day 15 after self-treatment and same trajectory", async () => {
    const { sid } = await freshSession("mr_tan");

    // Step 1: Mode selection — pick "Add a trusted person"
    let state = await send(sid, null, "Add a trusted person");
    expect(state.mode).toBe("supported");

    // Step 2: Symptom mention
    state = await send(sid, "I have a cough");
    // After symptom mention, should be in red-flag screening phase

    // Step 3: Red flag blood — No
    state = await send(sid, null, "No");

    // Step 4: Red flag breathless — No
    state = await send(sid, null, "No");

    // Now in monitoring — advance to day 3 and report self-treatment
    state = await advanceTo(sid, 3);
    state = await send(sid, null, "Took medicine");

    // Advance to day 15 — check-in should fire
    state = await advanceTo(sid, 15);

    // Answer check-in: "Still got"
    state = await send(sid, null, "Still got");

    // Should now have SEE_GP from not_better_after_self_treatment rule
    const lastResult = state.lastResult;
    expect(lastResult).toBeDefined();
    expect(lastResult!.action).toBe("SEE_GP");
    expect(lastResult!.ruleId).toBe("not_better_after_self_treatment");

    // Check transcript has the explain text and prototype label
    const jagaMsg = state.transcript.filter((t) => t.role === "jaga").pop();
    expect(jagaMsg).toBeDefined();
    expect(jagaMsg!.prototypeLabel).toBe(true);

    deleteSession(sid);
  });
});

describe("Ms Lim mode parity", () => {
  it("reaches SEE_GP on the same day as Mr Tan given same answers", async () => {
    // Mr Tan run
    const { sid: mrTanSid } = await freshSession("mr_tan");
    await send(mrTanSid, null, "Add a trusted person");
    await send(mrTanSid, "I have a cough");
    await send(mrTanSid, null, "No");
    await send(mrTanSid, null, "No");
    await advanceTo(mrTanSid, 3);
    await send(mrTanSid, null, "Took medicine");
    await advanceTo(mrTanSid, 15);
    const mrTanState = await send(mrTanSid, null, "Still got");

    // Ms Lim run — same answers
    const { sid: msLimSid } = await freshSession("ms_lim");
    await send(msLimSid, null, "On my own");
    await send(msLimSid, "I have a cough");
    await send(msLimSid, null, "No");
    await send(msLimSid, null, "No");
    await advanceTo(msLimSid, 3);
    await send(msLimSid, null, "Took medicine");
    await advanceTo(msLimSid, 15);
    const msLimState = await send(msLimSid, null, "Still got");

    // Both should have the same action and same day
    expect(msLimState.lastResult!.action).toBe(mrTanState.lastResult!.action);
    expect(msLimState.lastResult!.ruleId).toBe(mrTanState.lastResult!.ruleId);
    expect(msLimState.day).toBe(mrTanState.day);

    // Mr Tan is supported — should have Mei Ling notified
    // Ms Lim is independent — no notification
    const mrTanNotified = mrTanState.transcript.some(
      (t) => t.role === "jaga" && t.text.includes("Mei Ling notified")
    );
    const msLimNotified = msLimState.transcript.some(
      (t) => t.role === "jaga" && t.text.includes("notified")
    );
    expect(mrTanNotified).toBe(false); // SEE_GP is not a red flag, so no notification
    expect(msLimNotified).toBe(false);

    deleteSession(mrTanSid);
    deleteSession(msLimSid);
  });
});

describe("Silence stays unknown", () => {
  it("missed check-ins result in unknown trajectory, not better", async () => {
    const { sid } = await freshSession("ms_lim");
    await send(sid, null, "On my own");
    await send(sid, "I have a cough");
    await send(sid, null, "No");
    await send(sid, null, "No");

    // Advance past check-in day without answering
    const state = await advanceTo(sid, 15);

    // Trajectory should not be "better" — it should be unknown or same
    const traj = state.clockPanel.trajectory;
    expect(traj).not.toBe("better");
    expect(traj).not.toBe("gone");

    // Missed check-ins should be > 0
    expect(state.clockPanel.missedCheckins).toBeGreaterThan(0);

    deleteSession(sid);
  });
});

describe("Red flag sticky after deny", () => {
  it("red flag on day 9, then 'no lah' on day 10 stays SEE_DOCTOR_TODAY", async () => {
    const { sid } = await freshSession("ms_lim");
    await send(sid, null, "On my own");
    await send(sid, "I have a cough");
    await send(sid, null, "No"); // blood: no
    await send(sid, null, "No"); // breathless: no

    // Advance to day 9
    await advanceTo(sid, 9);

    // Report blood via "Noticed blood" button
    const stateAfterReport = await send(sid, null, "Noticed blood");
    expect(stateAfterReport.lastResult!.action).toBe("SEE_DOCTOR_TODAY");
    expect(stateAfterReport.lastResult!.redFlagKey).toBe("blood");

    // Advance to day 10
    await advanceTo(sid, 10);

    // Deny blood with "no lah"
    const stateAfterDeny = await send(sid, "no lah");
    expect(stateAfterDeny.lastResult!.action).toBe("SEE_DOCTOR_TODAY");
    expect(stateAfterDeny.lastResult!.redFlagKey).toBe("blood");

    // Red flag should be reported in the clock panel
    const bloodRf = stateAfterDeny.clockPanel.redFlags.find((rf) => rf.key === "blood");
    expect(bloodRf).toBeDefined();
    expect(bloodRf!.status).toBe("reported");

    deleteSession(sid);
  });
});

describe("Independent mode: no notifications", () => {
  it("nothing is notified in independent mode even on red flag", async () => {
    const { sid } = await freshSession("ms_lim");
    await send(sid, null, "On my own");
    await send(sid, "I have a cough");
    await send(sid, null, "No");
    await send(sid, null, "No");

    await advanceTo(sid, 5);

    // Report blood
    const state = await send(sid, null, "Noticed blood");

    // Check no "notified" messages in transcript
    const notifiedMessages = state.transcript.filter(
      (t) => t.role === "jaga" && t.text.includes("notified")
    );
    expect(notifiedMessages.length).toBe(0);

    // But the red flag instruction should be there
    const redFlagMsgs = state.transcript.filter(
      (t) => t.role === "jaga" && t.text.includes("doctor")
    );
    expect(redFlagMsgs.length).toBeGreaterThan(0);

    deleteSession(sid);
  });

  it("supported mode notifies Mei Ling on red flag", async () => {
    const { sid } = await freshSession("mr_tan");
    await send(sid, null, "Add a trusted person");
    await send(sid, "I have a cough");
    await send(sid, null, "No");
    await send(sid, null, "No");

    await advanceTo(sid, 5);

    // Report blood
    const state = await send(sid, null, "Noticed blood");

    // Should have "Mei Ling notified (as agreed)" in transcript
    const notifiedMessages = state.transcript.filter(
      (t) => t.role === "jaga" && t.text.includes("Mei Ling notified")
    );
    expect(notifiedMessages.length).toBe(1);

    deleteSession(sid);
  });
});
