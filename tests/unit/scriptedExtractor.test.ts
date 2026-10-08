// tests/unit/scriptedExtractor.test.ts
// Tests for the ScriptedExtractor that stands in for the LLM until M3.

import { describe, it, expect } from "vitest";
import { ScriptedExtractor, extractOnset } from "../../src/llm/ScriptedExtractor.js";

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

  it('"no lah" does NOT deny blood (no blood keyword present)', () => {
    const result = extractor.extract({ text: "no lah" });
    const rf = result.find((r) => r.kind === "redflag_answer");
    // "no lah" has no blood keyword, so no redflag_answer should be produced
    expect(rf).toBeUndefined();
  });

  it('maps "no blood" → deny blood', () => {
    const result = extractor.extract({ text: "no blood lah" });
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

describe("warning signs in free text", () => {
  const x = new ScriptedExtractor();
  const flags = (t: string) =>
    Object.assign({}, ...x.extract({ text: t }).filter((e) => e.kind === "redflag_answer").map((e) => e.redFlags));
  it.each([
    "this morning I coughed some blood",
    "got blood in my phlegm",
    "blood when I cough",
    "pink frothy phlegm",
    "batuk darah", // Malay
  ])("reports blood: %s", (t) => expect(flags(t).blood).toBe("reported"));
  it.each(["no blood", "didn't see any blood"])("denies blood: %s", (t) =>
    expect(flags(t).blood).toBe("denied")
  );
  it.each(["I donated blood today", "my blood pressure is high", "blood test next week"])(
    "ignores unrelated blood: %s",
    (t) => expect(flags(t).blood).toBeUndefined()
  );
  it.each(["feeling breathless", "chest pain since last night", "can't breathe properly"])(
    "reports breathless or chest pain: %s",
    (t) => expect(flags(t).breathless_or_chest_pain).toBe("reported")
  );
  it.each(["no chest pain", "not short of breath"])("does not report a denial: %s", (t) =>
    expect(flags(t).breathless_or_chest_pain).toBeUndefined()
  );

  // "not breathless but chest pain" must still report breathless_or_chest_pain
  it('reports breathless_or_chest_pain for "not breathless but chest pain"', () => {
    expect(flags("not breathless but chest pain").breathless_or_chest_pain).toBe("reported");
  });

  // New "see a GP soon" warning signs
  it.each(["I have a high fever", "fever 39 degrees", "temperature above 38.6"])(
    "reports high_fever: %s",
    (t) => expect(flags(t).high_fever).toBe("reported")
  );
  it("does not report high_fever for fever 38.0", () => {
    expect(flags("fever 38.0").high_fever).toBeUndefined();
  });
  it.each(["I've been losing weight", "lost some weight recently"])(
    "reports weight_loss: %s",
    (t) => expect(flags(t).weight_loss).toBe("reported")
  );
  it.each(["sweating at night", "night sweats"])(
    "reports night_sweats: %s",
    (t) => expect(flags(t).night_sweats).toBe("reported")
  );
  it.each(["yellow phlegm", "thick green phlegm"])(
    "reports coloured_phlegm: %s",
    (t) => expect(flags(t).coloured_phlegm).toBe("reported")
  );
  it.each(["I'm wheezing", "wheezy chest"])(
    "reports wheezing: %s",
    (t) => expect(flags(t).wheezing).toBe("reported")
  );
});

describe("onset parsing", () => {
  it("parses 'since last week'", () => {
    const m = extractOnset("since last week");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("since last week");
  });

  it("parses 'a week ago'", () => {
    const m = extractOnset("started about a week ago");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("about a week ago");
  });

  it("parses '2 weeks'", () => {
    const m = extractOnset("cough for 2 weeks");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("2 weeks");
  });

  it("parses '3 weeks'", () => {
    const m = extractOnset("3 weeks already");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("3 weeks");
  });

  it("parses 'three weeks'", () => {
    const m = extractOnset("cough for three weeks");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("three weeks");
  });

  it("parses '1 month'", () => {
    const m = extractOnset("cough for 1 month");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("1 month");
  });

  it("parses 'since last month'", () => {
    const m = extractOnset("cough since last month");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("since last month");
  });

  it("parses 'a few days'", () => {
    const m = extractOnset("cough for a few days");
    expect(m).not.toBeNull();
    expect(m!.rawText).toBe("a few days");
  });

  it("parses 'before CNY'", () => {
    const m = extractOnset("cough since before CNY");
    expect(m).not.toBeNull();
    expect(m!.rawText.toLowerCase()).toBe("since before cny");
  });

  it("returns null for no onset phrase", () => {
    expect(extractOnset("hello there")).toBeNull();
  });
});

describe("Singlish filler is not a denial", () => {
  const x = new ScriptedExtractor();
  const flags = (t: string) =>
    Object.assign({}, ...x.extract({ text: t }).filter((e) => e.kind === "redflag_answer").map((e) => e.redFlags));
  it.each(["no lah, got blood in phlegm", "no lah got blood when cough"])("reports blood: %s", (t) =>
    expect(flags(t).blood).toBe("reported")
  );
  it.each(["no got blood", "never see blood"])("denies blood: %s", (t) => expect(flags(t).blood).toBe("denied"));
});
