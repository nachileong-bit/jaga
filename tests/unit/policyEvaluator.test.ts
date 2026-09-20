// tests/unit/policyEvaluator.test.ts
import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../../src/core/policyEvaluator.js";
import { screenRedFlags, hasUnscreenedRedFlags } from "../../src/core/redFlagScreen.js";
import { loadPolicy } from "../../src/core/policyLoader.js";
import { SimulatedClock } from "../../src/core/clock.js";
import type { Episode, Observation, Onset } from "../../src/core/types.js";

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

describe("screenRedFlags (sticky)", () => {
  const policy = loadPolicy("cough");

  it("returns null when no red flags reported", () => {
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "mention" },
    ];
    expect(screenRedFlags(obs, policy)).toBeNull();
  });

  it("returns SEE_DOCTOR_TODAY when blood is reported", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-01",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported", breathless_or_chest_pain: "denied" },
      },
    ];
    const result = screenRedFlags(obs, policy);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("SEE_DOCTOR_TODAY");
    expect(result!.redFlagKey).toBe("blood");
    expect(result!.reportedBy).toBe("user");
    expect(result!.reportedAt).toBe("2026-01-01");
  });

  it("returns EMERGENCY_995 when breathless reported", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-01",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { breathless_or_chest_pain: "reported" },
      },
    ];
    const result = screenRedFlags(obs, policy);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("EMERGENCY_995");
    expect(result!.redFlagKey).toBe("breathless_or_chest_pain");
  });

  it("returns null when red flags only denied (never reported)", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-01",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "denied", breathless_or_chest_pain: "denied" },
      },
    ];
    expect(screenRedFlags(obs, policy)).toBeNull();
  });

  it("STICKY: reported then later denied → still reported", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-09",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
      },
      {
        id: "o2",
        episodeId: "e1",
        at: "2026-01-10",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "denied" },
      },
    ];
    const result = screenRedFlags(obs, policy);
    expect(result).not.toBeNull();
    expect(result!.redFlagKey).toBe("blood");
    expect(result!.reportedBy).toBe("user");
    expect(result!.reportedAt).toBe("2026-01-09");
  });

  it("STICKY: reported by user, denied by support person → still reported", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-09",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
      },
      {
        id: "o2",
        episodeId: "e1",
        at: "2026-01-10",
        reporter: "support_person",
        kind: "redflag_answer",
        redFlags: { blood: "denied" },
      },
    ];
    const result = screenRedFlags(obs, policy);
    expect(result).not.toBeNull();
    expect(result!.redFlagKey).toBe("blood");
    expect(result!.reportedBy).toBe("user");
  });

  it("EMERGENCY_995 takes priority over SEE_DOCTOR_TODAY when both reported", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-01",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
      },
      {
        id: "o2",
        episodeId: "e1",
        at: "2026-01-02",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { breathless_or_chest_pain: "reported" },
      },
    ];
    const result = screenRedFlags(obs, policy);
    expect(result!.action).toBe("EMERGENCY_995");
  });
});

describe("hasUnscreenedRedFlags", () => {
  const policy = loadPolicy("cough");

  it("returns true when no red flags answered", () => {
    const obs: Observation[] = [];
    expect(hasUnscreenedRedFlags(obs, policy)).toBe(true);
  });

  it("returns false when all red flags answered (denied)", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-01",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "denied", breathless_or_chest_pain: "denied" },
      },
    ];
    expect(hasUnscreenedRedFlags(obs, policy)).toBe(false);
  });

  it("returns true when one red flag unanswered", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-01",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "denied" },
      },
    ];
    expect(hasUnscreenedRedFlags(obs, policy)).toBe(true);
  });

  it("returns false for a red flag that was once reported (sticky)", () => {
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-09",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
      },
      {
        id: "o2",
        episodeId: "e1",
        at: "2026-01-10",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "denied" },
      },
    ];
    expect(hasUnscreenedRedFlags(obs, policy)).toBe(true); // breathless still unanswered
  });
});

describe("evaluatePolicy", () => {
  const policy = loadPolicy("cough");

  it("returns KEEP_WATCHING for new episode", () => {
    clock.advanceToDay(0);
    const obs: Observation[] = [];
    const result = evaluatePolicy(baseEpisode, obs, policy, clock);
    expect(result.action).toBe("KEEP_WATCHING");
    expect(result.followUps).toEqual([]);
  });

  it("fires not_better_after_self_treatment at day 15", () => {
    clock.advanceToDay(15);
    const episode: Episode = { ...baseEpisode, trajectory: "same" };
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "mention", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-03", reporter: "user", kind: "self_treatment", rawText: "cough syrup" },
      { id: "o3", episodeId: "e1", at: "2026-01-15", reporter: "user", kind: "checkin", trajectory: "same" },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("SEE_GP");
    expect(result.ruleId).toBe("not_better_after_self_treatment");
    expect(result.followUps).toEqual([]);
  });

  it("fires worsening when trajectory is worse", () => {
    clock.advanceToDay(5);
    const episode: Episode = { ...baseEpisode, trajectory: "worse" };
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "mention", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-05", reporter: "user", kind: "checkin", trajectory: "worse" },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("SEE_GP");
    expect(result.ruleId).toBe("worsening");
  });

  it("fires long_duration at day 56", () => {
    clock.advanceToDay(56);
    const episode: Episode = { ...baseEpisode, trajectory: "same" };
    const obs: Observation[] = [];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("SEE_GP");
    expect(result.ruleId).toBe("long_duration");
  });

  it("red flag overrides duration rules", () => {
    clock.advanceToDay(60);
    const episode: Episode = { ...baseEpisode, trajectory: "same" };
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-60",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
      },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("SEE_DOCTOR_TODAY");
    expect(result.redFlagKey).toBe("blood");
  });

  it("EMERGENCY_995 takes priority over SEE_GP", () => {
    clock.advanceToDay(60);
    const episode: Episode = { ...baseEpisode, trajectory: "worse" };
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "self_treatment", rawText: "syrup" },
      {
        id: "o2",
        episodeId: "e1",
        at: "2026-01-60",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { breathless_or_chest_pain: "reported" },
      },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("EMERGENCY_995");
  });

  it("STICKY: red flag stays after later deny", () => {
    clock.advanceToDay(10);
    const episode: Episode = { ...baseEpisode, trajectory: "same" };
    const obs: Observation[] = [
      {
        id: "o1",
        episodeId: "e1",
        at: "2026-01-09",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
      },
      {
        id: "o2",
        episodeId: "e1",
        at: "2026-01-10",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "denied" },
      },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("SEE_DOCTOR_TODAY");
    expect(result.redFlagKey).toBe("blood");
  });
});

describe("loadPolicy / loadAllPolicies", () => {
  it("loads cough policy with correct fields", () => {
    const policy = loadPolicy("cough");
    expect(policy.id).toBe("cough");
    expect(policy.status).toBe("PENDING_CLINICIAN_REVIEW");
    expect(policy.redFlags.length).toBeGreaterThan(0);
    expect(policy.rules.length).toBeGreaterThan(0);
    expect(policy.checkinEveryDays).toBe(7);
  });

  it("loads mouth-ulcer policy with correct fields", () => {
    const policy = loadPolicy("mouth_ulcer");
    expect(policy.id).toBe("mouth_ulcer");
    expect(policy.status).toBe("PENDING_CLINICIAN_REVIEW");
    expect(policy.checkinEveryDays).toBe(5);
  });

  it("throws on non-existent policy", () => {
    expect(() => loadPolicy("nonexistent" as any)).toThrow();
  });

  it("cough policy has no discordance rule", () => {
    const policy = loadPolicy("cough");
    expect(policy.rules.find((r) => r.id === "discordance")).toBeUndefined();
  });
});
