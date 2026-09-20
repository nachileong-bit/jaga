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
import type { DemoState } from "./conversation/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "localhost";

async function main() {
  const app = Fastify({ logger: true });

  // Serve static files from web/
  await app.register(fastifyStatic, {
    root: WEB_DIR,
    prefix: "/web/",
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
