// src/conversation/flow.ts
// The conversation layer for the web demo. It owns session state and the
// transcript. src/core stays pure: every medical decision comes from
// processObservation() -> policy. Nothing in this file decides urgency.

import type {
  Episode,
  Mode,
  Observation,
  Person,
  Policy,
  PolicyResult,
  Reporter,
  Symptom,
} from "../core/types.js";
import type { Store } from "../core/repository.js";
import { SimulatedClock } from "../core/clock.js";
import { createStore } from "../core/repository.js";
import { createEpisode, processObservation } from "../core/engine.js";
import { loadPolicy } from "../core/policyLoader.js";
import { getReportedRedFlags, getLatestRedFlagAnswers } from "../core/redFlagScreen.js";
import { minDurationDays } from "../core/episodeStateMachine.js";
import { ScriptedExtractor, extractOnset } from "../llm/ScriptedExtractor.js";
import type { ExtractedObservation } from "../llm/Extractor.js";
import * as copy from "../copy/en.js";
import { CLINICS, type ClinicCard } from "../navigation/prototypeData.js";
import { buildSummary, type GpSummary } from "../navigation/summary.js";
import { isQuestion, isDiagnosisQuestion, searchKnowledge } from "../knowledge/kb.js";
import { isCoughMention, isEmergencyMention } from "./symptomScope.js";
import type {
  ClockPanelState,
  DemoState,
  Pending,
  ProcessAdvanceParams,
  ProcessMessageParams,
  TranscriptEntry,
} from "./types.js";

// ---- Scenarios ----

interface Scenario {
  name: "mr_tan" | "ms_lim";
  defaultMode: Mode;
  personId: string;
  displayName: string;
  supportPersonName?: string;
  symptom: Symptom;
}

const SCENARIOS: Record<string, Scenario> = {
  mr_tan: {
    name: "mr_tan",
    defaultMode: "supported",
    personId: "mr-tan",
    displayName: "Mr Tan",
    supportPersonName: "Mei Ling",
    symptom: "cough",
  },
  ms_lim: {
    name: "ms_lim",
    defaultMode: "independent",
    personId: "ms-lim",
    displayName: "Ms Lim",
    symptom: "cough",
  },
};

// Day 0 of the demo = the day the user first talks to Jaga.
const CLOCK_START = "2026-02-20T08:00:00.000Z";
const MS_PER_DAY = 86_400_000;
const NOT_NOW_REASK_DAYS = 7;

type ShareKind = "threshold" | "help";

export class DemoSession {
  private store: Store;
  private clock: SimulatedClock;
  private scenario: Scenario;
  private policy: Policy;
  private extractor = new ScriptedExtractor();

  private person: Person;
  private mode: Mode;
  private episode: Episode | null = null;
  private transcript: TranscriptEntry[] = [];
  private lastResult: PolicyResult | null = null;

  private pending: Pending = "mode";
  private todo: Array<() => void> = [];

  // onset
  private pendingOnsetRawText: string | null = null;
  // red-flag screening at the start
  private redFlagQueue: string[] = [];
  private currentRedFlagKey: string | null = null;
  private redFlagReasked = new Set<string>();
  // check-ins
  private monitoringStartDay: number | null = null;
  private lastCheckinDayHandled = 0;
  private outstandingCheckinDay: number | null = null;
  // self-treatment label waiting for confirmation (never stored until confirmed)
  private pendingItemLabel: string | null = null;
  // red flags
  private redFlagsNotified = new Set<string>();
  private redFlagActive = false;
  // disagreement
  private clarifyAsked = false;
  // care navigation
  private navOffered = false;
  private clinicIndex = 0;
  private booking: { clinic: ClinicCard; apptDay: number } | null = null;
  private plan: { label: string; planDay: number } | null = null;
  private notNowCount = 0;
  private navReaskDay: number | null = null;
  private remindLaterDay: number | null = null;
  private apptReminderSent = false;
  private wentAskedForDay: number | null = null;
  private careSought = false;
  private summaryOffered = false;
  // sharing
  private thresholdShareHandled = false;
  private shareDraft: { kind: ShareKind; text: string } | null = null;
  private sentToSupport: Array<{ day: number; text: string; urgent: boolean }> = [];

  constructor(scenarioKey: "mr_tan" | "ms_lim") {
    this.scenario = SCENARIOS[scenarioKey];
    this.mode = this.scenario.defaultMode;
    this.store = createStore(":memory:");
    this.clock = new SimulatedClock(CLOCK_START);
    this.policy = loadPolicy(this.scenario.symptom);

    this.person = this.buildPerson();
    this.store.upsertPerson(this.person);

    this.say(copy.GREETING);
    this.sticker("01-hello.png");
    this.say(copy.MODE_QUESTION, [copy.MODE_BUTTONS.on_my_own, copy.MODE_BUTTONS.add_trusted]);
  }

  // ------------------------------------------------------------------ public

  get currentDay(): number {
    return SimulatedClock.daysBetween(CLOCK_START, this.clock.now());
  }

  getState(): DemoState {
    return {
      day: this.currentDay,
      mode: this.mode,
      phase: this.pending ?? "idle",
      scenario: this.scenario.name,
      transcript: [...this.transcript],
      clockPanel: this.buildClockPanel(),
      lastResult: this.lastResult,
    };
  }

  getSummary(): GpSummary | null {
    if (!this.episode) return null;
    return buildSummary({
      displayName: this.person.displayName,
      mode: this.mode,
      episode: this.episode,
      observations: this.store.getObservationsForEpisode(this.episode.id),
      policy: this.policy,
      lastResult: this.lastResult,
      clockStartIso: CLOCK_START,
      nowIso: this.clock.now(),
      minDurationDays: minDurationDays(this.episode, this.clock),
      pendingItemLabel: this.pendingItemLabel,
    });
  }

  async handleMessage(params: ProcessMessageParams): Promise<DemoState> {
    const reporter: Reporter = params.reporter ?? "user";
    const shown = params.text ?? params.button ?? "";
    if (shown) {
      this.transcript.push({
        role: reporter === "support_person" ? "support_person" : "user",
        text: shown,
        day: this.currentDay,
      });
    }

    // A support person can only speak in supported / assisted mode.
    if (reporter === "support_person") {
      if (this.mode !== "independent" && this.episode) {
        await this.handleSupportPersonMessage(params);
      }
      this.runTodo();
      return this.getState();
    }

    // Spec rule 6: red-flag screening runs on EVERY message, before anything else.
    if (this.episode) {
      const duringQuestions = this.pending === "redflag";
      const handled = await this.screenMessageForRedFlags(params, duringQuestions);
      if (handled) {
        if (duringQuestions) {
          // The question that was interrupted still needs an answer, unless it was just reported.
          const open = this.currentRedFlagKey;
          if (open && !this.reportedKeys().has(open)) this.redFlagQueue.unshift(open);
          this.todo.push(() => this.askNextRedFlag());
        }
        this.runTodo();
        return this.getState();
      }
    }

    // Questions are answered from the knowledge base only, never made up.
    if (params.text && this.answerQuestion(params.text)) {
      this.runTodo();
      return this.getState();
    }

    // Prompt 06: emergency signs are always caught first, even before an episode.
    if (!this.episode && params.text && isEmergencyMention(params.text)) {
      this.say(copy.EMERGENCY_NOW);
      this.runTodo();
      return this.getState();
    }

    await this.route(params);
    this.runTodo();
    return this.getState();
  }

  /** Steps where a typed reply is an answer to Jaga, not a question for Jaga. */
  private static readonly NO_QA_STEPS: Pending[] = ["mode", "symptom", "onset", "redflag", "confirm_item"];

  private answerQuestion(text: string): boolean {
    if (!isQuestion(text) || DemoSession.NO_QA_STEPS.includes(this.pending)) return false;
    if (isDiagnosisQuestion(text)) {
      this.say(copy.KB_NO_DIAGNOSIS);
      return true;
    }
    const hit = searchKnowledge(text, this.scenario.symptom);
    if (!hit) {
      this.say(copy.KB_NO_ANSWER);
      return true;
    }
    const footer = hit.entry.topic === "care" ? "" : ` ${copy.KB_FOOTER}`;
    this.say(`${hit.entry.answer}${footer}`, undefined, {
      sourceLabel: hit.source.label,
      sourceUrl: hit.source.url,
    });
    if (hit.entry.id === "cough_prevent") this.sticker("09-mask.png");
    return true;
  }

  async handleAdvance(params: ProcessAdvanceParams): Promise<DemoState> {
    const from = this.currentDay;
    const to = Math.max(Math.floor(params.toDay), from); // forward only
    if (to === from) return this.getState();

    for (let day = from + 1; day <= to; day++) {
      this.clock.advanceToDay(day);
      await this.onNewDay(day);
    }
    this.runTodo();
    return this.getState();
  }

  // ------------------------------------------------------------------ routing

  private async route(params: ProcessMessageParams): Promise<void> {
    switch (this.pending) {
      case "mode":
        return this.onMode(params);
      case "symptom":
        return this.onSymptom(params);
      case "onset":
        return this.onOnset(params);
      case "redflag":
        return this.onRedFlagAnswer(params);
      case "confirm_item":
        return this.onConfirmItem(params);
      case "clarify":
        return this.onClarify(params);
      case "nav":
        return this.onNav(params);
      case "plan":
        return this.onPlan(params);
      case "share":
        return this.onShare(params);
      case "went":
        return this.onWent(params);
      case "doctor_said":
        return this.onDoctorSaid(params);
      case "checkin":
      default:
        return this.onGeneral(params);
    }
  }

  // ------------------------------------------------------------------ setup

  private onMode(params: ProcessMessageParams): void {
    const choice = `${params.button ?? ""} ${params.text ?? ""}`.toLowerCase();
    const wantsSupport = choice.includes("trusted") || choice.includes("add");

    if (wantsSupport && this.scenario.supportPersonName) {
      this.mode = "supported";
      this.say(copy.MODE_CONFIRM_SUPPORTED(this.scenario.supportPersonName));
    } else if (wantsSupport) {
      this.mode = "independent";
      this.say(copy.MODE_NO_SUPPORT_IN_SCENARIO);
    } else {
      this.mode = "independent";
      this.say(copy.MODE_CONFIRM_INDEPENDENT);
    }
    this.person = this.buildPerson();
    this.store.upsertPerson(this.person);

    this.pending = "symptom";
    this.say(copy.ASK_SYMPTOM);
  }

  private async onSymptom(params: ProcessMessageParams): Promise<void> {
    const text = (params.text ?? params.button ?? "").trim();
    if (!text) return;

    // Prompt 06: only track a cough. For anything else, say so plainly.
    if (!isCoughMention(text)) {
      this.say(copy.NOT_COVERED_YET);
      this.pending = "symptom";
      return;
    }

    const onsetMatch = extractOnset(text);
    const onset: Episode["onset"] = onsetMatch
      ? {
          rawText: onsetMatch.rawText, // the user's own words
          latestPossible: onsetMatch.latestPossible,
          confidence: onsetMatch.confidence,
        }
      : { rawText: text, latestPossible: this.clock.now(), confidence: "unknown" };

    this.episode = await createEpisode(this.person, this.scenario.symptom, onset, this.clock);
    this.store.insertEpisode(this.episode);

    await this.record({ kind: "mention", rawText: text }, "user");

    // A red flag can be buried in the very first message.
    const extracted = this.extractor.extract({ text });
    const reported = extracted.filter(
      (e) => e.kind === "redflag_answer" && Object.values(e.redFlags ?? {}).includes("reported")
    );
    for (const e of reported) await this.record(e, "user");

    if (onsetMatch) {
      this.say(copy.SYMPTOM_ACKNOWLEDGED(onset.rawText, minDurationDays(this.episode, this.clock)));
      if (this.lastResult?.redFlagKey) return this.escalateRedFlag(this.lastResult);
      this.startRedFlagQuestions();
    } else {
      this.pendingOnsetRawText = text;
      this.pending = "onset";
      this.say(copy.ASK_ONSET, copy.ONSET_BUTTONS);
    }
  }

  private onOnset(params: ProcessMessageParams): void {
    if (!this.episode) return;
    const button = params.button ?? "";
    const text = params.text ?? "";
    const match = extractOnset(text);

    let latestPossible: string;
    let rawText: string;
    if (copy.ONSET_BUTTON_MIN_DAYS[button] !== undefined) {
      latestPossible = this.isoDaysAgo(copy.ONSET_BUTTON_MIN_DAYS[button]);
      rawText = button;
    } else if (match) {
      latestPossible = match.latestPossible;
      rawText = match.rawText;
    } else {
      // Still unclear: keep their words, claim no duration at all.
      latestPossible = this.clock.now();
      rawText = text || this.pendingOnsetRawText || "not sure";
    }

    this.episode = {
      ...this.episode,
      onset: { rawText, latestPossible, confidence: "approximate" },
    };
    this.store.updateEpisode(this.episode);
    this.say(copy.SYMPTOM_ACKNOWLEDGED(rawText, minDurationDays(this.episode, this.clock)));

    if (this.lastResult?.redFlagKey) return this.escalateRedFlag(this.lastResult);
    this.startRedFlagQuestions();
  }

  // ------------------------------------------------------------------ red flags

  private startRedFlagQuestions(): void {
    this.redFlagQueue = this.policy.redFlags.map((rf) => rf.key);
    this.askNextRedFlag();
  }

  private askNextRedFlag(): void {
    const key = this.redFlagQueue.shift();
    if (!key) {
      this.currentRedFlagKey = null;
      this.pending = null;
      this.startMonitoring();
      return;
    }
    this.currentRedFlagKey = key;
    this.pending = "redflag";
    this.say(copy.RED_FLAG_QUESTIONS[key] ?? `Any of this: ${key}?`, copy.YES_NO);
  }

  private async onRedFlagAnswer(params: ProcessMessageParams): Promise<void> {
    const key = this.currentRedFlagKey;
    if (!key) return;
    const said = `${params.button ?? ""} ${params.text ?? ""}`.toLowerCase();
    const neg = /\b(no|nope|none|not|never|don't|dont)\b/.test(said);
    const pos = /\b(yes|yeah|yup|got|have)\b/.test(said);
    const answer = pos && !neg ? "reported" : neg && !pos ? "denied" : "unknown";

    // An unclear answer to a warning-sign question is never waved through: ask once more.
    if (answer === "unknown" && !this.redFlagReasked.has(key)) {
      this.redFlagReasked.add(key);
      this.say(`Sorry, I need a clear yes or no. ${copy.RED_FLAG_QUESTIONS[key] ?? ""}`.trim(), copy.YES_NO);
      return;
    }

    const result = await this.record(
      { kind: "redflag_answer", redFlags: { [key]: answer }, rawText: params.text ?? params.button },
      "user"
    );
    if (result.redFlagKey) {
      this.pending = null;
      this.escalateRedFlag(result);
      // Keep asking the remaining questions afterwards: a second flag may be more urgent.
      this.todo.push(() => this.askNextRedFlag());
      return;
    }
    this.askNextRedFlag();
  }

  /** Spec rule 6. Returns true when the message was fully handled here. */
  private async screenMessageForRedFlags(
    params: ProcessMessageParams,
    onlyReports = false
  ): Promise<boolean> {
    const extracted = this.extractor
      .extract({ text: params.text, button: params.button })
      .filter((e) => e.kind === "redflag_answer")
      .filter((e) => !onlyReports || Object.values(e.redFlags ?? {}).includes("reported"));
    if (extracted.length === 0) return false;

    const before = this.reportedKeys();
    let result: PolicyResult | null = null;
    for (const e of extracted) result = await this.record(e, "user");
    const after = this.reportedKeys();

    const newlyReported = [...after].filter((k) => !before.has(k));
    if (newlyReported.length > 0 && result?.redFlagKey) {
      this.pending = null;
      this.escalateRedFlag(result);
      return true;
    }
    // A denial of something reported earlier: sticky, never cleared (spec rule 7).
    const deniedEarlier = extracted
      .flatMap((e) => Object.entries(e.redFlags ?? {}))
      .filter(([k, v]) => v === "denied" && before.has(k))
      .map(([k]) => k);
    if (deniedEarlier.length > 0) {
      this.say(copy.RED_FLAG_DENY_REPLY(deniedEarlier[0]));
      return true;
    }
    return false;
  }

  private escalateRedFlag(result: PolicyResult): void {
    const key = result.redFlagKey!;
    this.redFlagActive = true;
    // Plain, direct instruction. No persona, no softening.
    this.say(copy.redFlagMessage(result.action, key));

    // Urgent signs are a threshold the user agreed to at setup. Tell them exactly what was sent.
    if (this.canShare() && !this.redFlagsNotified.has(key)) {
      this.redFlagsNotified.add(key);
      const text = copy.SUPPORT_URGENT_TEXT(this.person.displayName);
      this.sentToSupport.push({ day: this.currentDay, text, urgent: true });
      this.system(copy.SENT_TO_SUPPORT(this.scenario.supportPersonName!, text, true));
    }
  }

  // ------------------------------------------------------------------ monitoring

  private startMonitoring(): void {
    if (this.monitoringStartDay !== null) return;
    this.monitoringStartDay = this.currentDay;
    this.lastCheckinDayHandled = this.currentDay;
    this.say(copy.CLOCK_STARTED(this.policy.checkinEveryDays));
    this.sticker("03-counting.png");
  }

  private async onNewDay(day: number): Promise<void> {
    if (!this.episode || this.monitoringStartDay === null) return;

    // 1. Check-ins. Ask once per check-in day. Silence is recorded only when the
    //    NEXT check-in day arrives and the previous question was never answered.
    const every = this.policy.checkinEveryDays;
    if ((day - this.monitoringStartDay) % every === 0 && day > this.lastCheckinDayHandled) {
      if (this.outstandingCheckinDay !== null) {
        await this.record(
          { kind: "silence", trajectory: "unknown", rawText: "(no reply to check-in)" },
          "user"
        );
        this.system(copy.SILENCE_RECORDED);
      }
      this.lastCheckinDayHandled = day;
      this.outstandingCheckinDay = null;
      if (this.pending === null || this.pending === "checkin") {
        this.pending = "checkin";
        this.outstandingCheckinDay = day; // only counts as asked if it was really shown
        this.say(copy.checkinMessage(), copy.CHECKIN_BUTTONS);
        this.sticker("02-still-got.png");
      }
    }

    // 2. Appointment reminder the day before, "did you go?" the day after.
    if (this.booking && !this.careSought) {
      if (day === this.booking.apptDay && !this.apptReminderSent) {
        this.apptReminderSent = true;
        this.say(copy.APPT_REMINDER(this.booking.clinic.clinic, this.booking.clinic.slotTime));
      }
      if (day >= this.booking.apptDay + 1 && this.wentAskedForDay !== this.booking.apptDay) {
        this.wentAskedForDay = this.booking.apptDay;
        this.todo.push(() => this.askWent());
      }
    } else if (this.plan && !this.careSought) {
      if (day >= this.plan.planDay + 1 && this.wentAskedForDay !== this.plan.planDay) {
        this.wentAskedForDay = this.plan.planDay;
        this.todo.push(() => this.askWent());
      }
    }

    // 3. "Remind me later today": asked again the next time the clock moves.
    if (this.remindLaterDay !== null && day > this.remindLaterDay && !this.booking && !this.plan) {
      this.remindLaterDay = null;
      this.todo.push(() => this.offerNavigation(copy.REMIND_LATER_PROMPT));
    }

    // 4. "Not now": exactly one re-ask, a week later. Never daily.
    if (this.navReaskDay !== null && day >= this.navReaskDay && !this.booking && !this.plan) {
      this.navReaskDay = null;
      this.todo.push(() =>
        this.offerNavigation(copy.NAV_REASK(minDurationDays(this.episode!, this.clock)))
      );
    }
  }

  /** Free text, check-in answers, quick buttons. */
  private async onGeneral(params: ProcessMessageParams): Promise<void> {
    if (!this.episode) return;
    const extracted = this.extractor
      .extract({ text: params.text, button: params.button })
      .filter((e) => e.kind !== "redflag_answer"); // handled by the screen already

    const treatment = extracted.find((e) => e.kind === "self_treatment");
    const checkin = extracted.find((e) => e.kind === "checkin" && e.trajectory);

    let result: PolicyResult | null = null;

    if (checkin) {
      result = await this.record(checkin, "user");
      this.outstandingCheckinDay = null;
      if (this.pending === "checkin") this.pending = null;
    }

    if (treatment) {
      // The event (took something) is recorded. The LABEL is not stored until confirmed (rule 5).
      result = await this.record(
        { kind: "self_treatment", item: { label: "unspecified", confirmed: false }, rawText: treatment.rawText },
        "user"
      );
      this.pendingItemLabel = treatment.item?.label ?? null;
    }

    if (!checkin && !treatment) {
      result = await this.record({ kind: "mention", rawText: params.text ?? params.button }, "user");
    }

    if (treatment && this.pendingItemLabel) {
      this.pending = "confirm_item";
      this.say(copy.ASK_SELF_TREATMENT_CONFIRM(this.pendingItemLabel), copy.SELF_TREATMENT_BUTTONS);
      // Whatever the policy says next waits until the label question is answered.
      return;
    }

    if (result) this.afterResult(result, checkin ?? null);
  }

  private async onConfirmItem(params: ProcessMessageParams): Promise<void> {
    const said = `${params.button ?? ""} ${params.text ?? ""}`.toLowerCase();
    const label = this.pendingItemLabel;
    this.pendingItemLabel = null;
    this.pending = null;
    if (label && /\b(correct|yes)\b/.test(said) && !said.includes("not")) {
      await this.record(
        { kind: "self_treatment", item: { label, confirmed: true }, rawText: "confirmed by user" },
        "user"
      );
      this.say(copy.SELF_TREATMENT_CONFIRMED);
    } else {
      this.say(copy.SELF_TREATMENT_NOT_RIGHT);
    }
    // Taking something can itself complete a sourced rule (for example "not better
    // after self-treatment"). The action still comes from the policy, never from here.
    const result = this.lastResult;
    if (result && !result.redFlagKey && result.action === "SEE_GP" && !this.navOffered) {
      this.offerNavigation(null, result);
    }
    if (this.pending === null && this.outstandingCheckinDay !== null) this.pending = "checkin";
  }

  /** Turn a policy result into conversation. The ACTION always comes from the policy. */
  private afterResult(result: PolicyResult, checkin: ExtractedObservation | null): void {
    if (result.redFlagKey) {
      if (checkin) this.say(copy.RED_FLAG_REMINDER);
      return;
    }

    const t = checkin?.trajectory;
    const ack =
      t === "gone" ? copy.CHECKIN_ACK_GONE : t === "better" ? copy.CHECKIN_ACK_BETTER : copy.CHECKIN_ACK_SAME;

    if (result.action === "SEE_GP" && !this.navOffered) {
      this.offerNavigation(null, result);
    } else if (result.action === "SEE_GP" && !this.booking && !this.plan && !this.careSought) {
      this.say(copy.NAV_REMINDER_SHORT(minDurationDays(this.episode!, this.clock)));
    } else {
      this.say(checkin ? ack : copy.GENERIC_ACK);
    }
    if (t === "better" || t === "gone") this.sticker("08-better.png");

    if (result.followUps.includes("ASK_CLARIFICATION") && !this.clarifyAsked) {
      this.todo.push(() => this.askClarification());
    }
  }

  // ------------------------------------------------------------------ support person

  private async handleSupportPersonMessage(params: ProcessMessageParams): Promise<void> {
    const extracted = this.extractor.extract({ text: params.text, button: params.button });
    let result: PolicyResult | null = null;
    const before = this.reportedKeys();
    for (const e of extracted) {
      if (e.kind === "self_treatment") continue; // only the user confirms what they took
      const kind = e.kind === "mention" && !e.trajectory ? "mention" : e.kind;
      result = await this.record({ ...e, kind }, "support_person");
    }
    if (!result) return;

    const newlyReported = [...this.reportedKeys()].filter((k) => !before.has(k));
    if (newlyReported.length > 0 && result.redFlagKey) {
      this.escalateRedFlag(result);
      return;
    }
    if (result.followUps.includes("ASK_CLARIFICATION") && !this.clarifyAsked) {
      this.todo.push(() => this.askClarification());
    }
    if (result.action === "SEE_GP" && !this.navOffered) {
      this.todo.push(() => this.offerNavigation(null, result!));
    }
  }

  private askClarification(): void {
    if (this.pending !== null && this.pending !== "checkin") return;
    this.clarifyAsked = true;
    this.pending = "clarify";
    this.say(copy.ASK_CLARIFICATION_MSG, copy.CLARIFY_BUTTONS);
  }

  private async onClarify(params: ProcessMessageParams): Promise<void> {
    const said = `${params.button ?? ""} ${params.text ?? ""}`.toLowerCase();
    this.pending = this.outstandingCheckinDay !== null ? "checkin" : null;
    // "Yes" means the user confirms the symptom is still there. That is state, not urgency.
    const trajectory = /\byes\b/.test(said) ? "same" : /\bno\b/.test(said) ? undefined : "unknown";
    const result = await this.record(
      { kind: "checkin", trajectory, rawText: `clarification: ${params.button ?? params.text ?? ""}` },
      "user"
    );
    this.say(copy.CLARIFY_ACK);
    if (result.action === "SEE_GP" && !this.navOffered) this.offerNavigation(null, result);
  }

  // ------------------------------------------------------------------ care navigation

  private offerNavigation(intro: string | null, result?: PolicyResult): void {
    if (this.booking || this.careSought) return;
    if (this.pending !== null && this.pending !== "checkin") {
      this.todo.push(() => this.offerNavigation(intro, result));
      return;
    }
    const first = !this.navOffered;
    this.navOffered = true;

    if (intro) this.say(intro);
    if (first && result) {
      this.say(copy.SEE_GP_INTRO(minDurationDays(this.episode!, this.clock)));
      this.sticker("04-day-14.png");
      if (result.explain) {
        this.say(copy.SEE_GP_WHY(result.explain), undefined, {
          sourceLabel: result.source?.label,
          sourceUrl: result.source?.url,
        });
        this.sticker("05-see-gp.png");
      }
    }
    this.showClinicCard();
  }

  private showClinicCard(): void {
    const card = CLINICS[this.clinicIndex % CLINICS.length];
    const buttons = [
      copy.NAV_BUTTONS.book,
      copy.NAV_BUTTONS.others,
      copy.NAV_BUTTONS.later,
      copy.NAV_BUTTONS.notNow,
    ];
    if (this.canShare()) buttons.push(copy.NAV_BUTTONS.askSupport(this.scenario.supportPersonName!));
    this.pending = "nav";
    this.say(card.heading, buttons, { card });
  }

  private async onNav(params: ProcessMessageParams): Promise<void> {
    const choice = (params.button ?? params.text ?? "").toLowerCase();

    if (choice.includes("book")) {
      const clinic = CLINICS[this.clinicIndex % CLINICS.length];
      this.booking = { clinic, apptDay: this.currentDay + 1 };
      this.plan = null;
      this.pending = null;
      await this.record({ kind: "plan", rawText: `booked (prototype): ${clinic.clinic}, ${clinic.slot}` }, "user");
      this.say(copy.BOOKED(clinic.clinic, clinic.slot), undefined, { card: clinic });
      this.sticker("06-booked.png");
      this.offerSummary();
      this.queueThresholdShare();
      return;
    }
    if (choice.includes("other")) {
      this.clinicIndex += 1;
      return this.showClinicCard();
    }
    if (choice.includes("later")) {
      this.pending = null;
      this.remindLaterDay = this.currentDay;
      this.say(copy.REMIND_LATER_ACK);
      return;
    }
    if (choice.includes("help") || choice.includes("ask")) {
      if (this.canShare()) return this.previewShare("help");
      this.pending = null;
      return;
    }
    // "Not now" (or anything else): respected and logged.
    await this.record({ kind: "plan", rawText: "declined for now" }, "user");
    this.notNowCount += 1;
    if (this.notNowCount === 1) {
      this.pending = "plan";
      this.say(copy.ASK_WHEN, [...copy.PLAN_BUTTONS, copy.NAV_BUTTONS.notNow]);
    } else {
      this.pending = null;
      this.say(copy.NOT_NOW_FINAL);
    }
  }

  private async onPlan(params: ProcessMessageParams): Promise<void> {
    const choice = (params.button ?? params.text ?? "").trim();
    const lower = choice.toLowerCase();
    this.pending = null;

    if (lower.includes("not now") || lower === "no") {
      // Declined again: one more ask in a week, then never again.
      this.navReaskDay = this.currentDay + NOT_NOW_REASK_DAYS;
      this.say(copy.NOT_NOW_LOGGED);
      return;
    }
    const planDay = lower.includes("weekend") ? this.nextSaturday() : this.currentDay + 1;
    this.plan = { label: choice, planDay };
    this.navReaskDay = null;
    await this.record({ kind: "plan", rawText: `plans to go: ${choice}` }, "user");
    this.say(copy.PLAN_SET(choice));
    this.offerSummary();
    this.queueThresholdShare();
  }

  private askWent(): void {
    if (this.careSought) return;
    if (this.pending !== null && this.pending !== "checkin") {
      this.todo.push(() => this.askWent());
      return;
    }
    this.pending = "went";
    this.say(copy.DID_YOU_GO, copy.WENT_BUTTONS);
    this.sticker("07-went-already.png");
  }

  private onWent(params: ProcessMessageParams): void {
    const said = `${params.button ?? ""} ${params.text ?? ""}`.toLowerCase();
    if (/\byes\b/.test(said) && !said.includes("not")) {
      this.pending = "doctor_said";
      this.say(copy.ASK_DOCTOR_SAID);
      return;
    }
    // Not yet: offer the plan buttons once.
    this.booking = null;
    this.plan = null;
    this.pending = "plan";
    this.say(copy.NOT_YET_REPLY, [...copy.PLAN_BUTTONS, copy.NAV_BUTTONS.notNow]);
  }

  private async onDoctorSaid(params: ProcessMessageParams): Promise<void> {
    this.careSought = true;
    this.pending = this.outstandingCheckinDay !== null ? "checkin" : null;
    await this.record({ kind: "care_sought", rawText: params.text ?? params.button ?? "" }, "user");
    this.say(copy.DOCTOR_SAID_ACK);
  }

  private offerSummary(): void {
    if (this.summaryOffered) return;
    this.summaryOffered = true;
    this.say(copy.SUMMARY_OFFER, undefined, {
      link: { label: copy.SUMMARY_LINK_LABEL, href: "summary.html" },
    });
  }

  // ------------------------------------------------------------------ sharing

  private canShare(): boolean {
    return (
      this.mode !== "independent" &&
      !!this.scenario.supportPersonName &&
      this.person.consent.shareAtThresholds
    );
  }

  private queueThresholdShare(): void {
    if (!this.canShare() || this.thresholdShareHandled) return;
    this.todo.push(() => this.previewShare("threshold"));
  }

  private previewShare(kind: ShareKind): void {
    if (!this.canShare() || !this.episode) return;
    if (this.pending !== null && this.pending !== "nav" && this.pending !== "checkin") {
      this.todo.push(() => this.previewShare(kind));
      return;
    }
    const days = minDurationDays(this.episode, this.clock);
    const make = kind === "help" ? copy.HELP_TEXT : copy.THRESHOLD_TEXT;
    const text = make(this.person.displayName, this.episode.symptom.replace("_", " "), days);
    this.shareDraft = { kind, text };
    this.thresholdShareHandled = true; // one preview covers the threshold
    this.pending = "share";
    this.say(copy.SHARE_PREVIEW(this.scenario.supportPersonName!, text), copy.SHARE_BUTTONS);
  }

  private onShare(params: ProcessMessageParams): void {
    const said = (params.button ?? params.text ?? "").toLowerCase();
    const draft = this.shareDraft;
    this.shareDraft = null;
    this.pending = null;
    if (draft && said.startsWith("send")) {
      this.sentToSupport.push({ day: this.currentDay, text: draft.text, urgent: false });
      this.system(copy.SENT_TO_SUPPORT(this.scenario.supportPersonName!, draft.text));
    } else {
      this.say(copy.SHARE_NOT_SENT);
    }
    // After asking for help, the visit still needs a time.
    if (draft?.kind === "help" && !this.booking && !this.plan) {
      this.pending = "plan";
      this.say("When could you go?", [...copy.PLAN_BUTTONS, copy.NAV_BUTTONS.notNow]);
    }
  }

  // ------------------------------------------------------------------ helpers

  private async record(
    ext: Partial<ExtractedObservation> & { kind: Observation["kind"] },
    reporter: Reporter
  ): Promise<PolicyResult> {
    const { result, episode } = await processObservation(
      this.store,
      this.episode!,
      {
        at: this.clock.now(),
        reporter,
        kind: ext.kind,
        trajectory: ext.trajectory,
        redFlags: ext.redFlags,
        item: ext.item,
        rawText: ext.rawText,
      },
      this.clock
    );
    this.episode = episode;
    this.lastResult = result;
    return result;
  }

  private reportedKeys(): Set<string> {
    if (!this.episode) return new Set();
    return new Set(getReportedRedFlags(this.store.getObservationsForEpisode(this.episode.id)).keys());
  }

  private runTodo(): void {
    let guard = 0;
    while (this.todo.length > 0 && guard++ < 20) {
      const before = this.todo.length;
      const job = this.todo.shift()!;
      job();
      // A job that could not run re-queues itself; stop to avoid spinning.
      if (this.todo.length >= before && this.pending !== null) break;
    }
  }

  private buildPerson(): Person {
    const supported = this.mode !== "independent";
    return {
      id: this.scenario.personId,
      displayName: this.scenario.displayName,
      language: "en",
      mode: this.mode,
      supportPersonId: supported ? "support-1" : undefined,
      consent: { shareAtThresholds: supported },
    };
  }

  private isoDaysAgo(days: number): string {
    return new Date(this.clock.nowMs() - days * MS_PER_DAY).toISOString();
  }

  private nextSaturday(): number {
    const dow = new Date(this.clock.nowMs()).getUTCDay(); // 6 = Saturday
    const delta = (6 - dow + 7) % 7 || 7;
    return this.currentDay + delta;
  }

  private say(
    text: string,
    buttons?: string[],
    extra?: Partial<Pick<TranscriptEntry, "sourceLabel" | "sourceUrl" | "card" | "link">>
  ): void {
    this.transcript.push({ role: "jaga", text, buttons, day: this.currentDay, ...extra });
  }

  /** Push a sticker entry (empty text, no bubble). Used AFTER the text message. */
  private sticker(name: string): void {
    this.transcript.push({ role: "jaga", text: "", sticker: name, day: this.currentDay });
  }

  private system(text: string): void {
    this.transcript.push({ role: "system", text, day: this.currentDay });
  }

  /** For tests and the summary: everything that actually left for the support person. */
  getSentToSupport(): Array<{ day: number; text: string; urgent: boolean }> {
    return [...this.sentToSupport];
  }

  // ------------------------------------------------------------------ clock panel

  private buildClockPanel(): ClockPanelState {
    const episode = this.episode;
    if (!episode) {
      return {
        mode: this.mode,
        symptom: null,
        onsetRawText: null,
        minDurationDays: 0,
        confidence: null,
        trajectory: null,
        state: null,
        redFlags: [],
        selfTreatment: [],
        discordance: false,
        missedCheckins: 0,
        policyId: this.policy.id,
        policyVersion: this.policy.version,
        pendingReview: true,
        lastRuleFired: null,
      };
    }

    const observations = this.store.getObservationsForEpisode(episode.id);
    const reported = getReportedRedFlags(observations);
    const latest = getLatestRedFlagAnswers(observations);

    const redFlags = this.policy.redFlags.map((rf) => {
      const report = reported.get(rf.key);
      if (report) {
        return {
          key: rf.key,
          status: "reported" as const,
          reportedBy: report.reporter,
          reportedAt: report.at,
        };
      }
      return { key: rf.key, status: latest[rf.key] === "denied" ? ("denied" as const) : ("unknown" as const) };
    });

    return {
      mode: this.mode,
      symptom: episode.symptom,
      onsetRawText: episode.onset.rawText,
      minDurationDays: minDurationDays(episode, this.clock),
      confidence: episode.onset.confidence,
      trajectory: episode.trajectory,
      state: episode.state,
      redFlags,
      selfTreatment: selfTreatmentView(observations, this.pendingItemLabel),
      discordance: episode.discordance,
      missedCheckins: episode.missedCheckins,
      policyId: episode.policyId,
      policyVersion: episode.policyVersion,
      pendingReview: this.policy.status !== "REVIEWED",
      lastRuleFired: this.lastResult?.ruleId ?? null,
    };
  }
}

/** Confirmed labels, plus anything still waiting for the user's confirmation. */
export function selfTreatmentView(
  observations: Observation[],
  pendingLabel: string | null
): { label: string; confirmed: boolean }[] {
  const items = observations.filter((o) => o.kind === "self_treatment" && o.item);
  const confirmed = [...new Set(items.filter((o) => o.item!.confirmed).map((o) => o.item!.label))];
  const view = confirmed.map((label) => ({ label, confirmed: true }));
  if (pendingLabel) view.push({ label: pendingLabel, confirmed: false });
  const unnamedEvents = items.filter((o) => !o.item!.confirmed).length;
  if (unnamedEvents > confirmed.length + (pendingLabel ? 1 : 0)) {
    view.push({ label: "unspecified", confirmed: false });
  }
  return view;
}

// ---- Session manager (one per browser session) ----

const sessions = new Map<string, DemoSession>();

export function getSession(sessionId: string): DemoSession | undefined {
  return sessions.get(sessionId);
}

export function createSession(sessionId: string, scenario: "mr_tan" | "ms_lim"): DemoSession {
  const session = new DemoSession(scenario);
  sessions.set(sessionId, session);
  return session;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
