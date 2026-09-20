// src/core/redFlagScreen.ts
// Red-flag screening runs on EVERY incoming message, before any clock logic.
// (spec rule 6)
//
// The screen does NOT decide urgency based on the message text (that would
// require an LLM). Instead, it checks the structured red-flag answers stored
// in observations. In M1, red-flag answers come from timeline events directly.
// In M3, the LLM extraction will populate redFlags from message text.

import type { Episode, Observation, Policy, PolicyResult } from "./types.js";

/**
 * Screen the latest observations for red flags.
 * Returns the highest-priority red flag that was "reported", or null.
 *
 * Priority order: EMERGENCY_995 > SEE_DOCTOR_TODAY > everything else.
 */
export function screenRedFlags(
  observations: Observation[],
  policy: Policy
): PolicyResult | null {
  // Collect all red-flag answers across observations (most recent wins per key)
  const latestAnswers: Record<string, "reported" | "denied" | "unknown"> = {};
  for (const obs of observations) {
    if (obs.redFlags) {
      for (const [key, answer] of Object.entries(obs.redFlags)) {
        latestAnswers[key] = answer;
      }
    }
  }

  // Find any red flag that was "reported"
  for (const rf of policy.redFlags) {
    const answer = latestAnswers[rf.key];
    if (answer === "reported") {
      return {
        action: rf.action,
        redFlagKey: rf.key,
        policyId: policy.id,
        policyVersion: policy.version,
        source: policy.sources[0],
      };
    }
  }

  return null;
}

/**
 * Check if ANY red flag is "reported" or "unknown" (unanswered) in the
 * latest observations. Used to decide whether to ask about red flags.
 */
export function hasUnscreenedRedFlags(
  observations: Observation[],
  policy: Policy
): boolean {
  const latestAnswers: Record<string, "reported" | "denied" | "unknown"> = {};
  for (const obs of observations) {
    if (obs.redFlags) {
      for (const [key, answer] of Object.entries(obs.redFlags)) {
        latestAnswers[key] = answer;
      }
    }
  }

  return policy.redFlags.some((rf) => {
    const answer = latestAnswers[rf.key];
    return answer === undefined || answer === "unknown";
  });
}
