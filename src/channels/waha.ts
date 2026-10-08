// src/channels/waha.ts
// WhatsApp channel through a WAHA server (https://waha.devlike.pro).
// Same DemoSession engine as the web demo. This file only moves text in and out.
//
// Safety for a shared WhatsApp number:
// - Jaga replies ONLY to chats listed in JAGA_ALLOWED_CHATS. Everyone else is ignored silently.
// - Group chats and the bot's own messages are always ignored.
// - Time on WhatsApp is simulated for the hackathon: "/day 14" moves the clock, and every
//   such reply is labelled as simulated.

import { createSession, getSession, deleteSession, type DemoSession } from "../conversation/flow.js";
import type { DemoState, TranscriptEntry } from "../conversation/types.js";

export interface Sender {
  sendText(chatId: string, text: string): Promise<void>;
  sendImage(chatId: string, url: string): Promise<void>;
}

export interface WahaConfig {
  url: string;
  apiKey: string;
  session: string;
}

/** Real sender. Uses global fetch (Node 20+). */
export class WahaSender implements Sender {
  constructor(private cfg: WahaConfig) {}

  async sendText(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.cfg.url.replace(/\/$/, "")}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.cfg.apiKey },
      body: JSON.stringify({ session: this.cfg.session, chatId, text }),
    });
    if (!res.ok) throw new Error(`WAHA sendText failed: ${res.status}`);
  }

  async sendImage(chatId: string, url: string): Promise<void> {
    const res = await fetch(`${this.cfg.url.replace(/\/$/, "")}/api/sendImage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.cfg.apiKey },
      body: JSON.stringify({
        session: this.cfg.session,
        chatId,
        file: { url, mimetype: "image/png" },
      }),
    });
    if (!res.ok) throw new Error(`WAHA sendImage failed: ${res.status}`);
  }
}

export interface BridgeOptions {
  allowedChats: string[]; // e.g. ["6591234567@c.us"]
  supportChat?: string; // optional second phone that plays the trusted person
  publicBaseUrl?: string; // for the GP summary link
}

interface ChatState {
  sessionId: string;
  sentCount: number; // transcript entries already delivered
  lastButtons: string[];
  forwardedToSupport: number;
}

export const HELP_TEXT =
  "Jaga demo commands:\n/reset (Mr Tan, with a trusted person)\n/reset lim (Ms Lim, on her own)\n/day 14 (move the simulated clock to day 14)";

export class WhatsAppBridge {
  private chats = new Map<string, ChatState>();
  private primaryChat: string | null = null; // the user chat the support phone is linked to

  constructor(private sender: Sender, private opts: BridgeOptions) {}

  /** Handle one incoming WhatsApp message. Returns false when it was ignored. */
  async handleIncoming(msg: { chatId: string; text: string; fromMe?: boolean }): Promise<boolean> {
    const chatId = msg.chatId;
    const text = (msg.text ?? "").trim();
    if (msg.fromMe || !text) return false;
    if (chatId.endsWith("@g.us")) return false; // never in groups

    // The trusted person's phone speaks into the linked user's session.
    if (this.opts.supportChat && chatId === this.opts.supportChat) {
      if (!this.primaryChat) return false;
      const state = this.chats.get(this.primaryChat)!;
      const session = getSession(state.sessionId)!;
      const after = await session.handleMessage({ text, reporter: "support_person" });
      await this.deliver(this.primaryChat, state, session, after);
      return true;
    }

    if (!this.opts.allowedChats.includes(chatId)) return false; // not on the list: stay silent

    // Commands
    const lower = text.toLowerCase();
    if (lower === "/help") {
      await this.sender.sendText(chatId, HELP_TEXT);
      return true;
    }
    if (lower.startsWith("/reset")) {
      const old = this.chats.get(chatId);
      if (old) deleteSession(old.sessionId);
      this.chats.delete(chatId);
      await this.ensureChat(chatId, lower.includes("lim") ? "ms_lim" : "mr_tan");
      return true;
    }

    const state = await this.ensureChat(chatId, "mr_tan", true);
    const session = getSession(state.sessionId)!;

    const dayMatch = lower.match(/^\/day\s+(\d{1,3})$/);
    if (dayMatch) {
      const toDay = Number(dayMatch[1]);
      const after = await session.handleAdvance({ toDay });
      await this.sender.sendText(chatId, `(Demo) Simulated clock is now day ${after.day}. Time is compressed for the demo.`);
      await this.deliver(chatId, state, session, after);
      return true;
    }

    // "2" -> the second option Jaga offered last
    const n = Number(text);
    const button =
      Number.isInteger(n) && n >= 1 && n <= state.lastButtons.length ? state.lastButtons[n - 1] : undefined;

    const after = await session.handleMessage(button ? { button } : { text });
    await this.deliver(chatId, state, session, after);
    return true;
  }

  private async ensureChat(
    chatId: string,
    scenario: "mr_tan" | "ms_lim",
    quietIfExists = false
  ): Promise<ChatState> {
    const existing = this.chats.get(chatId);
    if (existing && quietIfExists) return existing;

    const sessionId = `wa:${chatId}:${this.chats.size}:${scenario}`;
    const session = createSession(sessionId, scenario);
    const state: ChatState = { sessionId, sentCount: 0, lastButtons: [], forwardedToSupport: 0 };
    this.chats.set(chatId, state);
    this.primaryChat = chatId;
    await this.deliver(chatId, state, session, session.getState());
    return state;
  }

  /** Send everything Jaga said since last time. The user's own lines are never echoed back. */
  private async deliver(chatId: string, state: ChatState, session: DemoSession, demo: DemoState): Promise<void> {
    const fresh = demo.transcript.slice(state.sentCount);
    state.sentCount = demo.transcript.length;

    for (const entry of fresh) {
      if (entry.role !== "jaga" && entry.role !== "system") continue;
      if (entry.sticker) {
        if (this.opts.publicBaseUrl) {
          await this.sender.sendImage(
            chatId,
            `${this.opts.publicBaseUrl.replace(/\/$/, "")}/web/stickers/${entry.sticker}`
          );
        }
        continue;
      }
      await this.sender.sendText(chatId, renderForWhatsApp(entry, state.sessionId, this.opts.publicBaseUrl));
      if (entry.buttons?.length) state.lastButtons = entry.buttons;
    }

    // Anything the user approved for their trusted person really goes to the second phone.
    if (this.opts.supportChat) {
      const sent = session.getSentToSupport();
      for (const item of sent.slice(state.forwardedToSupport)) {
        await this.sender.sendText(this.opts.supportChat, `Jaga: ${item.text}`);
      }
      state.forwardedToSupport = sent.length;
    }
  }
}

/** Plain-text rendering: clinic card lines, a numbered menu instead of buttons, absolute link. */
export function renderForWhatsApp(entry: TranscriptEntry, sessionId: string, publicBaseUrl?: string): string {
  const lines: string[] = [entry.text];

  if (entry.sourceLabel && entry.sourceUrl) lines.push(`Source: ${entry.sourceLabel} ${entry.sourceUrl}`);

  if (entry.card) {
    const c = entry.card;
    lines.push("", `[${c.label}]`, `*${c.clinic}*`, c.distance, `Next appointment: ${c.slot}`, c.consult, c.outOfPocket);
  }

  if (entry.link) {
    const base = (publicBaseUrl ?? "").replace(/\/$/, "");
    lines.push(
      base
        ? `${entry.link.label}: ${base}/web/${entry.link.href}?sessionId=${encodeURIComponent(sessionId)}`
        : `${entry.link.label}: available on the web demo`
    );
  }

  if (entry.buttons?.length) {
    lines.push("", ...entry.buttons.map((b, i) => `${i + 1}. ${b}`), `Reply with a number (1 to ${entry.buttons.length}), or just type.`);
  }
  return lines.join("\n");
}

/** Pull chat id and text out of a WAHA "message" webhook body. */
export function parseWahaWebhook(body: unknown): { chatId: string; text: string; fromMe: boolean } | null {
  const b = body as { event?: string; payload?: { from?: string; body?: string; fromMe?: boolean } };
  if (!b || b.event !== "message" || !b.payload?.from) return null;
  return { chatId: b.payload.from, text: b.payload.body ?? "", fromMe: !!b.payload.fromMe };
}
