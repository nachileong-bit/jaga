// src/knowledge/kb.ts
// Jaga's knowledge base: short answers copied from official Singapore sources
// (HealthHub, MOH, SCDF), each one carrying its link. Lookup is plain keyword
// scoring, no AI, so an answer can only ever be one of the stored entries.
// If nothing matches well enough, Jaga says it does not know.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KbSource {
  label: string;
  url: string;
  publisher: string;
  sourceReviewed: string | null;
  checkedByJaga: string;
}

export interface KbEntry {
  id: string;
  topic: "cough" | "mouth_ulcer" | "care";
  title: string;
  keywords: string[];
  answer: string;
  source: string;
}

export interface KnowledgeBase {
  id: string;
  version: string;
  status: string;
  reviewer: string | null;
  rule: string;
  sources: Record<string, KbSource>;
  entries: KbEntry[];
}

export interface KbAnswer {
  entry: KbEntry;
  source: KbSource;
  score: number;
}

const KB_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../knowledge/kb.json");

let cached: KnowledgeBase | null = null;

export function loadKnowledgeBase(): KnowledgeBase {
  if (cached) return cached;
  const kb = JSON.parse(readFileSync(KB_PATH, "utf8")) as KnowledgeBase;
  for (const e of kb.entries) {
    if (!kb.sources[e.source]) throw new Error(`kb entry ${e.id} cites unknown source ${e.source}`);
  }
  cached = kb;
  return kb;
}

const QUESTION_START =
  /^(what|when|where|how|should|can|could|is|are|do|does|did|who|which|why|will|would|must|any)\b/;

export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith("?") || QUESTION_START.test(t);
}

const TOPIC_WORDS: Record<"cough" | "mouth_ulcer", RegExp> = {
  cough: /\bcough/,
  mouth_ulcer: /\bulcer|\bmouth sore/,
};

function normalise(text: string): string {
  // Bug 6: strip Singlish particles so "what can I take for cough ah" still matches.
  const stripped = text
    .toLowerCase()
    .replace(/\b(lah|leh|lor|meh|hor|ah|ahh|leh|lorh)\b/g, " ");
  return ` ${stripped.replace(/[^a-z0-9&.° ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

const CARE_WORDS = / (995|a&e|ae|emergency|ambulance|nurse|nursefirst|hotline|polyclinic|clinic|pharmacist|hospital) /;

const DIAGNOSIS =
  /\b(do i have|have i got|is it|is this|could it be|might it be|could this be)\b.*\b(cancer|tb|tuberculosis|covid|pneumonia|infection|tumou?r|disease)\b|diagnos|what('?s| is) wrong with me/;

/** Questions that ask Jaga to name an illness. Jaga never does. */
export function isDiagnosisQuestion(text: string): boolean {
  return DIAGNOSIS.test(text.toLowerCase());
}

/** Minimum score for an answer. Below this Jaga says it does not know. */
export const MIN_SCORE = 2;

export function searchKnowledge(
  question: string,
  currentTopic: "cough" | "mouth_ulcer" | null = null
): KbAnswer | null {
  const kb = loadKnowledgeBase();
  const q = normalise(question);

  // If the person names a symptom, answer about that symptom, not the one being tracked.
  const named = (Object.keys(TOPIC_WORDS) as Array<"cough" | "mouth_ulcer">).filter((k) =>
    TOPIC_WORDS[k].test(q)
  );
  const topic = named.length === 1 ? named[0] : currentTopic;

  let best: KbAnswer | null = null;
  for (const entry of kb.entries) {
    if (entry.topic !== "care") {
      if (named.length > 0 ? !named.includes(entry.topic) : topic !== null && entry.topic !== topic) continue;
    }
    let score = 0;
    for (const kw of entry.keywords) {
      if (q.includes(` ${kw} `)) score += 1;
    }
    if (score === 0) continue;
    if (entry.topic === topic) score += 1;
    if (entry.topic === "care" && CARE_WORDS.test(q)) score += 1;
    if (score >= MIN_SCORE && (!best || score > best.score)) {
      best = { entry, source: kb.sources[entry.source], score };
    }
  }
  return best;
}
