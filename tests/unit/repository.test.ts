// tests/unit/repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../../src/core/repository.js";
import type { Episode, Observation, Onset, Person } from "../../src/core/types.js";
import { rmSync } from "node:fs";

const DB_PATH = "test-repository.db";

describe("Store (SQLite repository)", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(DB_PATH);
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
    ageBand: "30-40",
    language: "en",
    mode: "independent",
    consent: { shareAtThresholds: false },
  };

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
    lastActionAt: "2026-01-01T08:00:00.000Z",
  };

  describe("persons", () => {
    it("upserts and retrieves a person", () => {
      store.upsertPerson(basePerson);
      const retrieved = store.getPerson("p-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.displayName).toBe("Test Person");
      expect(retrieved!.mode).toBe("independent");
    });

    it("updates person on re-upsert", () => {
      store.upsertPerson(basePerson);
      const updated: Person = { ...basePerson, displayName: "Updated" };
      store.upsertPerson(updated);
      const retrieved = store.getPerson("p-1");
      expect(retrieved!.displayName).toBe("Updated");
    });

    it("returns undefined for unknown person", () => {
      expect(store.getPerson("unknown")).toBeUndefined();
    });

    it("persists consent fields", () => {
      const person: Person = {
        ...basePerson,
        id: "p-2",
        consent: {
          shareAtThresholds: true,
          emergencyContact: "caregiver@example.com",
          pausedAt: "2026-01-05T10:00:00.000Z",
        },
      };
      store.upsertPerson(person);
      const retrieved = store.getPerson("p-2")!;
      expect(retrieved.consent.shareAtThresholds).toBe(true);
      expect(retrieved.consent.emergencyContact).toBe("caregiver@example.com");
      expect(retrieved.consent.pausedAt).toBe("2026-01-05T10:00:00.000Z");
    });
  });

  describe("episodes", () => {
    it("inserts and retrieves an episode", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      const retrieved = store.getEpisode("ep-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.symptom).toBe("cough");
      expect(retrieved!.onset.rawText).toBe("started coughing");
      expect(retrieved!.onset.confidence).toBe("exact");
    });

    it("updates an episode", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      const updated: Episode = {
        ...baseEpisode,
        state: "IMPROVING",
        trajectory: "better",
        missedCheckins: 1,
      };
      store.updateEpisode(updated);
      const retrieved = store.getEpisode("ep-1")!;
      expect(retrieved.state).toBe("IMPROVING");
      expect(retrieved.trajectory).toBe("better");
      expect(retrieved.missedCheckins).toBe(1);
    });

    it("finds active episode by person + symptom", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      const active = store.getActiveEpisode("p-1", "cough");
      expect(active).toBeDefined();
      expect(active!.id).toBe("ep-1");
    });

    it("does not find resolved episodes as active", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode({ ...baseEpisode, state: "RESOLVED" });
      expect(store.getActiveEpisode("p-1", "cough")).toBeUndefined();
    });

    it("lists episodes by person", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode({ ...baseEpisode, id: "ep-1" });
      store.insertEpisode({ ...baseEpisode, id: "ep-2" });
      expect(store.getEpisodesByPerson("p-1")).toHaveLength(2);
    });

    it("persists discordance flag", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode({ ...baseEpisode, discordance: true });
      const retrieved = store.getEpisode("ep-1")!;
      expect(retrieved.discordance).toBe(true);
    });

    it("persists lastCheckinAt", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode({ ...baseEpisode, lastCheckinAt: "2026-01-07T08:00:00.000Z" });
      const retrieved = store.getEpisode("ep-1")!;
      expect(retrieved.lastCheckinAt).toBe("2026-01-07T08:00:00.000Z");
    });
  });

  describe("observations", () => {
    it("inserts and retrieves observations", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      const obs: Observation = {
        id: "o-1",
        episodeId: "ep-1",
        at: "2026-01-01T08:00:00.000Z",
        reporter: "user",
        kind: "checkin",
        trajectory: "same",
        rawText: "still coughing",
      };
      store.insertObservation(obs);
      const all = store.getObservationsForEpisode("ep-1");
      expect(all).toHaveLength(1);
      expect(all[0].trajectory).toBe("same");
      expect(all[0].rawText).toBe("still coughing");
    });

    it("persists red flags as JSON", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      const obs: Observation = {
        id: "o-1",
        episodeId: "ep-1",
        at: "2026-01-01T08:00:00.000Z",
        reporter: "user",
        kind: "redflag_answer",
        redFlags: { blood: "reported", breathless_or_chest_pain: "denied" },
      };
      store.insertObservation(obs);
      const retrieved = store.getObservationsForEpisode("ep-1")[0];
      expect(retrieved.redFlags).toEqual({
        blood: "reported",
        breathless_or_chest_pain: "denied",
      });
    });

    it("persists item label + confirmed", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      const obs: Observation = {
        id: "o-1",
        episodeId: "ep-1",
        at: "2026-01-01T08:00:00.000Z",
        reporter: "user",
        kind: "mention",
        item: { label: "Paracetamol 500mg", confirmed: false },
      };
      store.insertObservation(obs);
      const retrieved = store.getObservationsForEpisode("ep-1")[0];
      expect(retrieved.item).toEqual({ label: "Paracetamol 500mg", confirmed: false });
    });

    it("gets last observation by kind", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      store.insertObservation({
        id: "o-1",
        episodeId: "ep-1",
        at: "2026-01-01T08:00:00.000Z",
        reporter: "user",
        kind: "checkin",
        trajectory: "same",
      });
      store.insertObservation({
        id: "o-2",
        episodeId: "ep-1",
        at: "2026-01-08T08:00:00.000Z",
        reporter: "user",
        kind: "checkin",
        trajectory: "better",
      });
      const last = store.getLastObservation("ep-1", "checkin")!;
      expect(last.id).toBe("o-2");
      expect(last.trajectory).toBe("better");
    });

    it("returns observations in chronological order", () => {
      store.upsertPerson(basePerson);
      store.insertEpisode(baseEpisode);
      store.insertObservation({
        id: "o-2",
        episodeId: "ep-1",
        at: "2026-01-08T08:00:00.000Z",
        reporter: "user",
        kind: "checkin",
      });
      store.insertObservation({
        id: "o-1",
        episodeId: "ep-1",
        at: "2026-01-01T08:00:00.000Z",
        reporter: "user",
        kind: "checkin",
      });
      const all = store.getObservationsForEpisode("ep-1");
      expect(all[0].id).toBe("o-1");
      expect(all[1].id).toBe("o-2");
    });
  });
});
