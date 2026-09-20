-- src/core/schema.sql
-- SQLite schema for Jaga.
-- Single file, easy to deploy on Railway.

CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  age_band      TEXT,
  language      TEXT NOT NULL DEFAULT 'en',
  mode          TEXT NOT NULL DEFAULT 'independent',
  support_person_id TEXT,
  consent_share_at_thresholds INTEGER NOT NULL DEFAULT 0,
  consent_emergency_contact TEXT,
  consent_paused_at TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  person_id       TEXT NOT NULL REFERENCES persons(id),
  symptom         TEXT NOT NULL,
  onset_raw_text  TEXT NOT NULL,
  onset_earliest  TEXT,
  onset_latest    TEXT NOT NULL,
  onset_confidence TEXT NOT NULL DEFAULT 'unknown',
  state           TEXT NOT NULL DEFAULT 'ACTIVE',
  trajectory      TEXT NOT NULL DEFAULT 'unknown',
  discordance     INTEGER NOT NULL DEFAULT 0,
  missed_checkins INTEGER NOT NULL DEFAULT 0,
  policy_id       TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  last_action_at  TEXT,
  last_checkin_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_person ON episodes(person_id);
CREATE INDEX IF NOT EXISTS idx_episodes_state ON episodes(state);

CREATE TABLE IF NOT EXISTS observations (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episodes(id),
  at          TEXT NOT NULL,
  reporter    TEXT NOT NULL DEFAULT 'user',
  kind        TEXT NOT NULL,
  trajectory  TEXT,
  red_flags   TEXT,         -- JSON blob
  item_label  TEXT,
  item_confirmed INTEGER,
  raw_text    TEXT
);

CREATE INDEX IF NOT EXISTS idx_obs_episode ON observations(episode_id);
CREATE INDEX IF NOT EXISTS idx_obs_at ON observations(at);
