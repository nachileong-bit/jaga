// src/core/policyEvaluator.ts
// Deterministic policy evaluation — NO LLM.
// (spec rule 1: The LLM never decides medical urgency. Urgency comes only
// from the policy layer, plain data evaluated by plain code.)
//
// The evaluator runs red-flag screening first (rule 6), then evaluates
// duration-based rules. It returns the highest-priority action.

import type {
  Clock,
  Episode,
  Observation,
  Policy,
  PolicyResult,
  Trajectory,
} from "./types.js";
import { minDurationDays } from "./episodeStateMachine.js";
import { screenRedFlags } from "./redFlagScreen.js";

// Priority ordering: higher number = higher urgency
const ACTION_PRIORITY: Record<string, number> = {
  KEEP_WATCHING: 1,
  SEE_GP: 2,
  SEE_DOCTOR_TODAY: 3,
  EMERGENCY_995: 4,
};

/**
 * Evaluate a single policy rule against the episode state.
 */
function evaluateRule(
  episode: Episode,
  observations: Observation[],
  rule: Policy["rules"][number],
  clock: Clock
): boolean {
  const { when } = rule;
  if (!when) return true; // No conditions → always fires (catch-all)

  // minDurationDays
  if (when.minDurationDays !== undefined) {
    const duration = minDurationDays(episode, clock);
    if (duration < when.minDurationDays) return false;
  }

  // selfTreatment
  if (when.selfTreatment !== undefined) {
    const hasSelfTreatment = observations.some(
      (o) => o.kind === "self_treatment"
    );
    if (hasSelfTreatment !== when.selfTreatment) return false;
  }

  // trajectoryIn
  if (when.trajectoryIn !== undefined && when.trajectoryIn.length > 0) {
    const traj: Trajectory = episode.trajectory;
    if (!when.trajectoryIn.includes(traj)) return false;
  }

  // discordance — only fires when episode.discordance matches
  if (when.discordance !== undefined) {
    if (episode.discordance !== when.discordance) return false;
  }

  return true;
}

/**
 * Evaluate the full policy against an episode:
 * 1. Red-flag screen first (highest priority, runs on every message).
 * 2. Duration/trajectory rules in order.
 * 3. Return the highest-priority result.
 *
 * If nothing fires, default to KEEP_WATCHING.
 */
export function evaluatePolicy(
  episode: Episode,
  observations: Observation[],
  policy: Policy,
  clock: Clock
): PolicyResult {
  // 1. Red-flag screen first (rule 6: runs on EVERY message, before clock logic)
  const redFlagResult = screenRedFlags(observations, policy);
  if (redFlagResult) {
    return redFlagResult;
  }

  // 2. Evaluate rules
  let bestResult: PolicyResult | null = null;
  for (const rule of policy.rules) {
    if (evaluateRule(episode, observations, rule, clock)) {
      const result: PolicyResult = {
        action: rule.action,
        ruleId: rule.id,
        policyId: policy.id,
        policyVersion: policy.version,
        source: rule.sourceIndex !== undefined ? policy.sources[rule.sourceIndex] : undefined,
        explain: rule.explain,
      };

      if (
        !bestResult ||
        ACTION_PRIORITY[result.action] > ACTION_PRIORITY[bestResult.action]
      ) {
        bestResult = result;
      }
    }
  }

  // 3. Default to KEEP_WATCHING
  if (!bestResult) {
    return {
      action: "KEEP_WATCHING",
      policyId: policy.id,
      policyVersion: policy.version,
    };
  }

  return bestResult;
}
