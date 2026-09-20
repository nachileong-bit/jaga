// tests/unit/scriptedExtractor.test.ts
// Tests for the ScriptedExtractor that stands in for the LLM until M3.

import { describe, it, expect } from "vitest";
import { ScriptedExtractor } from "../../src/llm/ScriptedExtractor.js";

const extractor = new ScriptedExtractor();

describe("ScriptedExtractor", () => {
  it('maps "still got" → same', () => {
    const result = extractor.extract({ text: "still got it" });
    expect(result.some((r) => r.trajectory === "same")).toBe(true);
  });

  it('maps "better" → better', () => {
    const result = extractor.extract({ text: "getting better" });
    expect(result.some((r) => r.trajectory === "better")).toBe(true);
  });

  it('maps "worse" → worse', () => {
    const result = extractor.extract({ text: "it's getting worse" });
    expect(result.some((r) => r.trajectory === "worse")).toBe(true);
  });

  it('maps "comes and goes" → intermittent', () => {
    const result = extractor.extract({ text: "it comes and goes" });
    expect(result.some((r) => r.trajectory === "intermittent")).toBe(true);
  });

  it('maps "gone" → gone', () => {
    const result = extractor.extract({ text: "it's all gone" });
    expect(result.some((r) => r.trajectory === "gone")).toBe(true);
  });

  it('maps "took medicine" → self_treatment with item.confirmed=false', () => {
    const result = extractor.extract({ text: "took medicine" });
    const st = result.find((r) => r.kind === "self_treatment");
    expect(st).toBeDefined();
    expect(st!.item).toBeDefined();
    expect(st!.item!.confirmed).toBe(false);
  });

  it('maps "Noticed blood" button → red flag blood reported', () => {
    const result = extractor.extract({ button: "Noticed blood" });
    const rf = result.find((r) => r.kind === "redflag_answer");
    expect(rf).toBeDefined();
    expect(rf!.redFlags!.blood).toBe("reported");
  });

  it('maps "noticed blood" text → red flag blood reported', () => {
    const result = extractor.extract({ text: "I noticed blood in my phlegm" });
    const rf = result.find((r) => r.kind === "redflag_answer");
    expect(rf).toBeDefined();
    expect(rf!.redFlags!.blood).toBe("reported");
  });

  it('maps "no lah" → deny blood', () => {
    const result = extractor.extract({ text: "no lah" });
    const rf = result.find((r) => r.kind === "redflag_answer");
    expect(rf).toBeDefined();
    expect(rf!.redFlags!.blood).toBe("denied");
  });

  it("maps button [Still got] → same trajectory", () => {
    const result = extractor.extract({ button: "Still got" });
    expect(result.some((r) => r.trajectory === "same")).toBe(true);
  });

  it("maps button [Better] → better trajectory", () => {
    const result = extractor.extract({ button: "Better" });
    expect(result.some((r) => r.trajectory === "better")).toBe(true);
  });

  it("maps button [Gone] → gone trajectory", () => {
    const result = extractor.extract({ button: "Gone" });
    expect(result.some((r) => r.trajectory === "gone")).toBe(true);
  });

  it("maps button [Took medicine] → self_treatment", () => {
    const result = extractor.extract({ button: "Took medicine" });
    const st = result.find((r) => r.kind === "self_treatment");
    expect(st).toBeDefined();
    expect(st!.item!.confirmed).toBe(false);
  });

  it("treats unknown text as a mention", () => {
    const result = extractor.extract({ text: "hello there" });
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe("mention");
  });

  it("returns empty-mention for no input", () => {
    const result = extractor.extract({});
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe("mention");
  });
});
