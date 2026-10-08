// tests/unit/episodeStateMachine.test.ts
import { describe, it, expect } from "vitest";
import {
  nextState,
  computeTrajectory,
  minDurationDays,
  computeMissedCheckins,
  applyObservation,
  shouldResolve,
} from "../../src/core/episodeStateMachine.js";
import { SimulatedClock } from "../../src/core/clock.js";
import type { Episode, Observation, Onset } from "../../src/core/types.js";

const baseOnset: Onset = {
  rawText: "started coughing",
  latestPossible: "2026-01-01T08:00:00.000Z",
  confidence: "exact",
};

const baseEpisode: Episode = {
  id: "ep-1",
  personId: "p-1",
  symptom: "cough",
  onset: baseOnset,
  state: "ACTIVE",
  trajectory: "unknown",
  discordance: false,
  missedCheckins: 0,
  policyId: "cough",
  policyVersion: "0.2.0",
};

const CHECKIN_EVERY = 7;

describe("nextState", () => {
  it("ACTIVE + better → IMPROVING", () => {
    expect(nextState("ACTIVE", "better")).toBe("IMPROVING");
  });

  it("ACTIVE + same → ACTIVE", () => {
    expect(nextState("ACTIVE", "same")).toBe("ACTIVE");
  });

  it("ACTIVE + worse → ACTIVE", () => {
    expect(nextState("ACTIVE", "worse")).toBe("ACTIVE");
  });

  it("IMPROVING + same → RECURRENT", () => {
    expect(nextState("IMPROVING", "same")).toBe("RECURRENT");
  });

  it("IMPROVING + worse → RECURRENT", () => {
    expect(nextState("IMPROVING", "worse")).toBe("RECURRENT");
  });

  it("IMPROVING + intermittent → RECURRENT", () => {
    expect(nextState("IMPROVING", "intermittent")).toBe("RECURRENT");
  });

  it("IMPROVING + better → IMPROVING", () => {
    expect(nextState("IMPROVING", "better")).toBe("IMPROVING");
  });

  it("RECURRENT + better → IMPROVING", () => {
    expect(nextState("RECURRENT", "better")).toBe("IMPROVING");
  });

  it("RESOLVED stays RESOLVED", () => {
    expect(nextState("RESOLVED", "better")).toBe("RESOLVED");
    expect(nextState("RESOLVED", "worse")).toBe("RESOLVED");
  });
});

describe("computeTrajectory", () => {
  it("returns unknown when no trajectories reported", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "mention" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.trajectory).toBe("unknown");
    expect(result.discordance).toBe(false);
  });

  it("uses last user trajectory", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "checkin", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-02", reporter: "user", kind: "checkin", trajectory: "better" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.trajectory).toBe("better");
    expect(result.discordance).toBe(false);
  });

  it("detects discordance: user better, support same (same window)", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-02T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "better" },
      { id: "o3", episodeId: "e1", at: "2026-01-03T08:00:00Z", reporter: "support_person", kind: "checkin", trajectory: "same" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.trajectory).toBe("same");
    expect(result.discordance).toBe(true);
  });

  it("detects discordance: support better, user worse (same window)", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00Z", reporter: "support_person", kind: "checkin", trajectory: "better" },
      { id: "o2", episodeId: "e1", at: "2026-01-02T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "worse" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.trajectory).toBe("worse");
    expect(result.discordance).toBe(true);
  });

  it("no discordance when reports are outside the check-in window", () => {
    // Support says "same" on day 3, user says "better" on day 30 — different windows
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-03T08:00:00Z", reporter: "support_person", kind: "checkin", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-30T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "better" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.trajectory).toBe("better");
    expect(result.discordance).toBe(false);
  });

  it("no conflict when support only", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "support_person", kind: "checkin", trajectory: "same" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.trajectory).toBe("same");
    expect(result.discordance).toBe(false);
  });

  it("discordance at exact window boundary (7 days apart)", () => {
    // Exactly 7 days apart = within window (<= checkinEveryDays)
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "better" },
      { id: "o2", episodeId: "e1", at: "2026-01-08T08:00:00Z", reporter: "support_person", kind: "checkin", trajectory: "same" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.discordance).toBe(true);
  });

  it("no discordance just past window (8 days apart)", () => {
    // 8 days apart = outside 7-day window
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "better" },
      { id: "o2", episodeId: "e1", at: "2026-01-09T08:00:00Z", reporter: "support_person", kind: "checkin", trajectory: "same" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    expect(result.discordance).toBe(false);
  });
});

describe("minDurationDays", () => {
  it("computes days since latest possible onset", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(10);
    expect(minDurationDays(baseEpisode, clock)).toBe(10);
  });

  it("floors to whole days", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(14);
    expect(minDurationDays(baseEpisode, clock)).toBe(14);
  });

  it("never returns negative", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    // Day before onset — should be 0 not negative
    clock.setTo("2025-12-31T08:00:00.000Z");
    expect(minDurationDays(baseEpisode, clock)).toBe(0);
  });
});

describe("computeMissedCheckins", () => {
  it("returns 0 when within check-in window", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(3);
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00.000Z", reporter: "user", kind: "checkin", trajectory: "same" },
    ];
    expect(computeMissedCheckins(baseEpisode, obs, 7, clock)).toBe(0);
  });

  it("returns 1 after one missed check-in window", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(8);
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00.000Z", reporter: "user", kind: "checkin", trajectory: "same" },
    ];
    expect(computeMissedCheckins(baseEpisode, obs, 7, clock)).toBe(1);
  });

  it("returns 2 after two missed check-in windows", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(15);
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00.000Z", reporter: "user", kind: "checkin", trajectory: "same" },
    ];
    expect(computeMissedCheckins(baseEpisode, obs, 7, clock)).toBe(2);
  });
});

describe("applyObservation", () => {
  it("updates trajectory and state", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(5);
    const newObs: Observation = {
      id: "o2",
      episodeId: "e1",
      at: clock.now(),
      reporter: "user",
      kind: "checkin",
      trajectory: "better",
    };
    const result = applyObservation(baseEpisode, [], newObs, clock, CHECKIN_EVERY);
    expect(result.trajectory).toBe("better");
    expect(result.state).toBe("IMPROVING");
    expect(result.lastActionAt).toBe(clock.now());
  });

  it("resets missedCheckins on check-in", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(10);
    const episodeWithMissed: Episode = { ...baseEpisode, missedCheckins: 2 };
    const newObs: Observation = {
      id: "o2",
      episodeId: "e1",
      at: clock.now(),
      reporter: "user",
      kind: "checkin",
      trajectory: "same",
    };
    const result = applyObservation(episodeWithMissed, [], newObs, clock, CHECKIN_EVERY);
    expect(result.missedCheckins).toBe(0);
  });

  it("updates lastCheckinAt on check-in", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(7);
    const newObs: Observation = {
      id: "o2",
      episodeId: "e1",
      at: clock.now(),
      reporter: "user",
      kind: "checkin",
      trajectory: "same",
    };
    const result = applyObservation(baseEpisode, [], newObs, clock, CHECKIN_EVERY);
    expect(result.lastCheckinAt).toBe(clock.now());
  });

  it("does NOT double-count the new observation", () => {
    // If we pass prior observations (without the new obs) and the new obs,
    // applyObservation should append it once — not twice.
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(5);
    const priorObs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "same" },
    ];
    const newObs: Observation = {
      id: "o2",
      episodeId: "e1",
      at: clock.now(),
      reporter: "user",
      kind: "checkin",
      trajectory: "better",
    };
    // The result should reflect "better" from the new obs being counted once
    const result = applyObservation(baseEpisode, priorObs, newObs, clock, CHECKIN_EVERY);
    expect(result.trajectory).toBe("better");
  });
});

describe("shouldResolve", () => {
  it("returns false when threshold is null", () => {
    const improvingEpisode: Episode = { ...baseEpisode, state: "IMPROVING", trajectory: "better" };
    expect(shouldResolve(improvingEpisode, 7, null)).toBe(false);
  });

  it("returns true when symptom-free days >= threshold", () => {
    const improvingEpisode: Episode = { ...baseEpisode, state: "IMPROVING", trajectory: "better" };
    expect(shouldResolve(improvingEpisode, 7, 7)).toBe(true);
  });

  it("returns false when trajectory is not better", () => {
    const sameEpisode: Episode = { ...baseEpisode, trajectory: "same" };
    expect(shouldResolve(sameEpisode, 14, 7)).toBe(false);
  });
});
