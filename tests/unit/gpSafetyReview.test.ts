// tests/unit/gpSafetyReview.test.ts
// Tests for the GP safety review (prompt 08): one test per change.

import { describe, it, expect } from "vitest";
import { loadPolicy } from "../../src/core/policyLoader.js";
import { evaluatePolicy } from "../../src/core/policyEvaluator.js";
import { screenRedFlags, hasUnscreenedRedFlags } from "../../src/core/redFlagScreen.js";
import { ScriptedExtractor, extractOnset } from "../../src/llm/ScriptedExtractor.js";
import { redFlagMessage } from "../../src/copy/en.js";
import * as copy from "../../src/copy/en.js";
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
  policyVersion: "0.2.0",
};

describe("GP safety review (prompt 08)", () => {
  // Change 1a: cough policy version 0.2.0
  it("cough policy is version 0.2.0", () => {
    const policy = loadPolicy("cough");
    expect(policy.version).toBe("0.2.0");
  });

  // Change 1b: three_weeks_any rule
  it("fires three_weeks_any at day 21 without self-treatment", () => {
    clock.advanceToDay(21);
    const policy = loadPolicy("cough");
    const episode: Episode = { ...baseEpisode, trajectory: "same" };
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "mention", trajectory: "same" },
      { id: "o2", episodeId: "e1", at: "2026-01-21", reporter: "user", kind: "checkin", trajectory: "same" },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("SEE_GP");
    expect(result.ruleId).toBe("three_weeks_any");
  });

  it("a cough over three weeks gets SEE_GP even with medicine and unknown progress", () => {
    clock.advanceToDay(21);
    const policy = loadPolicy("cough");
    const episode: Episode = { ...baseEpisode, trajectory: "unknown" };
    const obs: Observation[] = [
      { id: "o1", episodeId: "e1", at: "2026-01-01", reporter: "user", kind: "mention" },
      { id: "o2", episodeId: "e1", at: "2026-01-08", reporter: "user", kind: "self_treatment", item: { label: "Cough syrup", confirmed: true } },
    ];
    const result = evaluatePolicy(episode, obs, policy, clock);
    expect(result.action).toBe("SEE_GP");
  });

  // Change 1c: blood is EMERGENCY_995 in cough policy
  it("blood red flag action is EMERGENCY_995 in cough policy", () => {
    const policy = loadPolicy("cough");
    const blood = policy.redFlags.find((f) => f.key === "blood");
    expect(blood?.action).toBe("EMERGENCY_995");
  });

  // Change 1d: five new GP warning signs (SEE_GP, sticky)
  it("cough policy has five new SEE_GP warning signs", () => {
    const policy = loadPolicy("cough");
    const keys = policy.redFlags.filter((f) => f.action === "SEE_GP").map((f) => f.key);
    expect(keys).toContain("high_fever");
    expect(keys).toContain("weight_loss");
    expect(keys).toContain("night_sweats");
    expect(keys).toContain("coloured_phlegm");
    expect(keys).toContain("wheezing");
  });

  // Change 1e: TB source added
  it("cough policy has a Tuberculosis source", () => {
    const policy = loadPolicy("cough");
    expect(policy.sources.some((s) => s.label.includes("Tuberculosis"))).toBe(true);
  });

  // Change 1f: worsening explain mentions GP
  it("worsening rule explain mentions GP", () => {
    const policy = loadPolicy("cough");
    const worsening = policy.rules.find((r) => r.id === "worsening");
    expect(worsening?.explain).toContain("GP");
  });

  // Change 1g: long_duration explain mentions GP
  it("long_duration rule explain mentions GP", () => {
    const policy = loadPolicy("cough");
    const longDuration = policy.rules.find((r) => r.id === "long_duration");
    expect(longDuration?.explain).toContain("GP");
  });

  // Change 2: mouth ulcer policy matches HealthHub exactly
  it("mouth ulcer policy has 14-day no-treatment rule and 7-day self-treatment rule", () => {
    const policy = loadPolicy("mouth_ulcer");
    expect(policy.version).toBe("0.2.0");
    expect(policy.rules.some((r) => r.id === "ulcer_not_healed_no_treatment")).toBe(true);
    expect(policy.rules.some((r) => r.id === "ulcer_not_better_after_self_treatment")).toBe(true);
    expect(policy.rules.some((r) => r.id === "worsening")).toBe(true);
    // No 21-day rule
    expect(policy.rules.some((r) => r.id === "ulcer_not_healed_21_days")).toBe(false);
    // No spreading red flag
    expect(policy.redFlags.some((f) => f.key === "spreading")).toBe(false);
  });

  // Change 2b: difficulty_swallowing_or_breathing explain
  it("mouth ulcer difficulty_swallowing_or_breathing has explain field", () => {
    const policy = loadPolicy("mouth_ulcer");
    const rf = policy.redFlags.find((f) => f.key === "difficulty_swallowing_or_breathing");
    expect(rf?.explain).toBeDefined();
  });

  // Change 3a: "no lah" does NOT deny blood
  it('"no lah" does not produce a blood denial', () => {
    const x = new ScriptedExtractor();
    const result = x.extract({ text: "no lah" });
    const rf = result.find((r) => r.kind === "redflag_answer");
    expect(rf).toBeUndefined();
  });

  // Change 3b: "not breathless but chest pain" reports breathless_or_chest_pain
  it('"not breathless but chest pain" reports breathless_or_chest_pain', () => {
    const x = new ScriptedExtractor();
    const flags = Object.assign(
      {},
      ...x.extract({ text: "not breathless but chest pain" })
        .filter((e) => e.kind === "redflag_answer")
        .map((e) => e.redFlags)
    );
    expect(flags.breathless_or_chest_pain).toBe("reported");
  });

  // Change 3c: Malay "batuk darah" recognised as blood
  it('"batuk darah" is recognised as blood', () => {
    const x = new ScriptedExtractor();
    const flags = Object.assign(
      {},
      ...x.extract({ text: "batuk darah" })
        .filter((e) => e.kind === "redflag_answer")
        .map((e) => e.redFlags)
    );
    expect(flags.blood).toBe("reported");
  });

  // Change 3d: five new warning signs detected in free text
  it("detects high_fever, weight_loss, night_sweats, coloured_phlegm, wheezing in free text", () => {
    const x = new ScriptedExtractor();
    const f = (t: string) =>
      Object.assign(
        {},
        ...x.extract({ text: t })
          .filter((e) => e.kind === "redflag_answer")
          .map((e) => e.redFlags)
      );
    expect(f("I have a high fever").high_fever).toBe("reported");
    expect(f("I've been losing weight").weight_loss).toBe("reported");
    expect(f("sweating at night").night_sweats).toBe("reported");
    expect(f("yellow phlegm").coloured_phlegm).toBe("reported");
    expect(f("I'm wheezing").wheezing).toBe("reported");
  });

  // Change 3e: onset parsing for new phrases
  it("parses onset phrases: since last week, a week ago, 2 weeks, 3 weeks, three weeks, 1 month, since last month, a few days", () => {
    expect(extractOnset("since last week")).not.toBeNull();
    expect(extractOnset("about a week ago")).not.toBeNull();
    expect(extractOnset("cough for 2 weeks")).not.toBeNull();
    expect(extractOnset("3 weeks already")).not.toBeNull();
    expect(extractOnset("cough for three weeks")).not.toBeNull();
    expect(extractOnset("cough for 1 month")).not.toBeNull();
    expect(extractOnset("cough since last month")).not.toBeNull();
    expect(extractOnset("cough for a few days")).not.toBeNull();
  });

  // Change 5a: SEE_GP_INTRO does not say "nothing serious"
  it("SEE_GP_INTRO does not say 'nothing serious'", () => {
    expect(copy.SEE_GP_INTRO(14)).not.toContain("nothing serious");
    expect(copy.SEE_GP_INTRO(14)).toContain("doctor can check");
  });

  // Change 5b: blood red flag message mentions emergency department
  it("blood red flag message mentions emergency department", () => {
    const msg = redFlagMessage("EMERGENCY_995", "blood");
    expect(msg).toContain("emergency department");
    expect(msg).toContain("995");
  });

  // Change 5c: new warning sign messages say "HealthHub says ... should be checked by a doctor"
  it("new warning sign messages mention HealthHub and GP", () => {
    const msg = redFlagMessage("SEE_GP", "high_fever");
    expect(msg).toContain("HealthHub");
    expect(msg).toContain("GP");
    // No sticker, no emoji
    expect(/[\u{1F000}-\u{1FAFF}]/u.test(msg)).toBe(false);
  });

  // Change 5d: check-in follow-up question
  it("CHECKIN_FOLLOWUP question exists and asks about blood/breathlessness/chest pain", () => {
    expect(copy.CHECKIN_FOLLOWUP).toContain("blood");
    expect(copy.CHECKIN_FOLLOWUP).toContain("breathlessness");
    expect(copy.CHECKIN_FOLLOWUP).toContain("chest pain");
  });

  // Change 6a: cough_three_weeks KB entry
  it("cough policy three_weeks_any rule source is the TB source (index 1)", () => {
    const policy = loadPolicy("cough");
    const rule = policy.rules.find((r) => r.id === "three_weeks_any");
    expect(rule?.sourceIndex).toBe(1);
    expect(policy.sources[1].label).toContain("Tuberculosis");
  });
});
