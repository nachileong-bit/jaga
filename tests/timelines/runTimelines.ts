// tests/timelines/runTimelines.ts
// Timeline test runner: replays synthetic timelines (tests/timelines/*.json)
// and asserts the expected action on each day.
//
// Usage: npx tsx tests/timelines/runTimelines.ts

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, type Store } from "../../src/core/repository.js";
import { SimulatedClock } from "../../src/core/clock.js";
import { createEpisode, processObservation } from "../../src/core/engine.js";
import { loadPolicy } from "../../src/core/policyLoader.js";
import type {
  Episode,
  Observation,
  Person,
  PolicyResult,
  Timeline,
  TimelineEvent,
} from "../../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIMELINES_DIR = __dirname;

interface TimelineTestResult {
  name: string;
  description: string;
  passed: boolean;
  results: {
    day: number;
    expected: string;
    got: string;
    ruleId?: string;
    passed: boolean;
  }[];
}

let testIdCounter = 0;
const deterministicId = (): string => `id-${++testIdCounter}`;

/**
 * Process a single timeline event and return the observation payload.
 * The runner sets the clock to the event's day before calling the engine.
 */
async function processEvent(
  store: Store,
  episode: Episode,
  person: Person,
  event: TimelineEvent,
  clock: SimulatedClock
): Promise<void> {
  // Advance clock to this day
  clock.advanceToDay(event.day ?? 0);

  const obs: Omit<Observation, "id" | "episodeId"> = {
    at: clock.now(),
    reporter: event.reporter ?? "user",
    kind: event.kind,
    trajectory: event.trajectory,
    redFlags: event.redFlags,
    item: event.itemLabel
      ? { label: event.itemLabel, confirmed: false }
      : undefined,
    rawText: event.rawText,
  };

  await processObservation(store, episode, obs, clock);
}

/**
 * Check the expected action at a given day.
 * Replays events up to that day, then evaluates.
 */
async function runTimeline(timeline: Timeline): Promise<TimelineTestResult> {
  const result: TimelineTestResult = {
    name: timeline.name,
    description: timeline.description,
    passed: true,
    results: [],
  };

  // Fresh in-memory DB for each timeline
  const store = createStore(":memory:");
  const clock = new SimulatedClock();

  // Create person
  const person: Person = {
    id: "person-1",
    displayName: "Test Person",
    language: "en",
    mode: timeline.mode ?? "independent",
    consent: { shareAtThresholds: false },
  };
  store.upsertPerson(person);

  // Create episode at day 0
  clock.advanceToDay(0);
  const episode = await createEpisode(person, timeline.symptom, timeline.onset, clock);
  store.insertEpisode(episode);

  // Sort events by day
  const sortedEvents = [...timeline.events].sort((a, b) => (a.day ?? 0) - (b.day ?? 0));

  // Track expectations by day
  const expectationsByDay = new Map(
    timeline.expectations.map((e) => [e.day, e])
  );

  // Process events in order, checking expectations at the right days
  let eventIndex = 0;

  // Track the last engine result (has followUps added by the engine)
  let lastEngineResult: { result: PolicyResult; episode: Episode } | null = null;

  // Process events day by day
  const maxDay = Math.max(
    ...sortedEvents.map((e) => e.day ?? 0),
    ...timeline.expectations.map((e) => e.day)
  );

  for (let day = 0; day <= maxDay; day++) {
    clock.advanceToDay(day);

    // Process all events for this day
    while (eventIndex < sortedEvents.length && (sortedEvents[eventIndex].day ?? 0) === day) {
      const event = sortedEvents[eventIndex];
      const currentEpisode = store.getEpisode(episode.id)!;

      const obs: Omit<Observation, "id" | "episodeId"> = {
        at: clock.now(),
        reporter: event.reporter ?? "user",
        kind: event.kind,
        trajectory: event.trajectory,
        redFlags: event.redFlags,
        item: event.itemLabel
          ? { label: event.itemLabel, confirmed: false }
          : undefined,
        rawText: event.rawText,
      };

      lastEngineResult = await processObservation(store, currentEpisode, obs, clock);
      eventIndex++;
    }

    // Check expectation for this day
    const expectation = expectationsByDay.get(day);
    if (expectation) {
      const currentEpisode = store.getEpisode(episode.id)!;
      const observations = store.getObservationsForEpisode(episode.id);
      const policy = loadPolicy(currentEpisode.symptom);
      const { evaluatePolicy } = await import("../../src/core/policyEvaluator.js");
      const evalResult = evaluatePolicy(currentEpisode, observations, policy, clock);

      // If there was an engine result on this day (events were processed),
      // use its followUps (the engine adds ASK_CLARIFICATION for discordance).
      // Otherwise, use the evaluator's followUps (empty from evaluatePolicy).
      const followUps =
        lastEngineResult && sortedEvents.some((e) => (e.day ?? 0) === day)
          ? lastEngineResult.result.followUps
          : evalResult.followUps;

      const passed =
        evalResult.action === expectation.action &&
        (expectation.ruleId === undefined || evalResult.ruleId === expectation.ruleId) &&
        (expectation.redFlagKey === undefined || evalResult.redFlagKey === expectation.redFlagKey) &&
        (expectation.followUpsContains === undefined ||
          expectation.followUpsContains.every((fu) => followUps.includes(fu)));

      result.results.push({
        day,
        expected: expectation.action,
        got: evalResult.action,
        ruleId: evalResult.ruleId,
        passed,
      });

      if (!passed) result.passed = false;
    }
  }

  store.close();
  return result;
}

async function main(): Promise<void> {
  const files = readdirSync(TIMELINES_DIR).filter((f) => f.endsWith(".json"));
  const results: TimelineTestResult[] = [];

  for (const file of files) {
    const raw = readFileSync(join(TIMELINES_DIR, file), "utf-8");
    const timeline = JSON.parse(raw) as Timeline;
    const result = await runTimeline(timeline);
    results.push(result);
  }

  // Print results
  let allPassed = true;
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(`\n${status}  ${result.name}`);
    console.log(`     ${result.description}`);
    for (const r of result.results) {
      const rstatus = r.passed ? "  ✓" : "  ✗";
      const detail = r.ruleId ? ` [${r.ruleId}]` : "";
      console.log(
        `   ${rstatus} Day ${r.day}: expected ${r.expected}, got ${r.got}${detail}`
      );
    }
    if (!result.passed) allPassed = false;
  }

  console.log(`\n${"=".repeat(60)}`);
  const passed = results.filter((r) => r.passed).length;
  console.log(`${passed}/${results.length} timelines passed`);
  console.log(allPassed ? "ALL PASSED" : "SOME FAILED");

  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error("Timeline runner error:", err);
  process.exit(1);
});
