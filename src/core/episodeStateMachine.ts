// src/core/episodeStateMachine.ts
// Episode state machine, discordance detection, silence handling.
// Pure functions — no LLM, no network, no Date.now().

import type { Clock, Episode, Observation, Trajectory } from "./types.js";

/**
 * Valid state transitions for an episode.
 *
 * ACTIVE → IMPROVING (trajectory becomes "better")
 * ACTIVE → RESOLVED (symptom-free threshold met)
 * IMPROVING → ACTIVE (trajectory worsens again → RECURRENT)
 * IMPROVING → RESOLVED (symptom-free threshold met)
 * IMPROVING → RECURRENT (symptom returns after improvement)
 * RECURRENT → ACTIVE (re-evaluated as active again)
 * RESOLVED → (terminal, new episode starts fresh)
 */
export function nextState(
  current: Episode["state"],
  trajectory: Trajectory,
  resolvedThreshold: number | null = null,
  symptomFreeDays: number = 0
): Episode["state"] {
  // "gone" is treated like "better" for state transitions (spec: treat "gone" like "better")
  const effectiveTraj: Trajectory =
    trajectory === "gone" ? "better" : trajectory;

  switch (current) {
    case "ACTIVE":
      if (effectiveTraj === "better") return "IMPROVING";
      return "ACTIVE";
    case "IMPROVING":
      if (effectiveTraj === "same" || effectiveTraj === "worse")
        return "RECURRENT";
      if (effectiveTraj === "intermittent") return "RECURRENT";
      // effectiveTraj === "better" — check if resolved threshold is met
      if (resolvedThreshold !== null && symptomFreeDays >= resolvedThreshold) {
        return "RESOLVED";
      }
      return "IMPROVING";
    case "RECURRENT":
      if (effectiveTraj === "better") return "IMPROVING";
      return "ACTIVE";
    case "RESOLVED":
      return "RESOLVED";
    default:
      return current;
  }
}

/**
 * Compute the effective trajectory of an episode from its observations.
 * The most recent user-reported trajectory wins, unless a support person
 * reports a contradicting trajectory (discordance) within the same check-in
 * window.
 *
 * Discordance expiry: two contradicting reports only count as discordant if
 * they fall within the same check-in window (policy.checkinEveryDays). If
 * one report is from day 3 and the other from day 30, they are in different
 * windows and not considered conflicting — the stale one is simply outdated.
 *
 * Discordance rule (spec rule 7): minimising by user or support person
 * can never overwrite recorded history. If user says "better" but support
 * person says "still coughing" (same/worse) within the same window, we mark
 * discordance=true and use the worse trajectory for safety.
 */
export function computeTrajectory(
  observations: Observation[],
  checkinEveryDays: number
): { trajectory: Trajectory; discordance: boolean } {
  const userObs = observations.filter((o) => o.reporter === "user");
  const supportObs = observations.filter(
    (o) => o.reporter === "support_person"
  );

  const lastUserTrajObs = [...userObs]
    .reverse()
    .find((o) => o.trajectory !== undefined);
  const lastSupportTrajObs = [...supportObs]
    .reverse()
    .find((o) => o.trajectory !== undefined);

  const lastUserTraj = lastUserTrajObs?.trajectory;
  const lastSupportTraj = lastSupportTrajObs?.trajectory;

  // No trajectories reported at all
  if (lastUserTraj === undefined && lastSupportTraj === undefined) {
    return { trajectory: "unknown", discordance: false };
  }

  const userTraj: Trajectory = lastUserTraj ?? "unknown";
  const supportTraj: Trajectory | undefined = lastSupportTraj;

  // Treat "gone" like "better" for discordance purposes (spec)
  const userEff = userTraj === "gone" ? "better" : userTraj;
  const supportEff = supportTraj === "gone" ? "better" : supportTraj;

  // Check if both reports fall within the same check-in window
  const withinWindow =
    lastUserTrajObs !== undefined &&
    lastSupportTrajObs !== undefined &&
    Math.abs(
      new Date(lastUserTrajObs.at).getTime() -
        new Date(lastSupportTrajObs.at).getTime()
    ) <=
      checkinEveryDays * 86_400_000;

  // Discordance: user says better/gone, support says same/worse/intermittent
  // — only if both reports are within the same check-in window
  if (
    withinWindow &&
    userEff === "better" &&
    supportEff !== undefined &&
    supportEff !== "better" &&
    supportEff !== "unknown"
  ) {
    // Use the worse trajectory for safety
    return { trajectory: supportTraj!, discordance: true };
  }

  // Discordance: support says better/gone, user says same/worse
  // — only if both reports are within the same check-in window
  if (
    withinWindow &&
    supportEff === "better" &&
    userEff !== "better" &&
    userEff !== "unknown"
  ) {
    return { trajectory: userTraj, discordance: true };
  }

  // No conflict — last user trajectory wins, fall back to support
  return {
    trajectory: userEff !== "unknown" ? userEff : (supportEff ?? "unknown"),
    discordance: false,
  };
}

/**
 * Minimum provable duration in days: now - onset.latestPossible
 * (spec rule 3: never invent precision — use the latest possible onset date)
 */
export function minDurationDays(episode: Episode, clock: Clock): number {
  const now = clock.nowMs();
  const latest = new Date(episode.onset.latestPossible).getTime();
  return Math.max(0, Math.floor((now - latest) / 86_400_000));
}

/**
 * Silence handling (spec rule 4): silence is "unknown".
 * A missed check-in never becomes "better".
 *
 * Returns the number of missed check-ins since the last actual check-in
 * observation, based on the policy's checkinEveryDays.
 */
export function computeMissedCheckins(
  episode: Episode,
  observations: Observation[],
  checkinEveryDays: number,
  clock: Clock
): number {
  const lastCheckin = [...observations]
    .filter((o) => o.kind === "checkin")
    .reverse()[0];

  // If no check-in ever happened, base it on episode creation / lastActionAt
  const reference = lastCheckin?.at ?? episode.lastCheckinAt ?? episode.onset.latestPossible;
  const daysSince = Math.floor(
    (clock.nowMs() - new Date(reference).getTime()) / 86_400_000
  );

  if (daysSince < checkinEveryDays) return 0;
  return Math.floor(daysSince / checkinEveryDays);
}

/**
 * Apply a new observation to an episode, returning the updated episode state.
 * This is the core transition function — pure, no side effects.
 *
 * `observations` should be the PRIOR observations (before newObs).
 * This function appends newObs to compute the full trajectory.
 */
export function applyObservation(
  episode: Episode,
  observations: Observation[],
  newObs: Observation,
  clock: Clock,
  checkinEveryDays: number,
  resolvedThreshold: number | null = null
): Episode {
  const allObs = [...observations, newObs];

  // Compute trajectory from all observations including the new one
  const { trajectory, discordance } = computeTrajectory(allObs, checkinEveryDays);

  // Compute symptom-free days if trajectory is "better" or "gone"
  // (treat "gone" like "better" for resolution)
  const effectiveTraj: Trajectory =
    trajectory === "gone" ? "better" : trajectory;
  let symptomFreeDays = 0;
  if (effectiveTraj === "better") {
    // Count consecutive "better"/"gone" check-ins from the end
    const trajObs = [...allObs]
      .filter((o) => o.trajectory !== undefined)
      .reverse();
    for (const o of trajObs) {
      const t: Trajectory = o.trajectory!;
      const eff = t === "gone" ? "better" : t;
      if (eff === "better") {
        symptomFreeDays += 1;
      } else {
        break;
      }
    }
    // Convert count to days — approximate using minDurationDays
    // Each check-in spans roughly checkinEveryDays days
    symptomFreeDays = symptomFreeDays * checkinEveryDays;
  }

  // Determine new state
  const newState = nextState(
    episode.state,
    trajectory,
    resolvedThreshold,
    symptomFreeDays
  );

  // Update missed checkins
  let missedCheckins = episode.missedCheckins;
  if (newObs.kind === "checkin") {
    missedCheckins = 0; // Reset on actual check-in
  }

  const updated: Episode = {
    ...episode,
    state: newState,
    trajectory,
    discordance,
    missedCheckins,
    lastActionAt: newObs.at,
    lastCheckinAt: newObs.kind === "checkin" ? newObs.at : episode.lastCheckinAt,
  };

  return updated;
}

/**
 * Check if an episode should be resolved based on symptom-free days.
 * If resolvedAfterSymptomFreeDays is null, episodes never auto-resolve.
 */
export function shouldResolve(
  episode: Episode,
  symptomFreeDays: number,
  threshold: number | null
): boolean {
  if (threshold === null) return false;
  // Treat "gone" like "better" (spec)
  const effectiveTraj = episode.trajectory === "gone" ? "better" : episode.trajectory;
  if (effectiveTraj !== "better") return false;
  return symptomFreeDays >= threshold;
}
