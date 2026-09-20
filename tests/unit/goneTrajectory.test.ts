// tests/unit/goneTrajectory.test.ts
// Tests for the "gone" trajectory value added in M2.
// "gone" is treated like "better" for policy rules and state transitions.

import { describe, it, expect } from "vitest";
import {
  nextState,
  computeTrajectory,
  shouldResolve,
  applyObservation,
} from "../../src/core/episodeStateMachine.js";
import { evaluatePolicy } from "../../src/core/policyEvaluator.js";
import { loadPolicy } from "../../src/core/policyLoader.js";
import { SimulatedClock } from "../../src/core/clock.js";
import type { Episode, Observation, Onset, Trajectory } from "../../src/core/types.js";

const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");

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
  policyVersion: "0.1.0",
};

const CHECKIN_EVERY = 7;

describe("'gone' trajectory", () => {
  it("is a valid Trajectory value", () => {
    const traj: Trajectory = "gone";
    expect(traj).toBe("gone");
  });

  it("nextState treats 'gone' like 'better': ACTIVE → IMPROVING", () => {
    expect(nextState("ACTIVE", "gone")).toBe("IMPROVING");
  });

  it("nextState treats 'gone' like 'better': IMPROVING → IMPROVING (null threshold)", () => {
    expect(nextState("IMPROVING", "gone", null, 0)).toBe("IMPROVING");
  });

  it("nextState resolves when threshold is met and trajectory is 'gone'", () => {
    expect(nextState("IMPROVING", "gone", 7, 7)).toBe("RESOLVED");
  });

  it("nextState does not resolve when threshold not met", () => {
    expect(nextState("IMPROVING", "gone", 14, 7)).toBe("IMPROVING");
  });

  it("shouldResolve treats 'gone' like 'better'", () => {
    const goneEpisode: Episode = { ...baseEpisode, trajectory: "gone" };
    expect(shouldResolve(goneEpisode, 7, 7)).toBe(true);
  });

  it("shouldResolve returns false when threshold is null", () => {
    const goneEpisode: Episode = { ...baseEpisode, trajectory: "gone" };
    expect(shouldResolve(goneEpisode, 100, null)).toBe(false);
  });

  it("computeTrajectory uses 'gone' as last user trajectory", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-02T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "gone" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    // "gone" is treated like "better" for the final trajectory
    expect(result.trajectory).toBe("better");
    expect(result.discordance).toBe(false);
  });

  it("policy evaluator: 'gone' does not match trajectoryIn same/worse/intermittent", () => {
    clock.advanceToDay(15);
    const policy = loadPolicy("cough");
    const episode: Episode = { ...baseEpisode, trajectory: "gone" };
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "mention", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-03", reporter: "user", kind: "self_treatment", rawText: "syrup" },
      { id: "o3", episodeId: "e1", at: "2026-01-15", reporter: "user", kind: "checkin", trajectory: "gone" },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    // "gone" is like "better" — should NOT fire not_better_after_self_treatment
    expect(result.action).toBe("KEEP_WATCHING");
  });

  it("policy evaluator: 'gone' does not match worsening rule", () => {
    clock.advanceToDay(5);
    const policy = loadPolicy("cough");
    const episode: Episode = { ...baseEpisode, trajectory: "gone" };
    const obs: Observation[] = [];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("KEEP_WATCHING");
  });

  it("discordance: user says 'gone', support says 'same' → discordant, trajectory same", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01T08:00:00Z", reporter: "user", kind: "checkin", trajectory: "gone" },
      { id: "o2", episodeId: "e1", at: "2026-01-02T08:00:00Z", reporter: "support_person", kind: "checkin", trajectory: "same" },
    ];
    const result = computeTrajectory(obs, CHECKIN_EVERY);
    // "gone" is treated like "better" — so user says better, support says same → discordant
    expect(result.discordance).toBe(true);
    expect(result.trajectory).toBe("same");
  });

  it("applyObservation with 'gone' transitions ACTIVE → IMPROVING", () => {
    clock.advanceToDay(7);
    const newObs: Observation = {
      id: "o2",
      episodeId: "e1",
      at: clock.now(),
      reporter: "user",
      kind: "checkin",
      trajectory: "gone",
    };
    const result = applyObservation(baseEpisode, [], newObs, clock, CHECKIN_EVERY, null);
    expect(result.trajectory).toBe("better"); // "gone" normalised to "better" for state
    expect(result.state).toBe("IMPROVING");
  });
});
