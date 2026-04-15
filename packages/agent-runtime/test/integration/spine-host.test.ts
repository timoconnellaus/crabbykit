/**
 * Internal SpineService bridge integration tests.
 *
 * Hits the DO's `/spine/*` HTTP surface directly (bypassing the
 * SpineService token verification) and asserts each op reaches the
 * expected store/transport. This surface is only reachable by the
 * SpineService WorkerEntrypoint in production — in tests we call it
 * directly because we're exercising the host-side dispatcher, not
 * the token verifier.
 *
 * Uses unique DO names per describe block (per project testing rules)
 * since isolatedStorage is disabled.
 */

import { describe, expect, it } from "vitest";
import { clearMockResponses, setMockResponses } from "../../src/test-helpers/test-agent-do.js";
import { connectAndGetSession, getEntries, getStub, openSocket } from "../helpers/ws-client.js";

async function postJson(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return stub.fetch(`http://fake${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("spine bridge — session store ops", () => {
  it("appendEntry persists an entry that subsequent reads observe", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-append-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    const res = await postJson(stub, "/spine/appendEntry", {
      sessionId,
      entry: {
        type: "message",
        data: { role: "assistant", content: "hello from spine", timestamp: 1 },
      },
    });

    expect(res.status).toBe(200);
    const { entries } = await getEntries(stub, sessionId);
    const found = entries.find(
      (e) =>
        e.type === "message" &&
        (e.data.content === "hello from spine" || e.data.role === "assistant"),
    );
    expect(found).toBeTruthy();

    client.close();
  });

  it("getEntries returns the full entry list for a session", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-get-entries-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    await postJson(stub, "/spine/appendEntry", {
      sessionId,
      entry: { type: "message", data: { role: "user", content: "ping", timestamp: 1 } },
    });

    const res = await postJson(stub, "/spine/getEntries", { sessionId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ type: string; data: Record<string, unknown> }>;
    expect(Array.isArray(body)).toBe(true);
    const pings = body.filter((e) => e.type === "message" && e.data.content === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(1);

    client.close();
  });

  it("buildContext returns a message array", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-build-context-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    await postJson(stub, "/spine/appendEntry", {
      sessionId,
      entry: { type: "message", data: { role: "user", content: "hi", timestamp: 1 } },
    });

    const res = await postJson(stub, "/spine/buildContext", { sessionId });
    expect(res.status).toBe(200);
    const ctx = await res.json();
    expect(Array.isArray(ctx)).toBe(true);

    client.close();
  });
});

describe("spine bridge — transport broadcast", () => {
  it("broadcast reaches connected WebSocket clients on the same session", async () => {
    const stub = getStub("spine-broadcast-1");
    const client = await openSocket(stub);
    const sync = await client.waitForMessage((m) => m.type === "session_sync");
    const sessionId = (sync as { sessionId: string }).sessionId;

    const res = await postJson(stub, "/spine/broadcast", {
      sessionId,
      event: {
        type: "agent_event",
        event: { type: "message_start", message: { role: "assistant", content: [] } },
      },
    });
    expect(res.status).toBe(200);

    const received = await client.waitForMessage(
      (m) =>
        m.type === "agent_event" &&
        "event" in m &&
        (m as { event: { type: string } }).event.type === "message_start",
    );
    expect(received).toBeTruthy();
    if (received.type === "agent_event") {
      expect(received.sessionId).toBe(sessionId);
    }

    client.close();
  });

  it("broadcast stamps sessionId from the request body onto the outgoing message", async () => {
    const stub = getStub("spine-broadcast-2");
    const client = await openSocket(stub);
    const sync = await client.waitForMessage((m) => m.type === "session_sync");
    const sessionId = (sync as { sessionId: string }).sessionId;

    await postJson(stub, "/spine/broadcast", {
      sessionId,
      // Attempt to forge a different sessionId in the event body —
      // the handler must override it with the one from the verified
      // token payload (here: the body's sessionId).
      event: {
        type: "agent_event",
        sessionId: "forged-session",
        event: { type: "agent_end", messages: [] },
      },
    });

    const received = await client.waitForMessage(
      (m) =>
        m.type === "agent_event" &&
        "event" in m &&
        (m as { event: { type: string } }).event.type === "agent_end",
    );
    if (received.type === "agent_event") {
      expect(received.sessionId).toBe(sessionId);
      expect(received.sessionId).not.toBe("forged-session");
    }

    client.close();
  });
});

describe("spine bridge — kv ops", () => {
  it("kvPut + kvGet round-trips a namespaced value", async () => {
    const stub = getStub("spine-kv-1");

    const putRes = await postJson(stub, "/spine/kvPut", {
      capabilityId: "test-cap",
      key: "greeting",
      value: { text: "hello" },
    });
    expect(putRes.status).toBe(200);

    const getRes = await postJson(stub, "/spine/kvGet", {
      capabilityId: "test-cap",
      key: "greeting",
    });
    expect(getRes.status).toBe(200);
    const value = (await getRes.json()) as { text: string } | null;
    expect(value).toEqual({ text: "hello" });
  });

  it("kv namespaces do not leak across capability IDs", async () => {
    const stub = getStub("spine-kv-2");

    await postJson(stub, "/spine/kvPut", {
      capabilityId: "cap-a",
      key: "shared",
      value: "A-value",
    });
    await postJson(stub, "/spine/kvPut", {
      capabilityId: "cap-b",
      key: "shared",
      value: "B-value",
    });

    const getA = await postJson(stub, "/spine/kvGet", {
      capabilityId: "cap-a",
      key: "shared",
    });
    const getB = await postJson(stub, "/spine/kvGet", {
      capabilityId: "cap-b",
      key: "shared",
    });
    expect(await getA.json()).toBe("A-value");
    expect(await getB.json()).toBe("B-value");
  });
});

describe("spine bridge — unsupported ops", () => {
  it("returns 501 for unwired scheduler ops", async () => {
    const stub = getStub("spine-501-1");
    const res = await postJson(stub, "/spine/scheduleCreate", { schedule: {} });
    expect(res.status).toBe(501);
  });

  it("returns 404 for unknown spine paths", async () => {
    const stub = getStub("spine-404-1");
    const res = await postJson(stub, "/spine/nonsense", {});
    expect(res.status).toBe(404);
  });
});
