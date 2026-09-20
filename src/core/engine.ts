// src/core/engine.ts
// The Jaga engine: ties together clock, episode state machine, policy evaluator,
// red-flag screen, and the store. This is the single entry point for processing
// an observation and getting back a PolicyResult.
//
// No LLM, no network, no UI — pure orchestration of core modules.

import type {
  Clock,
  Episode,
  Observation,
  Person,
  PolicyResult,
} from "./types.js";
import type { Store } from "./repository.js";
import { loadPolicy } from "./policyLoader.js";
import { evaluatePolicy } from "./policyEvaluator.js";
import { applyObservation, computeMissedCheckins } from "./episodeStateMachine.js";
import { screenRedFlags } from "./redFlagScreen.js";

let uuidFn: () => string;

// Allow injecting a UUID function (e.g. from node:crypto or a test stub)
export function setUuidFn(fn: () => string): void {
  uuidFn = fn;
}

// Default: use node:crypto.randomUUID
async function ensureUuid(): Promise<void> {
  if (!uuidFn) {
    const crypto = await import("node:crypto");
    uuidFn = crypto.randomUUID;
  }
}

export async function makeUuid(): Promise<string> {
  await ensureUuid();
  return uuidFn();
}

/**
 * Create a new episode for a person + symptom.
 */
export async function createEpisode(
  person: Person,
  symptom: Episode["symptom"],
  onset: Episode["onset"],
  clock: Clock
): Promise<Episode> {
  await ensureUuid();
  const policy = loadPolicy(symptom);
  const episode: Episode = {
    id: uuidFn(),
    personId: person.id,
    symptom,
    onset,
    state: "ACTIVE",
    trajectory: "unknown",
    discordance: false,
    missedCheckins: 0,
    policyId: policy.id,
    policyVersion: policy.version,
    lastActionAt: clock.now(),
  };
  return episode;
}

/**
 * Process an observation against an episode:
 * 1. Store the observation.
 * 2. Get all observations for this episode (now including the new one).
 * 3. Red-flag screen (on every message, before clock logic).
 * 4. Apply observation to the episode state machine.
 *    Pass the PRIOR observations (excluding the new one) — applyObservation
 *    appends the new one internally, so we must not pass it in twice.
 * 5. Run policy evaluator.
 * 6. If episode.discordance is true, add "ASK_CLARIFICATION" to followUps.
 *    The action itself comes only from sourced policy rules or red flags.
 *
 * This function does NOT send anything to a support person — that's M4/M5.
 */
export async function processObservation(
  store: Store,
  episode: Episode,
  obs: Omit<Observation, "id" | "episodeId">,
  clock: Clock
): Promise<{ result: PolicyResult; episode: Episode }> {
  await ensureUuid();

  const observation: Observation = {
    ...obs,
    id: uuidFn(),
    episodeId: episode.id,
  };

  // 1. Store the observation
  store.insertObservation(observation);

  // 2. Get all observations for this episode (including the new one)
  const allObservations = store.getObservationsForEpisode(episode.id);

  // The prior observations (before the new one was stored) — used for
  // applyObservation which appends the new observation itself.
  const priorObservations = allObservations.filter((o) => o.id !== observation.id);

  // 3. Red-flag screen FIRST (rule 6: before any clock logic)
  const policy = loadPolicy(episode.symptom);
  const redFlagResult = screenRedFlags(allObservations, policy);
  if (redFlagResult) {
    // Red flag fires immediately — still update episode state for record
    const updated = applyObservation(
      episode,
      priorObservations,
      observation,
      clock,
      policy.checkinEveryDays,
      policy.resolvedAfterSymptomFreeDays
    );
    store.updateEpisode(updated);
    return {
      result: { ...redFlagResult, followUps: [] },
      episode: updated,
    };
  }

  // 4. Apply observation to state machine (pass prior, not all — it appends newObs)
  const updatedEpisode = applyObservation(
    episode,
    priorObservations,
    observation,
    clock,
    policy.checkinEveryDays,
    policy.resolvedAfterSymptomFreeDays
  );

  // 5. Update missed check-ins (silence handling)
  updatedEpisode.missedCheckins = computeMissedCheckins(
    updatedEpisode,
    allObservations,
    policy.checkinEveryDays,
    clock
  );

  store.updateEpisode(updatedEpisode);

  // 6. Evaluate policy
  const result = evaluatePolicy(updatedEpisode, allObservations, policy, clock);

  // 7. If discordance is detected, add ASK_CLARIFICATION as a follow-up.
  //    This is NOT a medical action — it's a procedural follow-up. The action
  //    itself comes only from sourced policy rules or red flags.
  if (updatedEpisode.discordance && !result.followUps.includes("ASK_CLARIFICATION")) {
    result.followUps.push("ASK_CLARIFICATION");
  }

  // 8. Update lastActionAt
  updatedEpisode.lastActionAt = clock.now();
  store.updateEpisode(updatedEpisode);

  return { result, episode: updatedEpisode };
}
