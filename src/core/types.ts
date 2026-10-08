// src/core/types.ts
// Core domain types for Jaga.
// No LLM, no network, no I/O here — pure data.

export type Mode = "independent" | "supported" | "assisted";
export type Trajectory = "better" | "same" | "worse" | "intermittent" | "gone" | "unknown";
export type EpisodeState = "ACTIVE" | "IMPROVING" | "RESOLVED" | "RECURRENT";
export type Confidence = "exact" | "approximate" | "unknown";
export type Reporter = "user" | "support_person";

export type Symptom = "cough" | "mouth_ulcer";

export type ActionType =
  | "KEEP_WATCHING"
  | "SEE_GP"
  | "SEE_DOCTOR_TODAY"
  | "EMERGENCY_995";

export type RedFlagAnswer = "reported" | "denied" | "unknown";

export interface Consent {
  shareAtThresholds: boolean;
  emergencyContact?: string;
  pausedAt?: string; // ISO timestamp; if set, sharing is paused
}

export interface Person {
  id: string;
  displayName: string;
  ageBand?: string;
  language: string;
  mode: Mode;
  supportPersonId?: string;
  consent: Consent;
}

export interface Onset {
  rawText: string; // "since before CNY"
  earliestPossible?: string; // ISO date
  latestPossible: string; // ISO date — the MINIMUM provable duration is now - latestPossible
  confidence: Confidence;
}

export type ObservationKind =
  | "mention"
  | "checkin"
  | "redflag_answer"
  | "self_treatment"
  | "silence"
  | "plan"
  | "care_sought";

export interface Observation {
  id: string;
  episodeId: string;
  at: string; // ISO timestamp
  reporter: Reporter;
  kind: ObservationKind;
  trajectory?: Trajectory;
  redFlags?: Record<string, RedFlagAnswer>;
  item?: { label: string; confirmed: boolean };
  rawText?: string;
}

export interface Episode {
  id: string;
  personId: string;
  symptom: Symptom;
  onset: Onset;
  state: EpisodeState;
  trajectory: Trajectory;
  discordance: boolean;
  missedCheckins: number;
  policyId: string;
  policyVersion: string;
  lastActionAt?: string; // ISO timestamp
  lastCheckinAt?: string; // ISO timestamp of last actual check-in
}

// ---- Policy types (plain data) ----

export interface RedFlagRule {
  key: string;
  action: ActionType;
}

export interface PolicyRuleWhen {
  minDurationDays?: number;
  selfTreatment?: boolean;
  trajectoryIn?: Trajectory[];
}

export interface PolicyRule {
  id: string;
  when: PolicyRuleWhen;
  action: ActionType;
  explain?: string;
  sourceIndex?: number;
}

export interface PolicySource {
  label: string;
  url: string;
}

export interface Policy {
  id: string;
  version: string;
  status: string; // "PENDING_CLINICIAN_REVIEW"
  reviewer: string | null;
  sources: PolicySource[];
  redFlags: RedFlagRule[];
  rules: PolicyRule[];
  checkinEveryDays: number;
  resolvedAfterSymptomFreeDays: number | null;
}

// ---- Evaluator output ----

export interface PolicyResult {
  action: ActionType;
  ruleId?: string;
  policyId: string;
  policyVersion: string;
  source?: PolicySource;
  explain?: string;
  redFlagKey?: string;
  reportedBy?: Reporter;
  reportedAt?: string;
  followUps: string[];
}

// ---- Clock interface ----

export interface Clock {
  now(): string; // ISO 8601 timestamp
  nowMs(): number;
}

// ---- Timeline test format ----

export interface TimelineEvent {
  at: string; // ISO date or relative "day:N" handled by runner
  reporter?: Reporter; // default "user"
  kind: ObservationKind;
  trajectory?: Trajectory;
  redFlags?: Record<string, RedFlagAnswer>;
  itemLabel?: string;
  rawText?: string;
  // For timeline driver: advance the simulated clock to this day before processing
  day?: number;
}

export interface TimelineExpectation {
  day: number;
  action: ActionType;
  ruleId?: string;
  redFlagKey?: string;
  followUpsContains?: string[];
}

export interface Timeline {
  name: string;
  description: string;
  symptom: Symptom;
  onset: Onset;
  mode: Mode;
  events: TimelineEvent[];
  expectations: TimelineExpectation[];
}
