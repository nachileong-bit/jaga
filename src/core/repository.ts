// src/core/repository.ts
// SQLite-backed repository for persons, episodes, observations.
// Uses better-sqlite3 (synchronous, fast, easy to deploy).

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  Episode,
  Observation,
  Person,
  RedFlagAnswer,
  Trajectory,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Store {
  close(): void;
  // persons
  upsertPerson(person: Person): void;
  getPerson(id: string): Person | undefined;
  // episodes
  insertEpisode(episode: Episode): void;
  updateEpisode(episode: Episode): void;
  getEpisode(id: string): Episode | undefined;
  getActiveEpisode(personId: string, symptom: string): Episode | undefined;
  getEpisodesByPerson(personId: string): Episode[];
  // observations
  insertObservation(obs: Observation): void;
  getObservationsForEpisode(episodeId: string): Observation[];
  getLastObservation(episodeId: string, kind?: string): Observation | undefined;
  // misc
  migrate(): void;
}

export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const store = new SqliteStore(db);
  store.migrate();
  return store;
}

class SqliteStore implements Store {
  constructor(private db: Database.Database) {}

  close(): void {
    this.db.close();
  }

  migrate(): void {
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    this.db.exec(sql);
  }

  // ---- Persons ----

  upsertPerson(person: Person): void {
    const stmt = this.db.prepare(`
      INSERT INTO persons (id, display_name, age_band, language, mode,
        support_person_id, consent_share_at_thresholds, consent_emergency_contact,
        consent_paused_at)
      VALUES (@id, @displayName, @ageBand, @language, @mode,
        @supportPersonId, @shareAtThresholds, @emergencyContact, @pausedAt)
      ON CONFLICT(id) DO UPDATE SET
        display_name = @displayName,
        age_band = @ageBand,
        language = @language,
        mode = @mode,
        support_person_id = @supportPersonId,
        consent_share_at_thresholds = @shareAtThresholds,
        consent_emergency_contact = @emergencyContact,
        consent_paused_at = @pausedAt
    `);
    stmt.run({
      id: person.id,
      displayName: person.displayName,
      ageBand: person.ageBand ?? null,
      language: person.language,
      mode: person.mode,
      supportPersonId: person.supportPersonId ?? null,
      shareAtThresholds: person.consent.shareAtThresholds ? 1 : 0,
      emergencyContact: person.consent.emergencyContact ?? null,
      pausedAt: person.consent.pausedAt ?? null,
    });
  }

  getPerson(id: string): Person | undefined {
    const row = this.db
      .prepare("SELECT * FROM persons WHERE id = ?")
      .get(id) as PersonRow | undefined;
    if (!row) return undefined;
    return rowToPerson(row);
  }

  // ---- Episodes ----

  insertEpisode(episode: Episode): void {
    // Use lastActionAt (set by the engine via Clock) for timestamps.
    // No Date.now() or new Date() — all time comes through the Episode/Clock.
    const now = episode.lastActionAt ?? "1970-01-01T00:00:00.000Z";
    const stmt = this.db.prepare(`
      INSERT INTO episodes (id, person_id, symptom, onset_raw_text, onset_earliest,
        onset_latest, onset_confidence, state, trajectory, discordance, missed_checkins,
        policy_id, policy_version, last_action_at, last_checkin_at,
        created_at, updated_at)
      VALUES (@id, @personId, @symptom, @rawText, @earliest, @latest, @confidence,
        @state, @trajectory, @discordance, @missedCheckins,
        @policyId, @policyVersion, @lastActionAt, @lastCheckinAt,
        @createdAt, @updatedAt)
    `);
    stmt.run({
      id: episode.id,
      personId: episode.personId,
      symptom: episode.symptom,
      rawText: episode.onset.rawText,
      earliest: episode.onset.earliestPossible ?? null,
      latest: episode.onset.latestPossible,
      confidence: episode.onset.confidence,
      state: episode.state,
      trajectory: episode.trajectory,
      discordance: episode.discordance ? 1 : 0,
      missedCheckins: episode.missedCheckins,
      policyId: episode.policyId,
      policyVersion: episode.policyVersion,
      lastActionAt: episode.lastActionAt ?? null,
      lastCheckinAt: episode.lastCheckinAt ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  updateEpisode(episode: Episode): void {
    // Use lastActionAt (set by the engine via Clock) for updated_at.
    // No Date.now() or new Date().
    const now = episode.lastActionAt ?? "1970-01-01T00:00:00.000Z";
    const stmt = this.db.prepare(`
      UPDATE episodes SET
        state = @state,
        trajectory = @trajectory,
        discordance = @discordance,
        missed_checkins = @missedCheckins,
        last_action_at = @lastActionAt,
        last_checkin_at = @lastCheckinAt,
        updated_at = @updatedAt
      WHERE id = @id
    `);
    stmt.run({
      id: episode.id,
      state: episode.state,
      trajectory: episode.trajectory,
      discordance: episode.discordance ? 1 : 0,
      missedCheckins: episode.missedCheckins,
      lastActionAt: episode.lastActionAt ?? null,
      lastCheckinAt: episode.lastCheckinAt ?? null,
      updatedAt: now,
    });
  }

  getEpisode(id: string): Episode | undefined {
    const row = this.db
      .prepare("SELECT * FROM episodes WHERE id = ?")
      .get(id) as EpisodeRow | undefined;
    return row ? rowToEpisode(row) : undefined;
  }

  getActiveEpisode(personId: string, symptom: string): Episode | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM episodes WHERE person_id = ? AND symptom = ? AND state IN ('ACTIVE','IMPROVING','RECURRENT') ORDER BY updated_at DESC LIMIT 1"
      )
      .get(personId, symptom) as EpisodeRow | undefined;
    return row ? rowToEpisode(row) : undefined;
  }

  getEpisodesByPerson(personId: string): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE person_id = ? ORDER BY created_at DESC")
      .all(personId) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  // ---- Observations ----

  insertObservation(obs: Observation): void {
    const stmt = this.db.prepare(`
      INSERT INTO observations (id, episode_id, at, reporter, kind, trajectory,
        red_flags, item_label, item_confirmed, raw_text)
      VALUES (@id, @episodeId, @at, @reporter, @kind, @trajectory,
        @redFlags, @itemLabel, @itemConfirmed, @rawText)
    `);
    stmt.run({
      id: obs.id,
      episodeId: obs.episodeId,
      at: obs.at,
      reporter: obs.reporter,
      kind: obs.kind,
      trajectory: obs.trajectory ?? null,
      redFlags: obs.redFlags ? JSON.stringify(obs.redFlags) : null,
      itemLabel: obs.item?.label ?? null,
      itemConfirmed: obs.item ? (obs.item.confirmed ? 1 : 0) : null,
      rawText: obs.rawText ?? null,
    });
  }

  getObservationsForEpisode(episodeId: string): Observation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM observations WHERE episode_id = ? ORDER BY at ASC"
      )
      .all(episodeId) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  getLastObservation(
    episodeId: string,
    kind?: string
  ): Observation | undefined {
    const row = kind
      ? (this.db
          .prepare(
            "SELECT * FROM observations WHERE episode_id = ? AND kind = ? ORDER BY at DESC LIMIT 1"
          )
          .get(episodeId, kind) as ObservationRow | undefined)
      : (this.db
          .prepare(
            "SELECT * FROM observations WHERE episode_id = ? ORDER BY at DESC LIMIT 1"
          )
          .get(episodeId) as ObservationRow | undefined);
    return row ? rowToObservation(row) : undefined;
  }
}

// ---- Row types & mappers ----

interface PersonRow {
  id: string;
  display_name: string;
  age_band: string | null;
  language: string;
  mode: string;
  support_person_id: string | null;
  consent_share_at_thresholds: number;
  consent_emergency_contact: string | null;
  consent_paused_at: string | null;
}

function rowToPerson(row: PersonRow): Person {
  return {
    id: row.id,
    displayName: row.display_name,
    ageBand: row.age_band ?? undefined,
    language: row.language,
    mode: row.mode as Person["mode"],
    supportPersonId: row.support_person_id ?? undefined,
    consent: {
      shareAtThresholds: row.consent_share_at_thresholds === 1,
      emergencyContact: row.consent_emergency_contact ?? undefined,
      pausedAt: row.consent_paused_at ?? undefined,
    },
  };
}

interface EpisodeRow {
  id: string;
  person_id: string;
  symptom: string;
  onset_raw_text: string;
  onset_earliest: string | null;
  onset_latest: string;
  onset_confidence: string;
  state: string;
  trajectory: string;
  discordance: number;
  missed_checkins: number;
  policy_id: string;
  policy_version: string;
  last_action_at: string | null;
  last_checkin_at: string | null;
}

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    personId: row.person_id,
    symptom: row.symptom as Episode["symptom"],
    onset: {
      rawText: row.onset_raw_text,
      earliestPossible: row.onset_earliest ?? undefined,
      latestPossible: row.onset_latest,
      confidence: row.onset_confidence as Episode["onset"]["confidence"],
    },
    state: row.state as Episode["state"],
    trajectory: row.trajectory as Trajectory,
    discordance: row.discordance === 1,
    missedCheckins: row.missed_checkins,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    lastActionAt: row.last_action_at ?? undefined,
    lastCheckinAt: row.last_checkin_at ?? undefined,
  };
}

interface ObservationRow {
  id: string;
  episode_id: string;
  at: string;
  reporter: string;
  kind: string;
  trajectory: string | null;
  red_flags: string | null;
  item_label: string | null;
  item_confirmed: number | null;
  raw_text: string | null;
}

function rowToObservation(row: ObservationRow): Observation {
  const redFlags = row.red_flags
    ? (JSON.parse(row.red_flags) as Record<string, RedFlagAnswer>)
    : undefined;
  const item =
    row.item_label !== null
      ? {
          label: row.item_label,
          confirmed: row.item_confirmed === 1,
        }
      : undefined;
  return {
    id: row.id,
    episodeId: row.episode_id,
    at: row.at,
    reporter: row.reporter as Observation["reporter"],
    kind: row.kind as Observation["kind"],
    trajectory: (row.trajectory as Trajectory) ?? undefined,
    redFlags,
    item,
    rawText: row.raw_text ?? undefined,
  };
}
