/**
 * Test helpers for driving the TestBundleAgentDO via its debug HTTP surface.
 *
 * The bundle-dispatch integration tests bypass WebSocket and use a dedicated
 * `/test-turn` endpoint to run a prompt synchronously. Assertions read the
 * session store via `/entries`, the cached pointer via `/bundle/cache`, etc.
 */

import { env } from "cloudflare:test";
import type { ClientMessage, ServerMessage } from "../../src/transport/types.js";

// Narrow the env shape we rely on so we don't have to cast repeatedly.
interface TestEnv {
  TEST_BUNDLE_AGENT: DurableObjectNamespace;
}

export function getBundleStub(name: string): DurableObjectStub {
  const ns = (env as unknown as TestEnv).TEST_BUNDLE_AGENT;
  const id = ns.idFromName(name);
  return ns.get(id);
}

/**
 * Return both the stub and the DO id hash as a string — the runtime's
 * `runtimeContext.agentId` is `ctx.id.toString()`, NOT the name. Tests that
 * call `registry.setActive(...)` MUST use this hash so the runtime's
 * registry lookup finds the pointer.
 */
export function getBundleStubAndId(name: string): {
  stub: DurableObjectStub;
  agentId: string;
} {
  const ns = (env as unknown as TestEnv).TEST_BUNDLE_AGENT;
  const id = ns.idFromName(name);
  const stub = ns.get(id);
  return { stub, agentId: id.toString() };
}

/** Extract assistant text from an entry's content array (pi-agent-core shape). */
export function assistantText(entry: { data: Record<string, unknown> }): string {
  const content = entry.data.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => (b as { type?: string }).type === "text") as
      | { text?: string }
      | undefined;
    return block?.text ?? "";
  }
  return "";
}

/**
 * Drive a single turn via the `/test-turn` endpoint. Returns the session id
 * used (created implicitly on first call if not passed).
 */
export async function runTurn(
  stub: DurableObjectStub,
  prompt: string,
  sessionId?: string,
): Promise<string> {
  const res = await stub.fetch("http://fake/test-turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, sessionId }),
  });
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

export async function getEntries(
  stub: DurableObjectStub,
  sessionId?: string,
): Promise<
  Array<{ id: string; type: string; data: Record<string, unknown>; customType?: string }>
> {
  const url = sessionId ? `http://fake/entries?sessionId=${sessionId}` : "http://fake/entries";
  const res = await stub.fetch(url);
  const body = (await res.json()) as {
    entries: Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
      customType?: string;
    }>;
  };
  return body.entries;
}

export async function getCachedBundlePointer(stub: DurableObjectStub): Promise<string | null> {
  const res = await stub.fetch("http://fake/bundle/cache");
  const body = (await res.json()) as { cached: string | null };
  return body.cached;
}

export async function writeCachedBundlePointer(
  stub: DurableObjectStub,
  versionId: string | null,
): Promise<void> {
  await stub.fetch("http://fake/bundle/cache-write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionId }),
  });
}

export async function postBundleRefresh(
  stub: DurableObjectStub,
): Promise<{ status: string; activeVersionId: string | null }> {
  const res = await stub.fetch("http://fake/bundle/refresh", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
  });
  return (await res.json()) as { status: string; activeVersionId: string | null };
}

export async function postBundleDisable(
  stub: DurableObjectStub,
  opts: { authorized: boolean } = { authorized: true },
): Promise<Response> {
  return stub.fetch("http://fake/bundle/disable", {
    method: "POST",
    headers: opts.authorized ? { authorization: "Bearer test-token" } : {},
  });
}

/** Drain fire-and-forget async ops. */
export async function waitIdle(stub: DurableObjectStub): Promise<void> {
  await stub.fetch("http://fake/wait-idle", { method: "POST" });
}

/**
 * Open a WebSocket to capture broadcasts. Tests that assert on broadcast
 * events use this — the /test-turn endpoint triggers broadcasts via spine,
 * which need a receiver.
 */
export interface BundleTestSocket {
  ws: WebSocket;
  messages: ServerMessage[];
  sessionId: string;
  send: (msg: ClientMessage) => void;
  waitForMessage: (
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerMessage>;
  close: () => void;
}

export async function openBundleSocket(stub: DurableObjectStub): Promise<BundleTestSocket> {
  const resp = await stub.fetch("http://fake/ws", {
    headers: {
      upgrade: "websocket",
      authorization: "Bearer test-token",
    },
  });
  const ws = resp.webSocket as WebSocket | null;
  if (!ws) {
    throw new Error(`WebSocket upgrade failed: status ${resp.status}`);
  }
  ws.accept();
  const messages: ServerMessage[] = [];
  const waiters: Array<{
    predicate: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
  }> = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse((event as MessageEvent).data as string) as ServerMessage;
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
              `Timed out waiting for message (${timeoutMs}ms). Received types: ${messages.map((m) => m.type).join(", ")}`,
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

  const sync = await waitForMessage((m) => m.type === "session_sync");
  const sessionId = (sync as { sessionId: string }).sessionId;

  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

  return { ws, messages, sessionId, send, waitForMessage, close: () => ws.close() };
}
