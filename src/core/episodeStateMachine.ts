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
  trajectory: Trajectory
): Episode["state"] {
  switch (current) {
    case "ACTIVE":
      if (trajectory === "better") return "IMPROVING";
      return "ACTIVE";
    case "IMPROVING":
      if (trajectory === "same" || trajectory === "worse")
        return "RECURRENT";
      if (trajectory === "intermittent") return "RECURRENT";
      return "IMPROVING";
    case "RECURRENT":
      if (trajectory === "better") return "IMPROVING";
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
 * reports a contradicting trajectory (discordance).
 *
 * Discordance rule (spec rule 7): minimising by user or support person
 * can never overwrite recorded history. If user says "better" but support
 * person says "still coughing" (same/worse), we mark discordance=true and
 * use the worse trajectory for safety.
 */
export function computeTrajectory(
  observations: Observation[]
): { trajectory: Trajectory; discordance: boolean } {
  const userObs = observations.filter((o) => o.reporter === "user");
  const supportObs = observations.filter(
    (o) => o.reporter === "support_person"
  );

  const lastUserTraj = [...userObs]
    .reverse()
    .find((o) => o.trajectory !== undefined)?.trajectory;
  const lastSupportTraj = [...supportObs]
    .reverse()
    .find((o) => o.trajectory !== undefined)?.trajectory;

  // No trajectories reported at all
  if (lastUserTraj === undefined && lastSupportTraj === undefined) {
    return { trajectory: "unknown", discordance: false };
  }

  const userTraj: Trajectory = lastUserTraj ?? "unknown";
  const supportTraj: Trajectory | undefined = lastSupportTraj;

  // Discordance: user says better, support says same/worse/intermittent
  if (
    userTraj === "better" &&
    supportTraj !== undefined &&
    supportTraj !== "better" &&
    supportTraj !== "unknown"
  ) {
    // Use the worse trajectory for safety
    return { trajectory: supportTraj, discordance: true };
  }

  // Discordance: support says better, user says same/worse
  if (
    supportTraj === "better" &&
    userTraj !== "better" &&
    userTraj !== "unknown"
  ) {
    return { trajectory: userTraj, discordance: true };
  }

  // No conflict — last user trajectory wins, fall back to support
  return {
    trajectory: userTraj !== "unknown" ? userTraj : (supportTraj ?? "unknown"),
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
 */
export function applyObservation(
  episode: Episode,
  observations: Observation[],
  newObs: Observation,
  clock: Clock
): Episode {
  const allObs = [...observations, newObs];

  // Compute trajectory from all observations including the new one
  const { trajectory, discordance } = computeTrajectory(allObs);

  // Determine new state
  const newState = nextState(episode.state, trajectory);

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
  if (episode.trajectory !== "better") return false;
  return symptomFreeDays >= threshold;
}
