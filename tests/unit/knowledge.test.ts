// tests/unit/knowledge.test.ts
// Knowledge base: every answer comes from a stored, sourced entry. No match means
// "I don't know", and Jaga never names an illness. Red flags still win.

import { describe, it, expect } from "vitest";
import { createSession, getSession } from "../../src/conversation/flow.js";
import type { DemoState } from "../../src/conversation/types.js";
import * as copy from "../../src/copy/en.js";
import {
  loadKnowledgeBase,
  searchKnowledge,
  isQuestion,
  isDiagnosisQuestion,
} from "../../src/knowledge/kb.js";

describe("knowledge base file", () => {
  const kb = loadKnowledgeBase();

  it("every entry cites a known source with an https link", () => {
    for (const e of kb.entries) {
      const s = kb.sources[e.source];
      expect(s, e.id).toBeDefined();
      expect(s.url.startsWith("https://")).toBe(true);
      expect(s.checkedByJaga).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("is marked as waiting for clinician review", () => {
    expect(kb.status).toBe("PENDING_CLINICIAN_REVIEW");
  });

  it("ids are unique and copy has no em or en dashes", () => {
    expect(new Set(kb.entries.map((e) => e.id)).size).toBe(kb.entries.length);
    for (const e of kb.entries) expect(e.answer).not.toMatch(/[–—]/);
  });

  it("cough rule in the knowledge base matches the cough policy (2 weeks, 8 weeks)", () => {
    const e = kb.entries.find((x) => x.id === "cough_when_doctor")!;
    expect(e.answer).toContain("2 weeks");
    expect(e.answer).toContain("8 weeks");
  });
});

describe("searchKnowledge", () => {
  const cases: Array<[string, "cough" | "mouth_ulcer", string]> = [
    ["When should I see a doctor?", "cough", "cough_when_doctor"],
    ["can I take cough syrup?", "cough", "cough_medicine"],
    ["what can I do at home?", "cough", "cough_self_care"],
    ["should I call 995?", "cough", "when_995"],
    ["where should I go?", "cough", "where_mild"],
    ["when should I go to A&E?", "cough", "when_ed"],
    ["who can I call for advice?", "cough", "nursefirst"],
    ["can my blood pressure medicine cause this?", "cough", "cough_bp_medicine"],
    ["how do I prevent this?", "cough", "cough_prevent"],
    ["what about the yellow phlegm?", "cough", "cough_warning_signs"],
    ["my ulcer, how long until I see a doctor?", "cough", "ulcer_when_doctor"],
    ["is it serious?", "mouth_ulcer", "ulcer_usual"],
  ];
  for (const [q, topic, id] of cases) {
    it(`"${q}" -> ${id}`, () => {
      expect(searchKnowledge(q, topic)?.entry.id).toBe(id);
    });
  }

  it("does not answer off-topic questions", () => {
    expect(searchKnowledge("what is the weather tomorrow?", "cough")).toBeNull();
  });

  it("never gives a mouth ulcer answer while tracking a cough unless asked", () => {
    expect(searchKnowledge("is it serious?", "cough")?.entry.topic).not.toBe("mouth_ulcer");
  });
});

describe("question detection", () => {
  it("spots questions", () => {
    expect(isQuestion("can I take panadol")).toBe(true);
    expect(isQuestion("still coughing")).toBe(false);
  });
  it("spots requests for a diagnosis", () => {
    expect(isDiagnosisQuestion("do I have cancer?")).toBe(true);
    expect(isDiagnosisQuestion("what's wrong with me")).toBe(true);
    expect(isDiagnosisQuestion("is it serious?")).toBe(false);
  });
});

describe("questions in the chat", () => {
  let n = 0;
  const lastJaga = (s: DemoState) => s.transcript.filter((t) => t.role === "jaga").at(-1)!;

  async function started() {
    const sid = `kb-${++n}`;
    createSession(sid, "ms_lim");
    const s = getSession(sid)!;
    await s.handleMessage({ button: "On my own" });
    await s.handleMessage({ text: "cough since before CNY" });
    await s.handleMessage({ button: "No" });
    await s.handleMessage({ button: "No" });
    return s;
  }

  it("answers with the source link", async () => {
    const s = await started();
    const st = await s.handleMessage({ text: "when should I see a doctor?" });
    const m = lastJaga(st);
    expect(m.text).toContain("2 weeks");
    expect(m.text).toContain(copy.KB_FOOTER);
    expect(m.sourceUrl).toContain("healthhub.sg");
  });

  it("says it does not know instead of guessing", async () => {
    const s = await started();
    const st = await s.handleMessage({ text: "what is the weather tomorrow?" });
    expect(lastJaga(st).text).toBe(copy.KB_NO_ANSWER);
  });

  it("refuses to name an illness", async () => {
    const s = await started();
    const st = await s.handleMessage({ text: "do I have cancer?" });
    expect(lastJaga(st).text).toBe(copy.KB_NO_DIAGNOSIS);
  });

  it("red flags still win over a question", async () => {
    const s = await started();
    const st = await s.handleMessage({ text: "is it bad that I am coughing blood?" });
    expect(lastJaga(st).text).not.toBe(copy.KB_NO_ANSWER);
    expect(st.clockPanel.redFlags.some((f) => f.key === "blood" && f.status === "reported")).toBe(true);
  });

  it("does not hijack the onset step", async () => {
    const sid = `kb-${++n}`;
    createSession(sid, "ms_lim");
    const s = getSession(sid)!;
    await s.handleMessage({ button: "On my own" });
    const st = await s.handleMessage({ text: "cough" });
    if (st.phase === "onset") {
      const st2 = await s.handleMessage({ text: "since last week?" });
      expect(lastJaga(st2).text).not.toBe(copy.KB_NO_ANSWER);
    }
  });
});
