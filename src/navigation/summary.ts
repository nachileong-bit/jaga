// src/navigation/summary.ts
// Builds the one-page GP summary. It is a RECORD of what was reported.
// It contains no diagnosis, no disease names and no advice.

import type { Episode, Mode, Observation, Policy, PolicyResult } from "../core/types.js";
import { getReportedRedFlags, getLatestRedFlagAnswers } from "../core/redFlagScreen.js";

export interface SummaryInput {
  displayName: string;
  mode: Mode;
  episode: Episode;
  observations: Observation[];
  policy: Policy;
  lastResult: PolicyResult | null;
  clockStartIso: string;
  nowIso: string;
  minDurationDays: number;
  pendingItemLabel: string | null;
}

export interface GpSummary {
  title: string;
  person: string;
  generatedOnDay: number;
  symptom: string;
  onset: { inTheirWords: string; minDurationDays: number; confidence: string };
  trajectory: string;
  state: string;
  timeline: { day: number; who: string; what: string }[];
  selfTreatment: { label: string; status: "confirmed by user" | "not confirmed" }[];
  redFlags: { key: string; status: string; detail: string }[];
  disagreement: string | null;
  ruleFired: {
    ruleId: string | null;
    action: string;
    explain: string | null;
    policy: string;
    policyStatus: string;
    sourceLabel: string | null;
    sourceUrl: string | null;
  } | null;
  unsure: string[];
  footer: string;
}

const MS_PER_DAY = 86_400_000;

const RED_FLAG_LABELS: Record<string, string> = {
  blood: "Blood when coughing",
  breathless_or_chest_pain: "Breathlessness or chest pain",
};

export function buildSummary(input: SummaryInput): GpSummary {
  const { episode, observations, policy, lastResult } = input;
  const startMs = new Date(input.clockStartIso).getTime();
  const dayOf = (iso: string) => Math.floor((new Date(iso).getTime() - startMs) / MS_PER_DAY);
  const who = (o: Observation) => (o.reporter === "support_person" ? "Support person" : input.displayName);

  const timeline = observations
    .map((o) => ({ day: dayOf(o.at), who: who(o), what: describe(o) }))
    .filter((row) => row.what !== "");

  const items = observations.filter((o) => o.kind === "self_treatment" && o.item);
  const confirmed = [...new Set(items.filter((o) => o.item!.confirmed).map((o) => o.item!.label))];
  const selfTreatment: GpSummary["selfTreatment"] = confirmed.map((label) => ({
    label,
    status: "confirmed by user",
  }));
  if (input.pendingItemLabel) {
    selfTreatment.push({ label: `${input.pendingItemLabel} (read by Jaga)`, status: "not confirmed" });
  }
  if (items.length > 0 && confirmed.length === 0 && !input.pendingItemLabel) {
    selfTreatment.push({ label: "Took something, name not known", status: "not confirmed" });
  }

  const reported = getReportedRedFlags(observations);
  const latest = getLatestRedFlagAnswers(observations);
  const redFlags = policy.redFlags.map((rf) => {
    const label = RED_FLAG_LABELS[rf.key] ?? rf.key;
    const report = reported.get(rf.key);
    if (report) {
      const by = report.reporter === "support_person" ? "support person" : input.displayName;
      const laterDenied = latest[rf.key] === "denied" ? " Later denied. The earlier report is kept." : "";
      return { key: label, status: "REPORTED", detail: `Reported by ${by} on day ${dayOf(report.at)}.${laterDenied}` };
    }
    if (latest[rf.key] === "denied") return { key: label, status: "Denied", detail: "Asked and denied." };
    return { key: label, status: "Not known", detail: "Not asked or not answered." };
  });

  const unsure: string[] = [];
  if (episode.onset.confidence !== "exact") {
    unsure.push("The exact start date. The duration shown is the minimum that can be supported.");
  }
  if (episode.missedCheckins > 0 || observations.some((o) => o.kind === "silence")) {
    unsure.push("How the symptom was on the days with no reply. These are recorded as unknown.");
  }
  if (selfTreatment.some((s) => s.status === "not confirmed")) {
    unsure.push("What exactly was taken. Unconfirmed items should be checked with the patient or a pharmacist.");
  }
  if (episode.discordance) {
    unsure.push("How the symptom is changing. The patient and the support person reported different things.");
  }

  return {
    title: "Symptom record for your doctor",
    person: input.displayName,
    generatedOnDay: dayOf(input.nowIso),
    symptom: episode.symptom.replace("_", " "),
    onset: {
      inTheirWords: episode.onset.rawText,
      minDurationDays: input.minDurationDays,
      confidence: episode.onset.confidence,
    },
    trajectory: episode.trajectory,
    state: episode.state,
    timeline,
    selfTreatment,
    redFlags,
    disagreement: episode.discordance
      ? "The patient and the support person gave different reports. Both are shown in the timeline."
      : null,
    ruleFired: lastResult
      ? {
          ruleId: lastResult.ruleId ?? (lastResult.redFlagKey ? `red flag: ${lastResult.redFlagKey}` : null),
          action: lastResult.action,
          explain: lastResult.explain ?? null,
          policy: `${policy.id} v${policy.version}`,
          policyStatus: policy.status.replace(/_/g, " "),
          sourceLabel: lastResult.source?.label ?? null,
          sourceUrl: lastResult.source?.url ?? null,
        }
      : null,
    unsure,
    footer: "This is a record of what was reported. It is not a diagnosis.",
  };
}

function describe(o: Observation): string {
  const said = o.rawText ? ` ("${o.rawText}")` : "";
  switch (o.kind) {
    case "mention":
      return `Mentioned${said}`;
    case "checkin":
      return o.trajectory ? `Check-in: ${o.trajectory}${said}` : `Check-in${said}`;
    case "silence":
      return "No reply to check-in (recorded as unknown)";
    case "self_treatment":
      return o.item?.confirmed ? `Took: ${o.item.label} (confirmed)` : "Said they took something";
    case "redflag_answer": {
      const parts = Object.entries(o.redFlags ?? {}).map(
        ([k, v]) => `${RED_FLAG_LABELS[k] ?? k}: ${v}`
      );
      return `Warning-sign answer. ${parts.join("; ")}`;
    }
    case "plan":
      return `Care plan${said}`;
    case "care_sought":
      return `Saw a doctor. Asked to watch for${said}`;
    default:
      return "";
  }
}
