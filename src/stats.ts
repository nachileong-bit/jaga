// src/stats.ts
// Private play counter for the web demo: who tried it, how far they got.
// Kept in memory (it starts again after a redeploy). Our own test robots are skipped.

import { createHash } from "node:crypto";
import { RealClock } from "./core/clock.js";

const clock = new RealClock();

export interface Visit {
  visitor: string; // hashed IP + browser, never the raw IP
  device: "phone" | "desktop";
  firstSeen: string; // ISO time
  lastSeen: string;
  sessions: Set<string>;
  messages: number;
  checkins: number;
  said: string[]; // first few things typed or tapped
}

const BOT_UA = /HeadlessChrome|Playwright|python|curl|bot|spider|crawl/i;
const visits = new Map<string, Visit>();
const startedAt = clock.now();

export function isRobot(ua: string): boolean {
  return !ua || BOT_UA.test(ua);
}

/** Returns true the first time this visitor does something in the demo. */
export function track(
  ip: string,
  ua: string,
  sessionId: string,
  kind: "message" | "advance",
  said?: string
): { firstTime: boolean } | null {
  if (isRobot(ua)) return null;
  const visitor = createHash("sha256").update(`${ip}|${ua}`).digest("hex").slice(0, 10);
  const now = clock.now();
  let v = visits.get(visitor);
  const firstTime = !v;
  if (!v) {
    v = {
      visitor,
      device: /Mobi|Android|iPhone/i.test(ua) ? "phone" : "desktop",
      firstSeen: now,
      lastSeen: now,
      sessions: new Set(),
      messages: 0,
      checkins: 0,
      said: [],
    };
    visits.set(visitor, v);
  }
  v.lastSeen = now;
  v.sessions.add(sessionId);
  if (kind === "message") v.messages += 1;
  else v.checkins += 1;
  if (said && v.said.length < 12) v.said.push(said.slice(0, 80));
  return { firstTime };
}

export function summary() {
  const list = [...visits.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const today = clock.now().slice(0, 10);
  return {
    since: startedAt,
    people: list.length,
    peopleToday: list.filter((v) => v.lastSeen.startsWith(today)).length,
    phones: list.filter((v) => v.device === "phone").length,
    messages: list.reduce((n, v) => n + v.messages, 0),
    list,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sgTime = (iso: string) =>
  new Date(iso).toLocaleString("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function statsPage(): string {
  const s = summary();
  const rows = s.list
    .map(
      (v) => `<tr><td>${sgTime(v.firstSeen)}</td><td>${sgTime(v.lastSeen)}</td><td>${v.device}</td><td>${v.sessions.size}</td><td>${v.messages}</td><td>${v.checkins}</td><td>${v.said.map(esc).join(" · ")}</td></tr>`
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jaga plays</title>
<style>body{font-family:system-ui;margin:16px;background:#fff;color:#111}.k{display:flex;gap:12px;flex-wrap:wrap}.k div{background:#f3f6f4;border-radius:10px;padding:12px 16px}.k b{display:block;font-size:28px}
table{border-collapse:collapse;width:100%;font-size:14px;margin-top:16px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}.w{overflow-x:auto}small{color:#666}</style></head><body>
<h1>Who tried Jaga</h1><small>Counting since ${sgTime(s.since)} (restarts when the demo is updated). Test robots are not counted.</small>
<div class="k"><div><b>${s.people}</b>people</div><div><b>${s.peopleToday}</b>today</div><div><b>${s.phones}</b>on a phone</div><div><b>${s.messages}</b>messages</div></div>
<div class="w"><table><tr><th>First</th><th>Last</th><th>Device</th><th>Chats</th><th>Messages</th><th>Clock moves</th><th>What they typed or tapped</th></tr>${rows || '<tr><td colspan="7">Nobody yet.</td></tr>'}</table></div>
</body></html>`;
}
