// tests/unit/engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../../src/core/repository.js";
import { SimulatedClock } from "../../src/core/clock.js";
import { createEpisode, processObservation } from "../../src/core/engine.js";
import type { Onset, Person } from "../../src/core/types.js";
import { rmSync } from "node:fs";

const DB_PATH = "test-engine.db";

describe("Engine (integration)", () => {
  let store: Store;
  let clock: SimulatedClock;

  beforeEach(() => {
    store = createStore(DB_PATH);
    clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
  });

  afterEach(() => {
    store.close();
    rmSync(DB_PATH, { force: true });
    rmSync(`${DB_PATH}-wal`, { force: true });
    rmSync(`${DB_PATH}-shm`, { force: true });
  });

  const basePerson: Person = {
    id: "p-1",
    displayName: "Test Person",
    language: "en",
    mode: "independent",
    consent: { shareAtThresholds: false },
  };

  const baseOnset: Onset = {
    rawText: "started coughing",
    latestPossible: "2026-01-01T08:00:00.000Z",
    confidence: "exact",
  };

  it("creates an episode with correct policy metadata", async () => {
    store.upsertPerson(basePerson);
    clock.advanceToDay(0);
    const episode = await createEpisode(basePerson, "cough", baseOnset, clock);
    expect(episode.policyId).toBe("cough");
    expect(episode.policyVersion).toBe("0.2.0");
    expect(episode.state).toBe("ACTIVE");
    expect(episode.trajectory).toBe("unknown");
  });

  it("processes a mention and returns KEEP_WATCHING", async () => {
    store.upsertPerson(basePerson);
    clock.advanceToDay(0);
    const episode = await createEpisode(basePerson, "cough", baseOnset, clock);
    store.insertEpisode(episode);

    const { result } = await processObservation(
      store,
      episode,
      {
        at: clock.now(),
        reporter: "user",
        kind: "mention",
        trajectory: "same",
        rawText: "I have a cough",
      },
      clock
    );

    expect(result.action).toBe("KEEP_WATCHING");
  });

  it("escalates when red flag reported", async () => {
    store.upsertPerson(basePerson);
    clock.advanceToDay(0);
    const episode = await createEpisode(basePerson, "cough", baseOnset, clock);
    store.insertEpisode(episode);

    clock.advanceToDay(5);
    const { result } = await processObservation(
      store,
      episode,
      {
        at: clock.now(),
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported" },
        rawText: "I saw blood",
      },
      clock
    );

    expect(result.action).toBe("EMERGENCY_995");
    expect(result.redFlagKey).toBe("blood");
  });

  it("escalates to SEE_GP after 14+ days with self-treatment", async () => {
    store.upsertPerson(basePerson);
    clock.advanceToDay(0);
    const episode = await createEpisode(basePerson, "cough", baseOnset, clock);
    store.insertEpisode(episode);

    // Day 0: mention
    clock.advanceToDay(0);
    await processObservation(store, episode, {
      at: clock.now(),
      reporter: "user",
      kind: "mention",
      trajectory: "same",
      rawText: "I have a cough",
    }, clock);

    // Day 3: self-treatment
    clock.advanceToDay(3);
    const ep2 = store.getEpisode(episode.id)!;
    await processObservation(store, ep2, {
      at: clock.now(),
      reporter: "user",
      kind: "self_treatment",
      rawText: "took cough syrup",
    }, clock);

    // Day 15: check-in, still same
    clock.advanceToDay(15);
    const ep3 = store.getEpisode(episode.id)!;
    const { result } = await processObservation(store, ep3, {
      at: clock.now(),
      reporter: "user",
      kind: "checkin",
      trajectory: "same",
      rawText: "still coughing",
    }, clock);

    expect(result.action).toBe("SEE_GP");
    expect(result.ruleId).toBe("not_better_after_self_treatment");
  });

  it("detects discordance between user and support person", async () => {
    const supportedPerson: Person = {
      ...basePerson,
      mode: "supported",
      supportPersonId: "sp-1",
    };
    store.upsertPerson(supportedPerson);
    clock.advanceToDay(0);
    const episode = await createEpisode(supportedPerson, "cough", baseOnset, clock);
    store.insertEpisode(episode);

    // Day 7: user says better
    clock.advanceToDay(7);
    await processObservation(store, episode, {
      at: clock.now(),
      reporter: "user",
      kind: "checkin",
      trajectory: "better",
      rawText: "I feel better",
    }, clock);

    // Day 8: support person says worse
    clock.advanceToDay(8);
    const ep2 = store.getEpisode(episode.id)!;
    const { result, episode: updated } = await processObservation(store, ep2, {
      at: clock.now(),
      reporter: "support_person",
      kind: "checkin",
      trajectory: "worse",
      rawText: "getting worse not better",
    }, clock);

    expect(updated.discordance).toBe(true);
    expect(updated.trajectory).toBe("worse");
    // Action comes from sourced rule (worsening), not a discordance rule
    expect(result.action).toBe("SEE_GP");
    expect(result.ruleId).toBe("worsening");
    // followUps contains ASK_CLARIFICATION (procedural, not medical)
    expect(result.followUps).toContain("ASK_CLARIFICATION");
  });

  it("red flag stays reported after later deny", async () => {
    store.upsertPerson(basePerson);
    clock.advanceToDay(0);
    const episode = await createEpisode(basePerson, "cough", baseOnset, clock);
    store.insertEpisode(episode);

    // Day 9: user reports blood
    clock.advanceToDay(9);
    await processObservation(store, episode, {
      at: clock.now(),
      reporter: "user",
      kind: "redflag_answer",
      redFlags: { blood: "reported" },
      rawText: "I saw blood",
    }, clock);

    // Day 10: user denies blood
    clock.advanceToDay(10);
    const ep2 = store.getEpisode(episode.id)!;
    const { result } = await processObservation(store, ep2, {
      at: clock.now(),
      reporter: "user",
      kind: "redflag_answer",
      redFlags: { blood: "denied" },
      rawText: "actually no blood",
    }, clock);

    // Still escalated — red flag is sticky
    expect(result.action).toBe("EMERGENCY_995");
    expect(result.redFlagKey).toBe("blood");
  });
});
