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
import { isCoughMention, isEmergencyMention, isFeverWithoutNumber, isNonCoughSymptom, isOwnCoughReport } from "./symptomScope.js";
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
  private onsetReasked = false;
  // question asked alongside the first cough report; answered after red-flags
  private pendingQuestionText: string | null = null;
  // red-flag screening at the start
  private redFlagQueue: string[] = [];
  private currentRedFlagKey: string | null = null;
  private redFlagReasked = new Set<string>();
  // check-ins
  private monitoringStartDay: number | null = null;
  private lastCheckinDayHandled = 0;
  private outstandingCheckinDay: number | null = null;
  private checkinFollowupAskedDay: number | null = null;
  // self-treatment label waiting for confirmation (never stored until confirmed)
  private pendingItemLabel: string | null = null;
  // red flags
  private redFlagsNotified = new Set<string>();
  private redFlagActive = false;
  // Bug 4: hold routine check-ins after an emergency until the person replies.
  private emergencyPending = false;
  // Bug 4: the next check-in after an emergency asks "Did you get checked?" first.
  private needEmergencyCheckin = false;
  // Bug 5: count unanswered check-in follow-ups for the trusted-person draft.
  private unansweredFollowupCount = 0;
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
      simDate: this.clock.now(),
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

    // Bug 4: the user replied, so emergencyPending is cleared. needEmergencyCheckin
    // persists so the next check-in still asks "Did you get checked?".
    this.emergencyPending = false;

    // Bug 7: non-English text gets a standard reply and keeps the step.
    if (params.text && this.isNonEnglish(params.text)) {
      this.say(copy.NON_ENGLISH_REPLY);
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

    // Prompt 06: emergency signs are always caught, before any episode and
    // during monitoring. Run on every message (after the red-flag screen so
    // that blood / breathless reports are recorded properly first).
    // At the symptom step with a cough mention, let onSymptom handle it so
    // the episode is created and the red flag is recorded (e.g. "cough with
    // chest pain" should create the episode AND escalate).
    if (params.text && isEmergencyMention(params.text) && !(this.pending === "symptom" && isCoughMention(params.text))) {
      this.say(copy.EMERGENCY_NOW);
      this.runTodo();
      return this.getState();
    }

    // After the clock has started: fever without a number gets the KB answer;
    // a non-cough symptom gets NOT_COVERED_YET. Never reply "Noted." to those.
    if (this.episode && this.monitoringStartDay !== null && params.text) {
      const text = params.text;
      const stepsForIntercept: Pending[] = ["mode", "symptom", "onset", "redflag", "checkin_followup", "confirm_item", "clarify", "nav", "share", "went", "doctor_said"];
      if (!stepsForIntercept.includes(this.pending) && this.pending !== "plan") {
        if (isFeverWithoutNumber(text) && !isCoughMention(text)) {
          // Reply with the HealthHub cough answer about fever.
          const hit = searchKnowledge("what about fever and cough", this.scenario.symptom);
          if (hit) {
            this.say(hit.entry.answer, undefined, {
              sourceLabel: hit.source.label,
              sourceUrl: hit.source.url,
            });
          } else {
            this.say(copy.NOT_COVERED_YET);
          }
          this.runTodo();
          return this.getState();
        }
        if (isNonCoughSymptom(text) && !isCoughMention(text)) {
          this.say(copy.NOT_COVERED_YET);
          this.runTodo();
          return this.getState();
        }
      }
    }

    // Questions are answered from the knowledge base only, never made up.
    if (params.text && this.answerQuestion(params.text)) {
      this.runTodo();
      return this.getState();
    }

    await this.route(params);
    this.runTodo();
    return this.getState();
  }

  /** Answers a question asked during the red-flag step (no NO_QA_STEPS guard). */
  private answerRedFlagQuestion(text: string): void {
    if (isDiagnosisQuestion(text)) {
      this.say(copy.KB_NO_DIAGNOSIS);
      return;
    }
    const hit = searchKnowledge(text, this.scenario.symptom);
    if (!hit) {
      this.say(copy.KB_NO_ANSWER);
      return;
    }
    const footer = hit.entry.topic === "care" ? "" : ` ${copy.KB_FOOTER}`;
    this.say(`${hit.entry.answer}${footer}`, undefined, {
      sourceLabel: hit.source.label,
      sourceUrl: hit.source.url,
    });
    if (hit.entry.id === "cough_prevent") this.sticker("09-mask.png");
  }

  /** Steps where a typed reply is an answer to Jaga, not a question for Jaga. */
  private static readonly NO_QA_STEPS: Pending[] = ["mode", "symptom", "onset", "redflag", "checkin_followup", "confirm_item"];

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
      case "checkin_followup":
        return this.onCheckinFollowup(params);
      case "emergency_checkin":
        return this.onEmergencyCheckin(params);
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

    // Questions at the symptom step: answer from the KB, then ask the symptom
    // question again. Unless the message also clearly describes the person's
    // own cough ("I have a cough, what can I take?"): then start the cough flow
    // and answer the question after the warning-sign questions.
    if (text && (isQuestion(text) || isDiagnosisQuestion(text))) {
      const ownCough = isOwnCoughReport(text);
      if (!ownCough) {
        // Just a question about cough, not the person's own cough.
        // Answer it, then ask the symptom question again.
        if (isDiagnosisQuestion(text)) {
          this.say(copy.KB_NO_DIAGNOSIS);
        } else {
          const hit = searchKnowledge(text, this.scenario.symptom);
          if (hit) {
            const footer = hit.entry.topic === "care" ? "" : ` ${copy.KB_FOOTER}`;
            this.say(`${hit.entry.answer}${footer}`, undefined, {
              sourceLabel: hit.source.label,
              sourceUrl: hit.source.url,
            });
            if (hit.entry.id === "cough_prevent") this.sticker("09-mask.png");
          } else {
            this.say(copy.KB_NO_ANSWER);
          }
        }
        this.pending = "symptom";
        this.say(copy.ASK_SYMPTOM);
        return;
      }
      // Own cough report with a question: fall through to start the cough flow.
      // The question will be answered after the warning-sign questions.
      this.pendingQuestionText = text;
    }

    // Prompt 06: only track a cough. For anything else, say so plainly.
    if (!isCoughMention(text)) {
      this.say(copy.NOT_COVERED_YET);
      this.pending = "symptom";
      return;
    }

    const onsetMatch = extractOnset(text, this.clock.now());
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
      if (this.lastResult?.redFlagKey) {
        this.pending = null;
        return this.escalateRedFlag(this.lastResult);
      }
      this.startRedFlagQuestions();
    } else {
      // Onset unknown, but a warning sign may still have been reported in the
      // first message. Escalate immediately even before the onset is known.
      if (this.lastResult?.redFlagKey) {
        // The warning sign comes first. The start date can wait.
        this.pending = null;
        return this.escalateRedFlag(this.lastResult);
      }
      this.pendingOnsetRawText = text;
      this.pending = "onset";
      this.say(copy.ASK_ONSET, copy.ONSET_BUTTONS);
    }
  }

  private onOnset(params: ProcessMessageParams): void {
    if (!this.episode) return;
    const button = params.button ?? "";
    const text = params.text ?? "";

    // Questions at the onset step are answered normally and the onset
    // question is asked again.
    if (text && (isQuestion(text) || isDiagnosisQuestion(text))) {
      this.answerRedFlagQuestion(text);
      this.say(copy.ASK_ONSET, copy.ONSET_BUTTONS);
      return;
    }

    const match = extractOnset(text, this.clock.now());

    let latestPossible: string;
    let rawText: string;
    let onsetUnknown = false;
    if (copy.ONSET_BUTTON_MIN_DAYS[button] !== undefined) {
      latestPossible = this.isoDaysAgo(copy.ONSET_BUTTON_MIN_DAYS[button]);
      rawText = button;
    } else if (match) {
      latestPossible = match.latestPossible;
      rawText = match.rawText;
    } else {
      // Still unreadable. Re-ask once with the buttons.
      if (!this.onsetReasked) {
        this.onsetReasked = true;
        if (text) this.pendingOnsetRawText = text;
        this.pending = "onset";
        this.say("Sorry, I couldn't read that. " + copy.ASK_ONSET, copy.ONSET_BUTTONS);
        return;
      }
      // Still unreadable after re-ask: record onset unknown, never claim
      // "at least 0 days". Use the person's own words.
      latestPossible = this.clock.now();
      rawText = text || this.pendingOnsetRawText || "not sure";
      onsetUnknown = true;
    }

    this.episode = {
      ...this.episode,
      onset: { rawText, latestPossible, confidence: onsetUnknown ? "unknown" : "approximate" },
    };
    this.store.updateEpisode(this.episode);

    if (onsetUnknown) {
      this.say(copy.ONSET_UNKNOWN_ACK(rawText));
    } else {
      this.say(copy.SYMPTOM_ACKNOWLEDGED(rawText, minDurationDays(this.episode, this.clock)));
    }

    if (this.lastResult?.redFlagKey) return this.escalateRedFlag(this.lastResult);
    this.startRedFlagQuestions();
  }

  // ------------------------------------------------------------------ red flags

  private startRedFlagQuestions(): void {
    // Only the emergency signs are asked one by one at the start. The "see a GP soon"
    // signs (fever, weight loss, night sweats, coloured phlegm, wheezing) are picked up
    // from what the person types, so an older user is not hit with seven questions.
    this.redFlagQueue = this.policy.redFlags.filter((rf) => rf.action === "EMERGENCY_995").map((rf) => rf.key);
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
    const text = (params.text ?? "").trim();
    const button = params.button ?? "";
    const said = `${button} ${text}`.toLowerCase().trim();

    // A question or a diagnosis question is never an answer. Answer it the
    // normal way, then ask the same warning-sign question again.
    if (text && (isQuestion(text) || isDiagnosisQuestion(text))) {
      this.answerRedFlagQuestion(text);
      this.say(copy.RED_FLAG_QUESTIONS[key] ?? `Any of this: ${key}?`, copy.YES_NO);
      return;
    }

    // Yes only if the reply starts with or is: yes, yeah, yup, ya, yah, y, got,
    // have (as the first word), or it is a free-text warning-sign report.
    const YES_FIRST = /^(yes|yeah|yup|ya|yah|y|got|have)\b/i;
    const NO_WORDS =
      /^(no|nope|nah|n|none|never|no\s+lah|don'?t\s+have|dont\s+have|no\s+got|nothing)\b/i;
    // Also check if the extractor picks up a red-flag report from free text.
    const extracted = this.extractor.extract({ text, button });
    const freeTextReport = extracted.some(
      (e) => e.kind === "redflag_answer" && e.redFlags?.[key] === "reported"
    );

    let answer: "reported" | "denied" | "unknown";
    if (freeTextReport || YES_FIRST.test(said)) {
      answer = "reported";
    } else if (NO_WORDS.test(said)) {
      answer = "denied";
    } else {
      answer = "unknown";
    }

    // An unclear answer to a warning-sign question is never waved through: ask
    // once more with Yes / No. If still unclear, record "unknown" (never
    // "denied") and move on.
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
      // Bug 7c: only escalate when the most urgent reported sign is the one
      // just answered. If the most urgent sign was reported earlier, do not
      // repeat its emergency message.
      if (result.redFlagKey === key && answer === "reported") {
        this.pending = null;
        this.escalateRedFlag(result);
      }
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
      // Bug 7c: only show the message if the most urgent reported sign is one
      // that was newly reported. If the newly reported sign is less urgent than
      // one already reported, the advice already stands; answer normally.
      if (newlyReported.includes(result.redFlagKey)) {
        this.pending = null;
        this.escalateRedFlag(result);
        return true;
      }
      // The newly reported sign is less urgent than an already-reported one.
      // The earlier advice stands. Do not repeat it; answer the message normally.
      this.say(copy.RED_FLAG_REMINDER);
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
    // Bug 4: hold routine check-ins after an emergency message until the person replies.
    if (result.action === "EMERGENCY_995") {
      this.emergencyPending = true;
      this.needEmergencyCheckin = true;
    }
    // Plain, direct instruction. No persona, no softening.
    this.say(copy.redFlagMessage(result.action, key));

    // Urgent signs are a threshold the user agreed to at setup. Tell them exactly what was sent.
    if (this.canShare() && !this.redFlagsNotified.has(key)) {
      this.redFlagsNotified.add(key);
      // When the support person reports a warning sign, the share text must
      // say "<support name> told Jaga", not "<person> told Jaga".
      const isSupportReport = result.reportedBy === "support_person";
      const reporterName = isSupportReport
        ? this.scenario.supportPersonName!
        : this.person.displayName;
      const text = copy.SUPPORT_URGENT_TEXT(reporterName, result.action);
      this.sentToSupport.push({ day: this.currentDay, text, urgent: true });
      this.system(copy.SENT_TO_SUPPORT(this.scenario.supportPersonName!, text, true));
    }
  }

  // ------------------------------------------------------------------ monitoring

  private startMonitoring(): void {
    if (this.monitoringStartDay !== null) return;
    this.monitoringStartDay = this.currentDay;
    this.lastCheckinDayHandled = this.currentDay;
    // Bug 4: do NOT send "Thanks. I've started counting..." or a sticker in the
    // same turn as an emergency message. Hold until the person replies.
    if (this.emergencyPending) return;
    this.say(copy.CLOCK_STARTED(this.policy.checkinEveryDays));
    this.sticker("03-counting.png");
    // Answer a question that was asked alongside the first cough report,
    // now that the warning-sign questions are done.
    if (this.pendingQuestionText) {
      const q = this.pendingQuestionText;
      this.pendingQuestionText = null;
      this.todo.push(() => this.answerRedFlagQuestion(q));
    }
    // Bug 7b: if a rule already fires when the clock starts (for example
    // "cough 3 weeks already" meets three_weeks_any), show the GP nudge,
    // the reason with its source and the clinic card right after the
    // warning-sign questions. Do not wait for the next check-in.
    this.todo.push(() => this.checkIntakeNudge());
  }

  /** Bug 7b: show the GP nudge at intake if a policy rule already fires. */
  private checkIntakeNudge(): void {
    if (!this.episode || this.navOffered || this.redFlagActive) return;
    const result = this.lastResult;
    if (!result || result.redFlagKey || result.action !== "SEE_GP") return;
    this.offerNavigation(null, result);
  }

  /** Bug 4: the first check-in after an emergency asks "Did you get checked?" first. */
  private askCheckin(day: number): void {
    this.outstandingCheckinDay = day;
    if (this.needEmergencyCheckin) {
      this.pending = "emergency_checkin";
      this.say(copy.DID_YOU_GET_CHECKED, copy.DID_YOU_GET_CHECKED_BUTTONS);
    } else {
      this.say(copy.checkinMessage(), copy.CHECKIN_BUTTONS);
      this.sticker("02-still-got.png");
    }
  }

  private async onNewDay(day: number): Promise<void> {
    if (!this.episode || this.monitoringStartDay === null) return;

    // 1. Check-ins. Ask once per check-in day. Silence is recorded only when the
    //    NEXT check-in day arrives and the previous question was never answered.
    //    Bug 4: hold all check-ins while the user has not replied after an emergency.
    //    Bug 5: if a warning-sign question is still unanswered when the next
    //    check-in comes, ask it again first, before "Still coughing?".
    const every = this.policy.checkinEveryDays;
    // While an appointment is booked and not yet followed up, skip the routine
    // "Still coughing?" check-in. Ask "Did you manage to see the doctor?" only,
    // the day after the appointment (handled below).
    const hasActiveBooking = (this.booking && !this.careSought) || (this.plan && !this.careSought);
    if ((day - this.monitoringStartDay) % every === 0 && day > this.lastCheckinDayHandled && !hasActiveBooking) {
      if (this.emergencyPending) {
        // Skip this check-in entirely; the user has not replied yet.
        this.lastCheckinDayHandled = day;
        this.outstandingCheckinDay = null;
      } else if (this.pending === "checkin_followup") {
        // Bug 5: the warning-sign follow-up is still unanswered. Re-ask it first.
        this.lastCheckinDayHandled = day;
        this.outstandingCheckinDay = null;
        this.unansweredFollowupCount += 1;
        // Bug 5: after 2 unanswered check-ins in Supported mode, draft a message
        // to the trusted person (shown to the user first, like other shares).
        if (this.unansweredFollowupCount >= 2 && this.canShare()) {
          this.todo.push(() => this.previewShare("help"));
        }
        this.pending = "checkin_followup";
        this.say(copy.CHECKIN_FOLLOWUP, copy.YES_NO);
      } else if (this.outstandingCheckinDay !== null) {
        await this.record(
          { kind: "silence", trajectory: "unknown", rawText: "(no reply to check-in)" },
          "user"
        );
        this.system(copy.SILENCE_RECORDED);
        this.lastCheckinDayHandled = day;
        this.outstandingCheckinDay = null;
        if (this.pending === null || this.pending === "checkin") {
          this.pending = "checkin";
          this.askCheckin(day);
        }
      } else {
        this.lastCheckinDayHandled = day;
        this.outstandingCheckinDay = null;
        if (this.pending === null || this.pending === "checkin") {
          this.pending = "checkin";
          this.askCheckin(day);
        }
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

    // After "Still got" at a check-in, ask the warning-sign question once.
    if (checkin && checkin.trajectory === "same" && this.checkinFollowupAskedDay !== this.currentDay) {
      this.pending = "checkin_followup";
      this.checkinFollowupAskedDay = this.currentDay;
      this.pendingCheckinResult = result;
      this.say(copy.CHECKIN_FOLLOWUP, copy.YES_NO);
      return;
    }

    if (result) this.afterResult(result, checkin ?? null);
  }

  private pendingCheckinResult: PolicyResult | null = null;

  private async onCheckinFollowup(params: ProcessMessageParams): Promise<void> {
    const said = `${params.button ?? ""} ${params.text ?? ""}`.toLowerCase();
    const pos = /\b(yes|yeah|yup|got|have)\b/.test(said);
    const neg = /\b(no|nope|none|not|never|don't|dont)\b/.test(said);

    const result = this.pendingCheckinResult;
    this.pendingCheckinResult = null;
    this.pending = null;
    // Bug 5: the user answered the follow-up, so reset the unanswered counter.
    this.unansweredFollowupCount = 0;

    if (pos && !neg) {
      // Yes: ask the warning-sign questions (blood, breathless, etc).
      this.startRedFlagQuestions();
    } else {
      // No: continue as today. Show the policy result (ack, SEE_GP, etc).
      if (result && !this.lastResult?.redFlagKey) this.afterResult(result, { kind: "checkin", trajectory: "same" });
    }
  }

  /** Bug 4: the first check-in after an emergency asks "Did you get checked?" */
  private async onEmergencyCheckin(params: ProcessMessageParams): Promise<void> {
    const said = `${params.button ?? ""} ${params.text ?? ""}`.toLowerCase();
    const pos = /\b(yes|yeah|yup|got|have)\b/.test(said);
    const neg = /\b(no|nope|none|not|never|don't|dont)\b/.test(said);
    this.needEmergencyCheckin = false;
    this.emergencyPending = false;
    this.pending = null;
    if (pos && !neg) {
      // They got checked. Ask what the doctor said.
      this.pending = "doctor_said";
      this.say(copy.ASK_DOCTOR_SAID);
    } else {
      // Not yet: resume normal monitoring.
      this.pending = "checkin";
      this.say(copy.checkinMessage(), copy.CHECKIN_BUTTONS);
      this.sticker("02-still-got.png");
    }
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

    // If the user types a trajectory (e.g. "worse") during the plan phase,
    // process it as a check-in instead of a plan choice. "Not now" for the
    // clinic card must still let Jaga speak if the cough gets worse.
    if (params.text && !params.button) {
      const extracted = this.extractor.extract({ text: params.text });
      const checkin = extracted.find((e) => e.kind === "checkin" && e.trajectory);
      const redFlag = extracted.find((e) => e.kind === "redflag_answer");
      if (checkin || redFlag) {
        this.pending = null;
        return this.onGeneral(params);
      }
    }

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
    if (this.pending !== null && this.pending !== "nav" && this.pending !== "checkin" && this.pending !== "checkin_followup" && this.pending !== "emergency_checkin") {
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

  /** Bug 7: detect Chinese characters (main trigger for non-English reply). */
  private isNonEnglish(text: string): boolean {
    return /[\u4e00-\u9fff]/.test(text);
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
