/**
 * SpineHost direct-method-surface integration tests.
 *
 * `SpineService` calls `host.spineX(sid, args)` directly on a
 * `DurableObjectStub<SpineHost>` — there are no HTTP routes to exercise.
 * These tests drive the DO's public spine method surface in isolation
 * (bypassing SpineService's token verification) to assert that each
 * method reaches the expected store / transport / cost helper.
 *
 * In production the methods are only callable from SpineService; in
 * tests we call them directly on the DO stub because we're exercising
 * the host-side implementation, not the token verifier.
 *
 * Uses unique DO names per describe block (per project testing rules)
 * since `isolatedStorage` is disabled.
 */

import { describe, expect, it } from "vitest";
import type { AgentDO } from "../../src/agent-do.js";
import { clearMockResponses, setMockResponses } from "../../src/test-helpers/test-agent-do.js";
import { connectAndGetSession, getEntries, getStub, openSocket } from "../helpers/ws-client.js";

// Narrow the DO stub to the spine method surface used by these tests.
// `DurableObjectStub` defaults to `DurableObjectStub<undefined>` which
// has no application-level methods; every spine call below goes through
// this helper so the tests read as real method invocations rather than
// `(stub as any).spineX(...)`.
type SpineStub = DurableObjectStub<AgentDO<Record<string, unknown>>>;
function spine(stub: DurableObjectStub): SpineStub {
  return stub as unknown as SpineStub;
}

describe("spine bridge — session store ops", () => {
  it("spineAppendEntry persists an entry that subsequent reads observe", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-append-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    await spine(stub).spineAppendEntry(sessionId, {
      type: "message",
      data: { role: "assistant", content: "hello from spine", timestamp: 1 },
    });

    const { entries } = await getEntries(stub, sessionId);
    const found = entries.find(
      (e) =>
        e.type === "message" &&
        (e.data.content === "hello from spine" || e.data.role === "assistant"),
    );
    expect(found).toBeTruthy();

    client.close();
  });

  it("spineGetEntries returns the full entry list for a session", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-get-entries-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    await spine(stub).spineAppendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: "ping", timestamp: 1 },
    });

    const entries = (await spine(stub).spineGetEntries(sessionId)) as Array<{
      type: string;
      data: Record<string, unknown>;
    }>;
    expect(Array.isArray(entries)).toBe(true);
    const pings = entries.filter((e) => e.type === "message" && e.data.content === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(1);

    client.close();
  });

  it("spineBuildContext returns a message array", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-build-context-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    await spine(stub).spineAppendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: "hi", timestamp: 1 },
    });

    const ctx = await spine(stub).spineBuildContext(sessionId);
    expect(Array.isArray(ctx)).toBe(true);

    client.close();
  });

  it("spineGetSession returns the session record", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-get-session-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    const session = (await spine(stub).spineGetSession(sessionId)) as { id: string } | null;
    expect(session?.id).toBe(sessionId);

    client.close();
  });

  it("spineListSessions returns all sessions", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-list-sessions-1");
    const { sessionId, client } = await connectAndGetSession(stub);

    const list = (await spine(stub).spineListSessions()) as Array<{ id: string }>;
    expect(list.some((s) => s.id === sessionId)).toBe(true);

    client.close();
  });

  it("spineCreateSession creates a new session (agent-scoped)", async () => {
    const stub = getStub("spine-create-session-1");
    const created = (await spine(stub).spineCreateSession({ name: "spine-born" })) as {
      id: string;
      name: string;
    };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("spine-born");
  });
});

describe("spine bridge — transport broadcast", () => {
  it("spineBroadcast reaches connected WebSocket clients on the same session", async () => {
    const stub = getStub("spine-broadcast-1");
    const client = await openSocket(stub);
    const sync = await client.waitForMessage((m) => m.type === "session_sync");
    const sessionId = (sync as { sessionId: string }).sessionId;

    await spine(stub).spineBroadcast(sessionId, {
      type: "agent_event",
      event: { type: "message_start", message: { role: "assistant", content: [] } },
    });

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

  it("spineBroadcast stamps sessionId onto the outgoing message, overriding forged ids", async () => {
    const stub = getStub("spine-broadcast-2");
    const client = await openSocket(stub);
    const sync = await client.waitForMessage((m) => m.type === "session_sync");
    const sessionId = (sync as { sessionId: string }).sessionId;

    await spine(stub).spineBroadcast(sessionId, {
      type: "agent_event",
      // Attempt to forge a different sessionId in the event body —
      // the handler must override it with the one from the verified
      // token payload (here: the argument sessionId).
      sessionId: "forged-session",
      event: { type: "agent_end", messages: [] },
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
  it("spineKvPut + spineKvGet round-trips a namespaced value", async () => {
    const stub = getStub("spine-kv-1");

    await spine(stub).spineKvPut("test-cap", "greeting", { text: "hello" });

    const value = (await spine(stub).spineKvGet("test-cap", "greeting")) as {
      text: string;
    } | null;
    expect(value).toEqual({ text: "hello" });
  });

  it("spineKv namespaces do not leak across capability IDs", async () => {
    const stub = getStub("spine-kv-2");

    await spine(stub).spineKvPut("cap-a", "shared", "A-value");
    await spine(stub).spineKvPut("cap-b", "shared", "B-value");

    const a = await spine(stub).spineKvGet("cap-a", "shared");
    const b = await spine(stub).spineKvGet("cap-b", "shared");
    expect(a).toBe("A-value");
    expect(b).toBe("B-value");
  });

  it("spineKvDelete removes a previously stored value", async () => {
    const stub = getStub("spine-kv-3");
    await spine(stub).spineKvPut("cap-del", "k", "v");
    await spine(stub).spineKvDelete("cap-del", "k");
    const after = await spine(stub).spineKvGet("cap-del", "k");
    expect(after).toBeUndefined();
  });

  it("spineKvList returns entries under the capability namespace", async () => {
    const stub = getStub("spine-kv-4");
    await spine(stub).spineKvPut("cap-list", "a", 1);
    await spine(stub).spineKvPut("cap-list", "b", 2);

    const entries = (await spine(stub).spineKvList("cap-list")) as Array<{
      key: string;
      value: unknown;
    }>;
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(["a", "b"]);
  });
});

describe("spine bridge — compaction checkpoint", () => {
  it("spineGetCompactionCheckpoint returns null when no compaction entry exists", async () => {
    const stub = getStub("spine-compaction-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const checkpoint = await spine(stub).spineGetCompactionCheckpoint(sessionId);
    expect(checkpoint).toBeNull();
    client.close();
  });

  it("spineGetCompactionCheckpoint returns the most recent compaction entry data", async () => {
    const stub = getStub("spine-compaction-2");
    const { sessionId, client } = await connectAndGetSession(stub);
    const msg = (await spine(stub).spineAppendEntry(sessionId, {
      type: "message",
      data: { role: "user", content: "before-compact", timestamp: 1 },
    })) as { id: string };
    await spine(stub).spineAppendEntry(sessionId, {
      type: "compaction",
      data: {
        summary: "rolled up everything",
        firstKeptEntryId: msg.id,
        tokensBefore: 42,
      },
    });
    const checkpoint = (await spine(stub).spineGetCompactionCheckpoint(sessionId)) as {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    };
    expect(checkpoint.summary).toBe("rolled up everything");
    expect(checkpoint.firstKeptEntryId).toBe(msg.id);
    expect(checkpoint.tokensBefore).toBe(42);
    client.close();
  });
});

describe("spine bridge — schedule store (direct method)", () => {
  it("spineScheduleCreate persists a schedule reachable via spineScheduleList", async () => {
    const stub = getStub("spine-schedule-1");
    const created = (await spine(stub).spineScheduleCreate({
      name: "bundle-scheduled",
      cron: "*/5 * * * *",
      handlerType: "prompt",
      prompt: "tick",
    })) as { id: string; name: string };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("bundle-scheduled");

    const list = (await spine(stub).spineScheduleList()) as Array<{ id: string }>;
    expect(list.some((s) => s.id === created.id)).toBe(true);
  });

  it("spineScheduleUpdate mutates an existing schedule", async () => {
    const stub = getStub("spine-schedule-2");
    const created = (await spine(stub).spineScheduleCreate({
      name: "to-update",
      cron: "* * * * *",
      handlerType: "prompt",
      prompt: "initial",
    })) as { id: string };

    await spine(stub).spineScheduleUpdate(created.id, { prompt: "updated-prompt" });

    const list = (await spine(stub).spineScheduleList()) as Array<{
      id: string;
      prompt: string | null;
    }>;
    const found = list.find((s) => s.id === created.id);
    expect(found?.prompt).toBe("updated-prompt");
  });

  it("spineScheduleDelete removes a schedule", async () => {
    const stub = getStub("spine-schedule-3");
    const created = (await spine(stub).spineScheduleCreate({
      name: "to-delete",
      cron: "* * * * *",
      handlerType: "prompt",
      prompt: "bye",
    })) as { id: string };

    await spine(stub).spineScheduleDelete(created.id);

    const list = (await spine(stub).spineScheduleList()) as Array<{ id: string }>;
    expect(list.some((s) => s.id === created.id)).toBe(false);
  });
});

describe("spine bridge — alarm (direct method)", () => {
  it("spineAlarmSet forwards an epoch-ms timestamp to the underlying scheduler", async () => {
    const stub = getStub("spine-alarm-1");
    // Pick a timestamp one hour from now. We don't have a way to read
    // the DO's alarm directly from the test harness, but the call MUST
    // succeed without throwing — which would expose a plumbing bug in
    // `spineAlarmSet`'s Date conversion or the underlying scheduler.
    const target = Date.now() + 60 * 60 * 1000;
    await expect(spine(stub).spineAlarmSet(target)).resolves.toBeUndefined();
  });
});
