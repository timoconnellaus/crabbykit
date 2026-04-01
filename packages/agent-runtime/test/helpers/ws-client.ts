/**
 * Shared WebSocket test helpers for AgentDO integration tests.
 *
 * Eliminates duplication of openSocket, prompt, getEntries, steer, abort,
 * and other HTTP helpers across test files.
 */

import { env } from "cloudflare:test";
import type { ClientMessage, ServerMessage } from "../../src/transport/types.js";

/** Return type for openSocket — a connected WS client with message tracking. */
export interface TestSocket {
  ws: WebSocket;
  messages: ServerMessage[];
  waitForMessage: (
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerMessage>;
  send: (msg: ClientMessage) => void;
  close: () => void;
}

type SessionSyncMsg = Extract<ServerMessage, { type: "session_sync" }>;

/** Open a socket, wait for initial sync, and return the client + session ID. */
export async function connectAndGetSession(stub: DurableObjectStub) {
  const client = await openSocket(stub);
  const sync = await client.waitForMessage((m) => m.type === "session_sync");
  const sessionId = (sync as SessionSyncMsg).sessionId;
  return { client, sessionId };
}

/** Get a DurableObjectStub by name. */
export function getStub(name = "test-agent") {
  const id = env.AGENT.idFromName(name);
  return env.AGENT.get(id);
}

/**
 * Open a WebSocket to the DO and collect messages.
 * Returns a TestSocket with message tracking and waitForMessage support.
 */
export async function openSocket(stub: DurableObjectStub): Promise<TestSocket> {
  const resp = await stub.fetch("http://fake/ws", {
    headers: { upgrade: "websocket" },
  });
  const ws = resp.webSocket!;
  ws.accept();

  const messages: ServerMessage[] = [];
  const waiters: Array<{
    predicate: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
  }> = [];

  ws.addEventListener("message", (event) => {
    const msg: ServerMessage = JSON.parse(event.data as string);
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  const waitForMessage = (
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for message (${timeoutMs}ms). Received: ${messages.map((m) => m.type).join(", ")}`,
            ),
          ),
        timeoutMs,
      );
      waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  };

  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
  const close = () => ws.close();

  return { ws, messages, waitForMessage, send, close };
}

/** Filter messages by type. */
export function findMessages(messages: ServerMessage[], type: string): ServerMessage[] {
  return messages.filter((m) => m.type === type);
}

/** Send a prompt via HTTP (blocks until inference completes). */
export async function prompt(stub: DurableObjectStub, text: string, sessionId?: string) {
  const body: Record<string, string> = { text };
  if (sessionId) body.sessionId = sessionId;
  const res = await stub.fetch("http://fake/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ messages: unknown[] }>;
}

/** Get session entries via HTTP. */
export async function getEntries(stub: DurableObjectStub, sessionId?: string) {
  const url = sessionId ? `http://fake/entries?sessionId=${sessionId}` : "http://fake/entries";
  const res = await stub.fetch(url);
  return res.json() as Promise<{ entries: Array<{ type: string; data: Record<string, unknown> }> }>;
}

/** Inject a steering message while the agent is running. */
export async function steer(stub: DurableObjectStub, sessionId: string, text: string) {
  const res = await stub.fetch("http://fake/steer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  return res.json() as Promise<{ steered: boolean }>;
}

/** Abort the current agent execution. */
export async function abort(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/abort", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return res.json() as Promise<{ aborted: boolean }>;
}

/** Register mock MCP tools on the DO. */
export async function registerMockMcp(
  stub: DurableObjectStub,
  tools: Array<{ name: string; description: string }>,
) {
  const res = await stub.fetch("http://fake/register-mock-mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tools }),
  });
  return res.json() as Promise<{ registered: number }>;
}

/** Get the history of steered messages. */
export async function getSteerHistory(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/steer-history");
  return res.json() as Promise<{ steeredMessages: unknown[] }>;
}

/** Wait for the DO to finish all pending async operations. */
export async function waitIdle(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/wait-idle", { method: "POST" });
  return res.json() as Promise<{ ok: boolean }>;
}

/**
 * Simulate DO hibernation by clearing all in-memory state.
 * WebSocket connections survive (backed by serializeAttachment) but the
 * transport's connection map, sessionAgents, rate limits, capability hooks,
 * schedule callbacks, and resolved capabilities cache are wiped —
 * exactly what happens when a real DO is evicted and wakes on a message.
 */
export async function simulateHibernation(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/simulate-hibernation", { method: "POST" });
  return res.json() as Promise<{ ok: boolean }>;
}

/** List all schedules (including capability-owned). */
export async function getSchedules(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/schedules");
  return res.json() as Promise<{ schedules: Array<Record<string, unknown>> }>;
}

/** Trigger the DO alarm handler (simulates a cron alarm firing). */
export async function triggerAlarm(stub: DurableObjectStub) {
  const res = await stub.fetch("http://fake/trigger-alarm", { method: "POST" });
  return res.json() as Promise<{ ok: boolean }>;
}
