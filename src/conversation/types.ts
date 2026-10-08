// src/conversation/types.ts
// Types for the conversation flow layer — sits above src/core but below
// the HTTP server. src/core stays pure.

import type { ActionType, Mode, PolicyResult, Reporter, Trajectory } from "../core/types.js";

import type { ClinicCard } from "../navigation/prototypeData.js";

// What Jaga is currently waiting for. null = nothing pending.
export type Pending =
  | "mode"
  | "symptom"
  | "onset"
  | "redflag"
  | "checkin"
  | "confirm_item"
  | "clarify"
  | "nav"
  | "plan"
  | "share"
  | "went"
  | "doctor_said"
  | null;

export type ConversationPhase = Exclude<Pending, null> | "idle";

export interface TranscriptEntry {
  role: "jaga" | "user" | "support_person" | "system";
  text: string;
  buttons?: string[];
  sourceLabel?: string;
  sourceUrl?: string;
  card?: ClinicCard;
  link?: { label: string; href: string };
  sticker?: string;
  day: number;
}

export interface ClockPanelState {
  mode: Mode;
  symptom: string | null;
  onsetRawText: string | null;
  minDurationDays: number;
  confidence: string | null;
  trajectory: Trajectory | null;
  state: string | null;
  redFlags: {
    key: string;
    status: "reported" | "denied" | "unknown";
    reportedBy?: Reporter;
    reportedAt?: string;
  }[];
  selfTreatment: { label: string; confirmed: boolean }[];
  discordance: boolean;
  missedCheckins: number;
  policyId: string | null;
  policyVersion: string | null;
  pendingReview: boolean;
  lastRuleFired: string | null;
}

export interface DemoState {
  day: number;
  mode: Mode;
  phase: ConversationPhase;
  scenario: "mr_tan" | "ms_lim";
  transcript: TranscriptEntry[];
  clockPanel: ClockPanelState;
  lastResult: PolicyResult | null;
  simDate: string;
}

export interface ProcessMessageParams {
  text?: string;
  button?: string;
  reporter?: Reporter;
}

export interface ProcessAdvanceParams {
  toDay: number;
}
