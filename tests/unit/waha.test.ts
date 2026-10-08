// tests/unit/waha.test.ts
// WhatsApp bridge tests with a fake sender. No network.

import { describe, it, expect } from "vitest";
import { WhatsAppBridge, parseWahaWebhook, type Sender } from "../../src/channels/waha.js";

class FakeSender implements Sender {
  sent: { chatId: string; text?: string; image?: string }[] = [];
  async sendText(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  async sendImage(chatId: string, url: string) {
    this.sent.push({ chatId, image: url });
  }
  to(chatId: string) {
    return this.sent.filter((m) => m.chatId === chatId && m.text !== undefined).map((m) => m.text!);
  }
  images(chatId: string) {
    return this.sent.filter((m) => m.chatId === chatId && m.image !== undefined).map((m) => m.image!);
  }
  last(chatId: string) {
    const all = this.to(chatId);
    return all[all.length - 1];
  }
}

const ME = "6590000001@c.us";
const MEILING = "6590000002@c.us";
const STRANGER = "6599999999@c.us";

function setup(supportChat?: string) {
  const sender = new FakeSender();
  const bridge = new WhatsAppBridge(sender, {
    allowedChats: [ME],
    supportChat,
    publicBaseUrl: "https://jaga.example",
  });
  return { sender, bridge };
}

describe("WhatsApp bridge safety", () => {
  it("stays silent for anyone not on the allow list, for groups, and for its own messages", async () => {
    const { sender, bridge } = setup();
    expect(await bridge.handleIncoming({ chatId: STRANGER, text: "hello" })).toBe(false);
    expect(await bridge.handleIncoming({ chatId: "12345@g.us", text: "hello" })).toBe(false);
    expect(await bridge.handleIncoming({ chatId: ME, text: "hello", fromMe: true })).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  it("parses a WAHA message webhook and ignores other events", () => {
    expect(parseWahaWebhook({ event: "message", payload: { from: ME, body: "hi", fromMe: false } })).toEqual({
      chatId: ME,
      text: "hi",
      fromMe: false,
    });
    expect(parseWahaWebhook({ event: "message.ack", payload: { from: ME } })).toBeNull();
    expect(parseWahaWebhook(null)).toBeNull();
  });
});

describe("WhatsApp conversation", () => {
  it("greets with a numbered menu and accepts a number as the answer", async () => {
    const { sender, bridge } = setup();
    await bridge.handleIncoming({ chatId: ME, text: "hi" });
    const menu = sender.to(ME).find((t) => t.includes("1. On my own"))!;
    expect(menu).toContain("2. Add a trusted person");
    expect(menu).toContain("Reply with a number");
  });

  it("runs the full journey on WhatsApp with /day, numbers, a labelled card and an absolute summary link", async () => {
    const { sender, bridge } = setup(MEILING);
    const send = (text: string) => bridge.handleIncoming({ chatId: ME, text });

    await send("/reset");
    await send("2"); // Add a trusted person
    await send("cough a bit since before CNY, just a cough lah");
    expect(sender.to(ME).some((t) => t.includes('Noted: "since before CNY". That is at least 4 days.'))).toBe(true);
    await send("2"); // No blood
    await send("2"); // No breathlessness
    await send("2"); // No high fever
    await send("2"); // No weight loss
    await send("2"); // No night sweats
    await send("2"); // No coloured phlegm
    await send("2"); // No wheezing
    await send("/day 7");
    expect(sender.to(ME).some((t) => t.includes("(Demo) Simulated clock is now day 7"))).toBe(true);
    await send("1"); // Still got
    await send("2"); // No to the check-in follow-up (warning-sign question)
    await send("took medicine");
    await send("1"); // Correct
    await send("/day 14");
    await send("still got");
    await send("2"); // No to the check-in follow-up

    const card = sender.last(ME);
    expect(card).toContain("[PROTOTYPE DATA · SIMULATED]");
    expect(card).toContain("$XX");
    expect(card).toContain("5. Ask Mei Ling to help");

    await send("1"); // Book appointment
    expect(sender.to(ME).some((t) => t.includes("https://jaga.example/web/summary.html?sessionId="))).toBe(true);

    // Nothing reaches Mei Ling's phone until the user says Send.
    expect(sender.to(MEILING)).toHaveLength(0);
    await send("1"); // Send
    expect(sender.to(MEILING)).toHaveLength(1);
    expect(sender.to(MEILING)[0]).toContain("cough has lasted at least");
  });

  it("the trusted person's phone can add an observation, and a disagreement only triggers a question", async () => {
    const { sender, bridge } = setup(MEILING);
    const send = (text: string) => bridge.handleIncoming({ chatId: ME, text });
    await send("/reset");
    await send("2");
    await send("cough since before CNY");
    await send("2");
    await send("2");
    await send("2");
    await send("2");
    await send("2");
    await send("2");
    await send("2");
    await send("/day 7");
    await send("2"); // Better
    await bridge.handleIncoming({ chatId: MEILING, text: "he is still coughing every night" });
    expect(sender.last(ME)).toContain("One quick check");
  });

  it("the user's own words are never echoed back to them", async () => {
    const { sender, bridge } = setup();
    await bridge.handleIncoming({ chatId: ME, text: "/reset lim" });
    await bridge.handleIncoming({ chatId: ME, text: "1" });
    await bridge.handleIncoming({ chatId: ME, text: "my secret cough since before CNY" });
    expect(sender.to(ME).some((t) => t.startsWith("my secret cough"))).toBe(false);
  });
});
