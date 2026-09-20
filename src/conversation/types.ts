// src/conversation/types.ts
// Types for the conversation flow layer — sits above src/core but below
// the HTTP server. src/core stays pure.

import type { ActionType, Mode, PolicyResult, Reporter, Trajectory } from "../core/types.js";

export type ConversationPhase =
  | "init"
  | "mode_select"
  | "symptom_mention"
  | "redflag_blood"
  | "redflag_breathless"
  | "monitoring"
  | "checkin"
  | "escalated";

export interface TranscriptEntry {
  role: "jaga" | "user" | "support_person";
  text: string;
  buttons?: string[];
  sourceLabel?: string;
  sourceUrl?: string;
  prototypeLabel?: boolean;
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
}

export interface ProcessMessageParams {
  text?: string;
  button?: string;
  reporter?: Reporter;
}

export interface ProcessAdvanceParams {
  toDay: number;
}
