// src/core/redFlagScreen.ts
// Red-flag screening runs on EVERY incoming message, before any clock logic.
// (spec rule 6)
//
// Spec rule 7: minimising by the user or by a support person can never delay a
// red-flag escalation. Therefore, once ANY reporter has "reported" a red flag
// in an episode, it stays reported for that episode. Later "denied" answers
// are stored in the observation record but never clear the reported status.
//
// The screen does NOT decide urgency based on the message text (that would
// require an LLM). Instead, it checks the structured red-flag answers stored
// in observations.

import type {
  Observation,
  Policy,
  PolicyResult,
  RedFlagAnswer,
  Reporter,
} from "./types.js";

/**
 * Tracks when and by whom a red flag was reported.
 */
export interface RedFlagReport {
  key: string;
  reporter: Reporter;
  at: string; // ISO timestamp of the observation that first reported it
  observationId: string;
}

/**
 * Scan all observations and collect every red flag that has EVER been
 * "reported" by ANY reporter. Once reported, it stays reported — later
 * "denied" or "unknown" answers never clear it.
 */
export function getReportedRedFlags(
  observations: Observation[]
): Map<string, RedFlagReport> {
  const reported = new Map<string, RedFlagReport>();

  for (const obs of observations) {
    if (!obs.redFlags) continue;
    for (const [key, answer] of Object.entries(obs.redFlags)) {
      if (answer === "reported" && !reported.has(key)) {
        reported.set(key, {
          key,
          reporter: obs.reporter,
          at: obs.at,
          observationId: obs.id,
        });
      }
    }
  }

  return reported;
}

/**
 * The latest answer per red-flag key (for display / knowing the current
 * "denied" state — but reported status is sticky regardless).
 */
export function getLatestRedFlagAnswers(
  observations: Observation[]
): Record<string, RedFlagAnswer> {
  const latest: Record<string, RedFlagAnswer> = {};
  for (const obs of observations) {
    if (obs.redFlags) {
      for (const [key, answer] of Object.entries(obs.redFlags)) {
        latest[key] = answer;
      }
    }
  }
  return latest;
}

/**
 * Screen all observations for red flags.
 * Returns the highest-priority red flag that was EVER "reported" (sticky),
 * or null if none were reported.
 *
 * The result includes `reportedBy` and `reportedAt` so the caller knows
 * who reported it and when, even if a later observation denied it.
 *
 * Priority order: EMERGENCY_995 > SEE_DOCTOR_TODAY > everything else.
 */
export function screenRedFlags(
  observations: Observation[],
  policy: Policy
): (Omit<PolicyResult, "followUps"> & { reportedBy?: Reporter; reportedAt?: string }) | null {
  const reported = getReportedRedFlags(observations);

  // Find the highest-priority reported red flag
  let best: { rf: Policy["redFlags"][number]; report: RedFlagReport } | null = null;

  for (const rf of policy.redFlags) {
    const report = reported.get(rf.key);
    if (!report) continue;

    if (!best || actionPriority(rf.action) > actionPriority(best.rf.action)) {
      best = { rf, report };
    }
  }

  if (!best) return null;

  return {
    action: best.rf.action,
    redFlagKey: best.rf.key,
    policyId: policy.id,
    policyVersion: policy.version,
    source: policy.sources[0],
    explain: best.rf.explain,
    reportedBy: best.report.reporter,
    reportedAt: best.report.at,
  };
}

/**
 * Check if ANY red flag is unanswered (not yet asked or "unknown") in the
 * latest observations. Used to decide whether to ask about red flags.
 *
 * Note: a red flag that was once "reported" is no longer "unscreened"
 * even if a later observation says "denied" — the reported status is sticky.
 */
export function hasUnscreenedRedFlags(
  observations: Observation[],
  policy: Policy
): boolean {
  const reported = getReportedRedFlags(observations);
  const latest = getLatestRedFlagAnswers(observations);

  return policy.redFlags.some((rf) => {
    // Already reported → not unscreened (sticky)
    if (reported.has(rf.key)) return false;
    const answer = latest[rf.key];
    return answer === undefined || answer === "unknown";
  });
}

// Priority ordering: higher number = higher urgency
function actionPriority(action: string): number {
  const priority: Record<string, number> = {
    KEEP_WATCHING: 1,
    SEE_GP: 2,
    SEE_DOCTOR_TODAY: 3,
    EMERGENCY_995: 4,
  };
  return priority[action] ?? 0;
}
