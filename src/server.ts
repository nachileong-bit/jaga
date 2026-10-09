// src/server.ts
// Fastify server for the Jaga web demo.
// Serves /web as static files and a small JSON API.
// Each browser session gets its own in-memory SQLite store and SimulatedClock.

import Fastify from "fastify";
import { fastifyStatic } from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createSession,
  getSession,
  deleteSession,
} from "./conversation/flow.js";
import { WahaSender, WhatsAppBridge, parseWahaWebhook } from "./channels/waha.js";
import type { DemoState } from "./conversation/types.js";
import { loadKnowledgeBase } from "./knowledge/kb.js";
import { loadAllPolicies } from "./core/policyLoader.js";
import { track, summary, statsPage } from "./stats.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
// 0.0.0.0 so a container host (Railway) can reach it; still opens fine on localhost.
const HOST = process.env.HOST ?? "0.0.0.0";

async function main() {
  const app = Fastify({ logger: true });

  // Serve static files from web/
  await app.register(fastifyStatic, {
    root: WEB_DIR,
    prefix: "/web/",
  });

  // ---- Play counter: a private page and a WhatsApp ping when someone new tries the demo ----
  const statsKey = process.env.STATS_KEY;
  const notifyChat = process.env.STATS_NOTIFY_CHAT; // e.g. 6591234567@c.us
  const pingSender =
    process.env.WAHA_URL && process.env.WAHA_API_KEY
      ? new WahaSender({ url: process.env.WAHA_URL, apiKey: process.env.WAHA_API_KEY, session: process.env.WAHA_SESSION ?? "default" })
      : null;
  let lastPing = 0;
  function noteVisit(request: { headers: Record<string, unknown>; ip: string }, sessionId: string, kind: "message" | "advance", said?: string) {
    const fwd = String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    const ua = String(request.headers["user-agent"] ?? "");
    const r = track(fwd || request.ip, ua, sessionId, kind, said);
    // At most one ping every 20 minutes, so a busy judging day is not a flood.
    if (r?.firstTime && pingSender && notifyChat && Date.now() - lastPing > 20 * 60 * 1000) {
      lastPing = Date.now();
      const s = summary();
      const link = statsKey && process.env.PUBLIC_BASE_URL ? `\nSee who: ${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/stats?key=${statsKey}` : "";
      pingSender
        .sendText(notifyChat, `👀 Someone new is trying the Jaga demo (${s.list[0]?.device ?? "web"}). ${s.peopleToday} today, ${s.people} so far.${link}`)
        .catch((e) => app.log.warn(e, "stats ping failed"));
    }
  }

  app.get("/stats", async (request, reply) => {
    if (!statsKey || (request.query as { key?: string }).key !== statsKey) return reply.code(404).send({ error: "not found" });
    reply.type("text/html").send(statsPage());
  });

  // ---- Session management ----

  function getOrCreateSession(sessionId: string | undefined, scenario: "mr_tan" | "ms_lim") {
    let sid = sessionId;
    if (!sid || !getSession(sid)) {
      sid = randomUUID();
      createSession(sid, scenario);
    }
    return sid;
  }

  // ---- API routes ----

  // The demo lives under /web/. Send the bare address there.
  app.get("/", async (_request, reply) => reply.redirect("/web/"));

  // GET /api/knowledge: the knowledge base and the decision rules, read-only.
  app.get("/api/knowledge", async () => ({
    knowledge: loadKnowledgeBase(),
    policies: [...loadAllPolicies().values()],
  }));

  // POST /api/demo/reset
  app.post("/api/demo/reset", async (request, reply) => {
    const body = request.body as { scenario?: "mr_tan" | "ms_lim"; sessionId?: string };
    const scenario = body.scenario ?? "mr_tan";
    const sessionId = randomUUID();

    // Delete old session if exists
    if (body.sessionId) {
      deleteSession(body.sessionId);
    }

    createSession(sessionId, scenario);
    const session = getSession(sessionId)!;
    const state: DemoState = session.getState();

    return { sessionId, state };
  });

  // POST /api/demo/message
  app.post("/api/demo/message", async (request, reply) => {
    const body = request.body as {
      sessionId: string;
      text?: string;
      button?: string;
      reporter?: "user" | "support_person";
    };

    if (!body.sessionId) {
      return reply.code(400).send({ error: "sessionId required" });
    }

    const session = getSession(body.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }

    noteVisit(request, body.sessionId, "message", body.button ?? body.text);
    const state = await session.handleMessage({
      text: body.text,
      button: body.button,
      reporter: body.reporter ?? "user",
    });

    return { state };
  });

  // POST /api/demo/advance
  app.post("/api/demo/advance", async (request, reply) => {
    const body = request.body as {
      sessionId: string;
      toDay: number;
    };

    if (!body.sessionId) {
      return reply.code(400).send({ error: "sessionId required" });
    }

    const session = getSession(body.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }

    noteVisit(request, body.sessionId, "advance");
    const state = await session.handleAdvance({ toDay: body.toDay });

    return { state };
  });

  // GET /api/demo/state
  app.get("/api/demo/state", async (request, reply) => {
    const sessionId = (request.query as { sessionId?: string }).sessionId;
    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId required" });
    }

    const session = getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }

    const state = session.getState();
    return { state };
  });

  // ---- WhatsApp (WAHA). Only active when the env vars are set. ----
  const wahaUrl = process.env.WAHA_URL;
  const wahaKey = process.env.WAHA_API_KEY;
  const allowed = (process.env.JAGA_ALLOWED_CHATS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const bridge =
    wahaUrl && wahaKey && allowed.length > 0
      ? new WhatsAppBridge(
          new WahaSender({ url: wahaUrl, apiKey: wahaKey, session: process.env.WAHA_SESSION ?? "default" }),
          {
            allowedChats: allowed,
            supportChat: process.env.JAGA_SUPPORT_CHAT || undefined,
            publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
          }
        )
      : null;

  app.post("/webhooks/waha", async (request, reply) => {
    const secret = (request.query as { secret?: string }).secret;
    if (!bridge || !process.env.WAHA_WEBHOOK_SECRET || secret !== process.env.WAHA_WEBHOOK_SECRET) {
      return reply.code(404).send({ error: "not found" });
    }
    const msg = parseWahaWebhook(request.body);
    if (msg) {
      // Answer WAHA straight away, then talk to the user.
      void bridge.handleIncoming(msg).catch((err) => app.log.error(err));
    }
    return { ok: true };
  });

  // GET /api/demo/summary  -> structured GP summary (rendered by web/summary.html)
  app.get("/api/demo/summary", async (request, reply) => {
    const sessionId = (request.query as { sessionId?: string }).sessionId;
    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId required" });
    }
    const session = getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }
    const summary = session.getSummary();
    if (!summary) {
      return reply.code(404).send({ error: "nothing recorded yet" });
    }
    return { summary };
  });

  // ---- Start ----

  try {
    await app.listen({ port: PORT, host: HOST });
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Jaga web demo running at: ${url}/web/\n`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
