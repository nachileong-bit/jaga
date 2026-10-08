// tests/unit/stickers.test.ts
// Mascot stickers and emojis: sticker timing, safety constraints, and WhatsApp delivery.

import { describe, it, expect } from "vitest";
import { createSession, getSession } from "../../src/conversation/flow.js";
import type { DemoState, TranscriptEntry } from "../../src/conversation/types.js";
import * as copy from "../../src/copy/en.js";
import { WhatsAppBridge, type Sender } from "../../src/channels/waha.js";

let counter = 0;
function fresh(scenario: "mr_tan" | "ms_lim") {
  const sid = `stickers-${++counter}`;
  createSession(sid, scenario);
  return sid;
}
const tap = (sid: string, button: string, reporter?: "user" | "support_person") =>
  getSession(sid)!.handleMessage({ button, reporter });
const say = (sid: string, text: string, reporter?: "user" | "support_person") =>
  getSession(sid)!.handleMessage({ text, reporter });
const go = (sid: string, toDay: number) => getSession(sid)!.handleAdvance({ toDay });

const jaga = (s: DemoState) => s.transcript.filter((t) => t.role === "jaga");
const stickers = (s: DemoState) => s.transcript.filter((t) => t.sticker).map((t) => t.sticker!);

/** Setup up to the point where monitoring has started (day 0). */
async function start(scenario: "mr_tan" | "ms_lim", symptomText = "cough a bit since before CNY, just a cough lah") {
  const sid = fresh(scenario);
  await tap(sid, scenario === "mr_tan" ? "Add a trusted person" : "On my own");
  await say(sid, symptomText);
  await tap(sid, "No");
  const state = await tap(sid, "No");
  return { sid, state };
}

/** Same answers for both people: took medicine day 7, still got on days 7 and 14. */
async function runToSeeGp(scenario: "mr_tan" | "ms_lim") {
  const { sid } = await start(scenario);
  await go(sid, 7);
  await tap(sid, "Still got");
  await tap(sid, "Took medicine");
  await tap(sid, "Correct");
  await go(sid, 14);
  const state = await tap(sid, "Still got");
  return { sid, state };
}

/** True when `sub` appears as a subsequence of `arr` (same relative order, not necessarily contiguous). */
function isSubsequence(arr: string[], sub: string[]): boolean {
  let i = 0;
  for (const val of arr) {
    if (i < sub.length && val === sub[i]) i++;
  }
  return i === sub.length;
}

describe("sticker ordering in the Mr Tan journey", () => {
  it("includes stickers 01, 03, 02, 04, 05 and 06 in that order", async () => {
    const { sid, state } = await runToSeeGp("mr_tan");
    const st = await tap(sid, "Book appointment");

    const all = stickers(st);
    expect(isSubsequence(all, ["01-hello.png", "03-counting.png", "02-still-got.png", "04-day-14.png", "05-see-gp.png", "06-booked.png"])).toBe(true);
  });
});

describe("safety: stickers never follow red-flag, abstention, or diagnosis-refusal messages", () => {
  it("no sticker entry follows a red-flag message", async () => {
    const { sid } = await start("mr_tan");
    await go(sid, 9);
    const state = await tap(sid, "Noticed blood");

    const entries = state.transcript;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].sticker) {
        // The entry before a sticker must not be a red-flag message.
        const prev = entries[i - 1];
        expect(prev, "sticker with no preceding entry").toBeDefined();
        expect(prev.text).not.toContain("Call 995");
        expect(prev.text).not.toContain("should be checked by a doctor today");
      }
    }
  });

  it("no sticker entry follows the KB_NO_ANSWER message", async () => {
    const { sid } = await start("ms_lim");
    const state = await say(sid, "what is the weather tomorrow?");

    const entries = state.transcript;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].sticker) {
        const prev = entries[i - 1];
        expect(prev).toBeDefined();
        expect(prev.text).not.toBe(copy.KB_NO_ANSWER);
      }
    }
  });

  it("no sticker entry follows the KB_NO_DIAGNOSIS message", async () => {
    const { sid } = await start("ms_lim");
    const state = await say(sid, "do I have cancer?");

    const entries = state.transcript;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].sticker) {
        const prev = entries[i - 1];
        expect(prev).toBeDefined();
        expect(prev.text).not.toBe(copy.KB_NO_DIAGNOSIS);
      }
    }
  });
});

describe("safety: no emoji in red-flag, abstention or diagnosis-refusal copy", () => {
  // Simple emoji detection: any character in the emoji Unicode ranges.
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;

  it("red-flag copy has no emoji", () => {
    const rfBlood = copy.redFlagMessage("SEE_DOCTOR_TODAY", "blood");
    const rf995 = copy.redFlagMessage("EMERGENCY_995", "breathless_or_chest_pain");
    const rfGeneric = copy.redFlagMessage("SEE_DOCTOR_TODAY", "some_other_key");
    expect(EMOJI.test(rfBlood)).toBe(false);
    expect(EMOJI.test(rf995)).toBe(false);
    expect(EMOJI.test(rfGeneric)).toBe(false);
  });

  it("KB_NO_ANSWER has no emoji", () => {
    expect(EMOJI.test(copy.KB_NO_ANSWER)).toBe(false);
  });

  it("KB_NO_DIAGNOSIS has no emoji", () => {
    expect(EMOJI.test(copy.KB_NO_DIAGNOSIS)).toBe(false);
  });
});

// ---- WhatsApp bridge ----

class FakeSender implements Sender {
  sent: { chatId: string; text?: string; image?: string }[] = [];
  async sendText(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  async sendImage(chatId: string, url: string) {
    this.sent.push({ chatId, image: url });
  }
}

const ME = "6590000001@c.us";

describe("WhatsApp bridge sends stickers as images", () => {
  it("sends a sticker as an image when publicBaseUrl is set", async () => {
    const sender = new FakeSender();
    const bridge = new WhatsAppBridge(sender, {
      allowedChats: [ME],
      publicBaseUrl: "https://jaga.example",
    });
    await bridge.handleIncoming({ chatId: ME, text: "/reset" });

    const images = sender.sent.filter((m) => m.chatId === ME && m.image !== undefined);
    expect(images.length).toBeGreaterThan(0);
    expect(images[0].image).toContain("https://jaga.example/web/stickers/01-hello.png");
  });

  it("skips stickers when publicBaseUrl is not set", async () => {
    const sender = new FakeSender();
    const bridge = new WhatsAppBridge(sender, {
      allowedChats: [ME],
    });
    await bridge.handleIncoming({ chatId: ME, text: "/reset" });

    const images = sender.sent.filter((m) => m.chatId === ME && m.image !== undefined);
    expect(images).toHaveLength(0);
    // Text messages still work.
    const texts = sender.sent.filter((m) => m.chatId === ME && m.text !== undefined);
    expect(texts.length).toBeGreaterThan(0);
  });
});
