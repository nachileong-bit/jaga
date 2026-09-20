// src/llm/Extractor.ts
// Extractor interface — stands between raw user input and the structured
// observation layer. The real LLM-backed implementation arrives in M3.
// For M2 (web demo), ScriptedExtractor maps button taps and canned phrases
// to structured observations.

import type {
  ObservationKind,
  RedFlagAnswer,
  Reporter,
  Trajectory,
} from "../core/types.js";

export interface ExtractedObservation {
  kind: ObservationKind;
  trajectory?: Trajectory;
  redFlags?: Record<string, RedFlagAnswer>;
  item?: { label: string; confirmed: boolean };
  rawText?: string;
}

export interface ExtractorInput {
  text?: string;
  button?: string;
  reporter?: Reporter;
}

export interface Extractor {
  extract(input: ExtractorInput): ExtractedObservation[];
}
