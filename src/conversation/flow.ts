// src/conversation/flow.ts
// The conversation flow: orchestrates scripted extractor, engine, and
// produces the transcript. src/core stays pure — this layer has state.

import { randomUUID } from "node:crypto";

import type {
  Clock,
  Episode,
  Mode,
  Observation,
  Person,
  Policy,
  PolicyResult,
  Reporter,
  Symptom,
  Trajectory,
} from "../core/types.js";
import type { Store } from "../core/repository.js";
import { SimulatedClock } from "../core/clock.js";
import { createStore } from "../core/repository.js";
import { createEpisode, processObservation, makeUuid } from "../core/engine.js";
import { loadPolicy } from "../core/policyLoader.js";
import { evaluatePolicy } from "../core/policyEvaluator.js";
import {
  getReportedRedFlags,
  getLatestRedFlagAnswers,
} from "../core/redFlagScreen.js";
import {
  minDurationDays,
  applyObservation,
  computeMissedCheckins,
} from "../core/episodeStateMachine.js";
import { ScriptedExtractor } from "../llm/ScriptedExtractor.js";
import type { ExtractorInput } from "../llm/Extractor.js";
import * as copy from "../copy/en.js";
import type {
  ClockPanelState,
  ConversationPhase,
  DemoState,
  ProcessAdvanceParams,
  ProcessMessageParams,
  TranscriptEntry,
} from "./types.js";

// ---- Scenarios ----

interface Scenario {
  name: string;
  mode: Mode;
  personId: string;
  displayName: string;
  supportPersonId?: string;
  supportPersonName?: string;
  symptom: Symptom;
  onsetRawText: string;
  onsetLatest: string;
  confidence: "exact" | "approximate" | "unknown";
}

const SCENARIOS: Record<string, Scenario> = {
  mr_tan: {
    name: "mr_tan",
    mode: "supported",
    personId: "mr-tan",
    displayName: "Mr Tan",
    supportPersonId: "mei-ling",
    supportPersonName: "Mei Ling",
    symptom: "cough",
    onsetRawText: "started a few days ago",
    onsetLatest: "2026-01-01T08:00:00.000Z",
    confidence: "approximate",
  },
  ms_lim: {
    name: "ms_lim",
    mode: "independent",
    personId: "ms-lim",
    displayName: "Ms Lim",
    symptom: "cough",
    onsetRawText: "started a few days ago",
    onsetLatest: "2026-01-01T08:00:00.000Z",
    confidence: "approximate",
  },
};

// ---- Session ----

export class DemoSession {
  private store: Store;
  private clock: SimulatedClock;
  private scenario: Scenario;
  private episode: Episode | null = null;
  private person: Person;
  private phase: ConversationPhase = "init";
  private transcript: TranscriptEntry[] = [];
  private extractor = new ScriptedExtractor();
  private lastResult: PolicyResult | null = null;
  private policy: Policy;
  private redFlagQuestionsAsked: Set<string> = new Set();
  private redFlagKeysOrder: string[] = [];
  private symptomMentioned = false;
  private clockStarted = false;

  constructor(scenarioKey: "mr_tan" | "ms_lim") {
    this.scenario = SCENARIOS[scenarioKey];
    this.store = createStore(":memory:");
    this.clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    this.policy = loadPolicy(this.scenario.symptom);
    this.clock.advanceToDay(0);

    this.person = {
      id: this.scenario.personId,
      displayName: this.scenario.displayName,
      language: "en",
      mode: this.scenario.mode,
      supportPersonId: this.scenario.supportPersonId,
      consent: {
        shareAtThresholds: this.scenario.mode === "supported",
        emergencyContact: this.scenario.supportPersonName,
      },
    };
    this.store.upsertPerson(this.person);

    // Red flag key order
    this.redFlagKeysOrder = this.policy.redFlags.map((rf) => rf.key);

    // Start the conversation
    this.phase = "mode_select";
    this.addJaga(copy.GREETING, 0);
    this.addJaga(copy.MODE_QUESTION, 0, [
      copy.MODE_BUTTONS.on_my_own,
      copy.MODE_BUTTONS.add_trusted,
    ]);
  }

  // ---- Public API ----

  get currentDay(): number {
    return SimulatedClock.daysBetween(
      this.scenario.onsetLatest,
      this.clock.now()
    );
  }

  getState(): DemoState {
    return {
      day: this.currentDay,
      mode: this.scenario.mode,
      phase: this.phase,
      scenario: this.scenario.name as "mr_tan" | "ms_lim",
      transcript: [...this.transcript],
      clockPanel: this.buildClockPanel(),
      lastResult: this.lastResult,
    };
  }

  async handleMessage(params: ProcessMessageParams): Promise<DemoState> {
    const reporter: Reporter = params.reporter ?? "user";

    // If there's a text or button, add it to the transcript as the user/support
    if (params.text || params.button) {
      this.transcript.push({
        role: reporter === "support_person" ? "support_person" : "user",
        text: params.text ?? params.button ?? "",
        day: this.currentDay,
      });
    }

    await this.processPhase(params);

    return this.getState();
  }

  async handleAdvance(params: ProcessAdvanceParams): Promise<DemoState> {
    const toDay = Math.max(params.toDay, this.currentDay);
    this.clock.advanceToDay(toDay);

    // Check if we've passed a check-in day with no answer
    if (this.clockStarted && this.episode) {
      this.checkForMissedCheckins();
    }

    return this.getState();
  }

  // ---- Phase processing ----

  private async processPhase(params: ProcessMessageParams): Promise<void> {
    switch (this.phase) {
      case "mode_select":
        await this.handleModeSelect(params);
        break;
      case "symptom_mention":
        await this.handleSymptomMention(params);
        break;
      case "redflag_blood":
        await this.handleRedFlagAnswer("blood", params);
        break;
      case "redflag_breathless":
        await this.handleRedFlagAnswer("breathless_or_chest_pain", params);
        break;
      case "monitoring":
      case "checkin":
        await this.handleMonitoringOrCheckin(params);
        break;
      case "escalated":
        // In escalated state, still process messages for tracking
        await this.handleMonitoringOrCheckin(params);
        break;
      default:
        break;
    }
  }

  // ---- Mode selection ----

  private async handleModeSelect(params: ProcessMessageParams): Promise<void> {
    const button = params.button ?? "";
    const text = (params.text ?? "").toLowerCase();

    let chosenMode: Mode;
    if (
      button === copy.MODE_BUTTONS.add_trusted ||
      text.includes("trusted") ||
      text.includes("add") ||
      text.includes("mei ling")
    ) {
      chosenMode = "supported";
    } else {
      chosenMode = "independent";
    }

    // If scenario is mr_tan (supported), always use supported. If ms_lim (independent), always independent.
    // The user choice is just for the flow — scenario determines the actual mode.
    chosenMode = this.scenario.mode;

    if (chosenMode === "independent") {
      this.addJaga(copy.MODE_CONFIRM_INDEPENDENT, this.currentDay);
    } else {
      const name = this.scenario.supportPersonName ?? "your trusted person";
      this.addJaga(copy.MODE_CONFIRM_SUPPORTED(name), this.currentDay);
    }

    // Move to symptom mention
    this.phase = "symptom_mention";
    this.addJaga(copy.ASK_SYMPTOM, this.currentDay);
  }

  // ---- Symptom mention ----

  private async handleSymptomMention(params: ProcessMessageParams): Promise<void> {
    const text = params.text ?? params.button ?? "";

    // Extract using the scripted extractor — for now just get a mention
    const input: ExtractorInput = { text, button: params.button, reporter: params.reporter };
    const extracted = this.extractor.extract(input);

    // Use scenario's symptom and onset
    const onset = {
      rawText: this.scenario.onsetRawText,
      latestPossible: this.scenario.onsetLatest,
      confidence: this.scenario.confidence,
    };

    // Create the episode
    this.episode = await createEpisode(this.person, this.scenario.symptom, onset, this.clock);
    this.store.insertEpisode(this.episode);

    // Process extracted observations
    for (const ext of extracted) {
      const obs = this.buildObservation(ext, params.reporter ?? "user");
      const { result, episode: updated } = await processObservation(
        this.store,
        this.episode,
        obs,
        this.clock
      );
      this.episode = updated;
      this.lastResult = result;
    }

    this.symptomMentioned = true;
    this.addJaga(copy.SYMPTOM_ACKNOWLEDGED(this.scenario.onsetRawText), this.currentDay);

    // Move to first red-flag question
    if (this.redFlagKeysOrder.length > 0) {
      this.phase = "redflag_blood";
      const firstKey = this.redFlagKeysOrder[0];
      if (firstKey === "blood") {
        this.addJaga(copy.ASK_RED_FLAG_BLOOD, this.currentDay, [
          copy.RED_FLAG_BUTTONS.yes,
          copy.RED_FLAG_BUTTONS.no,
        ]);
      } else {
        this.phase = "redflag_breathless";
        this.addJaga(copy.ASK_RED_FLAG_BREATHLESS, this.currentDay, [
          copy.RED_FLAG_BUTTONS.yes,
          copy.RED_FLAG_BUTTONS.no,
        ]);
      }
    } else {
      this.startMonitoring();
    }
  }

  // ---- Red flag answers ----

  private async handleRedFlagAnswer(
    key: string,
    params: ProcessMessageParams
  ): Promise<void> {
    const button = params.button ?? "";
    const text = (params.text ?? "").toLowerCase();
    let answer: "reported" | "denied" | "unknown";

    if (button === "Yes" || text.includes("yes") || text.includes("yeah") || text.includes("got")) {
      answer = "reported";
    } else if (button === "No" || text.includes("no") || text.includes("nope") || text.includes("no lah")) {
      answer = "denied";
    } else {
      answer = "unknown";
    }

    this.redFlagQuestionsAsked.add(key);

    const obs = this.buildObservation(
      {
        kind: "redflag_answer",
        redFlags: { [key]: answer },
        rawText: params.text ?? button,
      },
      params.reporter ?? "user"
    );

    const { result, episode: updated } = await processObservation(
      this.store,
      this.episode!,
      obs,
      this.clock
    );
    this.episode = updated;
    this.lastResult = result;

    // If a red flag was reported, escalate immediately
    if (answer === "reported" && result.action !== "KEEP_WATCHING") {
      this.handleEscalation(result);
      return;
    }

    // Move to next red flag question
    const nextKey = this.redFlagKeysOrder.find(
      (k) => !this.redFlagQuestionsAsked.has(k)
    );

    if (nextKey === undefined) {
      this.startMonitoring();
    } else if (nextKey === "blood") {
      this.phase = "redflag_blood";
      this.addJaga(copy.ASK_RED_FLAG_BLOOD, this.currentDay, [
        copy.RED_FLAG_BUTTONS.yes,
        copy.RED_FLAG_BUTTONS.no,
      ]);
    } else {
      this.phase = "redflag_breathless";
      this.addJaga(copy.ASK_RED_FLAG_BREATHLESS, this.currentDay, [
        copy.RED_FLAG_BUTTONS.yes,
        copy.RED_FLAG_BUTTONS.no,
      ]);
    }
  }

  // ---- Start monitoring ----

  private startMonitoring(): void {
    this.clockStarted = true;
    this.phase = "monitoring";
    this.addJaga(copy.CLOCK_STARTED, this.currentDay);
  }

  // ---- Monitoring / check-in ----

  private async handleMonitoringOrCheckin(
    params: ProcessMessageParams
  ): Promise<void> {
    const input: ExtractorInput = {
      text: params.text,
      button: params.button,
      reporter: params.reporter,
    };
    const extracted = this.extractor.extract(input);

    let latestResult = this.lastResult;

    for (const ext of extracted) {
      // Determine observation kind based on phase
      let obsInput = { ...ext };
      // If in check-in phase and extracted kind is "mention", treat as check-in
      if (
        (this.phase === "checkin" || this.phase === "monitoring") &&
        obsInput.kind === "mention" &&
        obsInput.trajectory
      ) {
        obsInput.kind = "checkin";
      }

      const obs = this.buildObservation(obsInput, params.reporter ?? "user");
      const { result, episode: updated } = await processObservation(
        this.store,
        this.episode!,
        obs,
        this.clock
      );
      this.episode = updated;
      latestResult = result;
      this.lastResult = result;
    }

    // Handle the result
    if (latestResult && latestResult.action !== "KEEP_WATCHING") {
      this.handleEscalation(latestResult);
      return;
    }

    // Check for discordance follow-up
    if (latestResult?.followUps.includes("ASK_CLARIFICATION")) {
      this.addJaga(copy.ASK_CLARIFICATION_MSG, this.currentDay);
    }

    // Acknowledge the check-in
    if (this.phase === "checkin") {
      const traj = this.episode?.trajectory;
      if (traj === "better" || traj === "gone") {
        this.addJaga(
          `Glad to hear it's ${traj === "gone" ? "gone" : "better"}. I'll keep watching. ${copy.ESCAPE_HATCH}`,
          this.currentDay
        );
      } else if (traj === "same" || traj === "worse") {
        this.addJaga(
          `Understood. I'll keep tracking this. ${copy.ESCAPE_HATCH}`,
          this.currentDay
        );
      }
      this.phase = "monitoring";
    } else if (this.phase === "monitoring" && extracted.length > 0) {
      this.addJaga(
        `Got it. ${copy.ESCAPE_HATCH}`,
        this.currentDay
      );
    }
  }

  // ---- Escalation handling ----

  private handleEscalation(result: PolicyResult): void {
    this.phase = "escalated";

    if (result.redFlagKey) {
      // Red flag: direct plain instruction, no persona
      this.addJaga(copy.redFlagMessage(result.action, result.redFlagKey), this.currentDay);

      // In supported mode, also notify support person
      if (this.scenario.mode === "supported" && this.scenario.supportPersonName) {
        this.addJaga(
          copy.SUPPORT_NOTIFIED(this.scenario.supportPersonName),
          this.currentDay
        );
      }
    } else {
      // Policy rule fired
      const msg = copy.actionMessage(
        result.action,
        result.explain,
        result.source?.label,
        result.source?.url
      );
      this.addJaga(msg, this.currentDay, undefined, result.source?.label, result.source?.url, true);
    }
  }

  // ---- Check-in trigger (called on advance) ----

  private checkForMissedCheckins(): void {
    if (!this.episode || !this.clockStarted) return;
    if (this.phase === "escalated") return;

    const observations = this.store.getObservationsForEpisode(this.episode.id);
    const checkinEvery = this.policy.checkinEveryDays;

    // Find the last check-in
    const lastCheckin = [...observations]
      .filter((o) => o.kind === "checkin" || o.kind === "mention")
      .reverse()[0];

    const reference = lastCheckin?.at ?? this.episode.onset.latestPossible;
    const daysSince = SimulatedClock.daysBetween(reference, this.clock.now());

    // If we've passed a check-in day
    if (daysSince >= checkinEvery) {
      const missedCount = Math.floor(daysSince / checkinEvery);
      if (missedCount > 0 && this.phase !== "checkin") {
        // Record a silence observation
        const obsId = this.makeId();
        const fullObs: Observation = {
          ...this.buildObservation(
            {
              kind: "silence",
              trajectory: "unknown",
              rawText: "(no response to check-in)",
            },
            "user"
          ),
          id: obsId,
          episodeId: this.episode.id,
        };
        this.store.insertObservation(fullObs);

        // Recompute episode state
        const allObs = this.store.getObservationsForEpisode(this.episode.id);
        const priorObs = allObs.filter((o) => o.id !== obsId);
        const updated = applyObservation(
          this.episode,
          priorObs,
          fullObs,
          this.clock,
          this.policy.checkinEveryDays,
          this.policy.resolvedAfterSymptomFreeDays
        );
        updated.missedCheckins = computeMissedCheckins(
          updated,
          allObs,
          this.policy.checkinEveryDays,
          this.clock
        );
        this.store.updateEpisode(updated);
        this.episode = updated;

        // Add silence message to transcript
        this.addJaga(copy.SILENCE_RECORDED, this.currentDay);
      }
    }

    // Trigger a check-in message if we're at a check-in day
    const nextCheckinDay = this.getNextCheckinDay();
    if (this.currentDay >= nextCheckinDay && this.phase !== "checkin" && this.phase !== "escalated") {
      this.phase = "checkin";
      this.addJaga(copy.checkinMessage(), this.currentDay, copy.CHECKIN_BUTTONS);
    }
  }

  private getNextCheckinDay(): number {
    if (!this.episode) return Infinity;
    const observations = this.store.getObservationsForEpisode(this.episode.id);
    const lastCheckin = [...observations]
      .filter((o) => o.kind === "checkin" || o.kind === "mention")
      .reverse()[0];
    const reference = lastCheckin?.at ?? this.episode.onset.latestPossible;
    const daysSince = SimulatedClock.daysBetween(reference, this.clock.now());
    const checkinEvery = this.policy.checkinEveryDays;

    if (daysSince < checkinEvery) {
      return this.currentDay + (checkinEvery - daysSince);
    }
    return this.currentDay;
  }

  // ---- Helpers ----

  private buildObservation(
    ext: {
      kind: Observation["kind"];
      trajectory?: Trajectory;
      redFlags?: Record<string, "reported" | "denied" | "unknown">;
      item?: { label: string; confirmed: boolean };
      rawText?: string;
    },
    reporter: Reporter
  ): Omit<Observation, "id" | "episodeId"> {
    return {
      at: this.clock.now(),
      reporter,
      kind: ext.kind,
      trajectory: ext.trajectory,
      redFlags: ext.redFlags,
      item: ext.item,
      rawText: ext.rawText,
    };
  }

  private makeId(): string {
    // Use crypto.randomUUID for deterministic session-safe ids (no Date.now())
    return randomUUID();
  }

  private addJaga(
    text: string,
    day: number,
    buttons?: string[],
    sourceLabel?: string,
    sourceUrl?: string,
    prototypeLabel?: boolean
  ): void {
    this.transcript.push({
      role: "jaga",
      text,
      buttons,
      day,
      sourceLabel,
      sourceUrl,
      prototypeLabel,
    });
  }

  // ---- Clock panel builder ----

  private buildClockPanel(): ClockPanelState {
    const episode = this.episode;
    if (!episode) {
      return {
        mode: this.scenario.mode,
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
      const latestAnswer = latest[rf.key];
      if (report) {
        return {
          key: rf.key,
          status: "reported" as const,
          reportedBy: report.reporter,
          reportedAt: report.at,
        };
      }
      if (latestAnswer === "denied") {
        return { key: rf.key, status: "denied" as const };
      }
      return { key: rf.key, status: "unknown" as const };
    });

    const selfTreatment = observations
      .filter((o) => o.kind === "self_treatment" && o.item)
      .map((o) => ({ label: o.item!.label, confirmed: o.item!.confirmed }));

    // Deduplicate by label, keeping the latest
    const seen = new Map<string, { label: string; confirmed: boolean }>();
    for (const st of selfTreatment) {
      seen.set(st.label, st);
    }

    return {
      mode: this.scenario.mode,
      symptom: episode.symptom,
      onsetRawText: episode.onset.rawText,
      minDurationDays: minDurationDays(episode, this.clock),
      confidence: episode.onset.confidence,
      trajectory: episode.trajectory,
      state: episode.state,
      redFlags,
      selfTreatment: [...seen.values()],
      discordance: episode.discordance,
      missedCheckins: episode.missedCheckins,
      policyId: episode.policyId,
      policyVersion: episode.policyVersion,
      pendingReview: true,
      lastRuleFired: this.lastResult?.ruleId ?? null,
    };
  }
}

// ---- Session manager (per browser session) ----

const sessions = new Map<string, DemoSession>();

export function getSession(sessionId: string): DemoSession | undefined {
  return sessions.get(sessionId);
}

export function createSession(
  sessionId: string,
  scenario: "mr_tan" | "ms_lim"
): DemoSession {
  const session = new DemoSession(scenario);
  sessions.set(sessionId, session);
  return session;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
