/**
 * SpineHost direct-method-surface integration tests.
 *
 * `SpineService` calls `host.spineX(caller, args)` directly on a
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
import type { SpineCaller } from "../../src/spine-host.js";
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

/** Build a synthetic `SpineCaller` for test use. */
function makeCaller(overrides: Partial<SpineCaller> = {}): SpineCaller {
  return {
    aid: "test-agent",
    sid: "test-session",
    nonce: crypto.randomUUID(),
    ...overrides,
  };
}

describe("spine bridge — session store ops", () => {
  it("spineAppendEntry persists an entry that subsequent reads observe", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-append-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineAppendEntry(caller, {
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
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineAppendEntry(caller, {
      type: "message",
      data: { role: "user", content: "ping", timestamp: 1 },
    });

    const entries = (await spine(stub).spineGetEntries(caller)) as Array<{
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
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineAppendEntry(caller, {
      type: "message",
      data: { role: "user", content: "hi", timestamp: 1 },
    });

    const ctx = await spine(stub).spineBuildContext(caller);
    expect(Array.isArray(ctx)).toBe(true);

    client.close();
  });

  it("spineGetSession returns the session record", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-get-session-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    const session = (await spine(stub).spineGetSession(caller)) as { id: string } | null;
    expect(session?.id).toBe(sessionId);

    client.close();
  });

  it("spineListSessions returns all sessions", async () => {
    clearMockResponses();
    setMockResponses([{ text: "irrelevant" }]);
    const stub = getStub("spine-list-sessions-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });

    const list = (await spine(stub).spineListSessions(caller)) as Array<{ id: string }>;
    expect(list.some((s) => s.id === sessionId)).toBe(true);

    client.close();
  });

  it("spineCreateSession creates a new session (agent-scoped)", async () => {
    const stub = getStub("spine-create-session-1");
    const caller = makeCaller({ sid: "" });
    const created = (await spine(stub).spineCreateSession(caller, { name: "spine-born" })) as {
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
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineBroadcast(caller, {
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
    const caller = makeCaller({ sid: sessionId });

    await spine(stub).spineBroadcast(caller, {
      type: "agent_event",
      // Attempt to forge a different sessionId in the event body —
      // the handler must override it with the one from the verified
      // token payload (here: the caller's sid).
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
    const caller = makeCaller();

    await spine(stub).spineKvPut(caller, "test-cap", "greeting", { text: "hello" });

    const value = (await spine(stub).spineKvGet(caller, "test-cap", "greeting")) as {
      text: string;
    } | null;
    expect(value).toEqual({ text: "hello" });
  });

  it("spineKv namespaces do not leak across capability IDs", async () => {
    const stub = getStub("spine-kv-2");
    const caller = makeCaller();

    await spine(stub).spineKvPut(caller, "cap-a", "shared", "A-value");
    await spine(stub).spineKvPut(caller, "cap-b", "shared", "B-value");

    const a = await spine(stub).spineKvGet(caller, "cap-a", "shared");
    const b = await spine(stub).spineKvGet(caller, "cap-b", "shared");
    expect(a).toBe("A-value");
    expect(b).toBe("B-value");
  });

  it("spineKvDelete removes a previously stored value", async () => {
    const stub = getStub("spine-kv-3");
    const caller = makeCaller();
    await spine(stub).spineKvPut(caller, "cap-del", "k", "v");
    await spine(stub).spineKvDelete(caller, "cap-del", "k");
    const after = await spine(stub).spineKvGet(caller, "cap-del", "k");
    expect(after).toBeUndefined();
  });

  it("spineKvList returns entries under the capability namespace", async () => {
    const stub = getStub("spine-kv-4");
    const caller = makeCaller();
    await spine(stub).spineKvPut(caller, "cap-list", "a", 1);
    await spine(stub).spineKvPut(caller, "cap-list", "b", 2);

    const entries = (await spine(stub).spineKvList(caller, "cap-list")) as Array<{
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
    const caller = makeCaller({ sid: sessionId });
    const checkpoint = await spine(stub).spineGetCompactionCheckpoint(caller);
    expect(checkpoint).toBeNull();
    client.close();
  });

  it("spineGetCompactionCheckpoint returns the most recent compaction entry data", async () => {
    const stub = getStub("spine-compaction-2");
    const { sessionId, client } = await connectAndGetSession(stub);
    const caller = makeCaller({ sid: sessionId });
    const msg = (await spine(stub).spineAppendEntry(caller, {
      type: "message",
      data: { role: "user", content: "before-compact", timestamp: 1 },
    })) as { id: string };
    await spine(stub).spineAppendEntry(caller, {
      type: "compaction",
      data: {
        summary: "rolled up everything",
        firstKeptEntryId: msg.id,
        tokensBefore: 42,
      },
    });
    const checkpoint = (await spine(stub).spineGetCompactionCheckpoint(caller)) as {
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
    const caller = makeCaller();
    const created = (await spine(stub).spineScheduleCreate(caller, {
      name: "bundle-scheduled",
      cron: "*/5 * * * *",
      handlerType: "prompt",
      prompt: "tick",
    })) as { id: string; name: string };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("bundle-scheduled");

    const list = (await spine(stub).spineScheduleList(caller)) as Array<{ id: string }>;
    expect(list.some((s) => s.id === created.id)).toBe(true);
  });

  it("spineScheduleUpdate mutates an existing schedule", async () => {
    const stub = getStub("spine-schedule-2");
    const caller = makeCaller();
    const created = (await spine(stub).spineScheduleCreate(caller, {
      name: "to-update",
      cron: "* * * * *",
      handlerType: "prompt",
      prompt: "initial",
    })) as { id: string };

    await spine(stub).spineScheduleUpdate(caller, created.id, { prompt: "updated-prompt" });

    const list = (await spine(stub).spineScheduleList(caller)) as Array<{
      id: string;
      prompt: string | null;
    }>;
    const found = list.find((s) => s.id === created.id);
    expect(found?.prompt).toBe("updated-prompt");
  });

  it("spineScheduleDelete removes a schedule", async () => {
    const stub = getStub("spine-schedule-3");
    const caller = makeCaller();
    const created = (await spine(stub).spineScheduleCreate(caller, {
      name: "to-delete",
      cron: "* * * * *",
      handlerType: "prompt",
      prompt: "bye",
    })) as { id: string };

    await spine(stub).spineScheduleDelete(caller, created.id);

    const list = (await spine(stub).spineScheduleList(caller)) as Array<{ id: string }>;
    expect(list.some((s) => s.id === created.id)).toBe(false);
  });
});

describe("spine bridge — alarm (direct method)", () => {
  it("spineAlarmSet forwards an epoch-ms timestamp to the underlying scheduler", async () => {
    const stub = getStub("spine-alarm-1");
    const caller = makeCaller();
    // Pick a timestamp one hour from now. We don't have a way to read
    // the DO's alarm directly from the test harness, but the call MUST
    // succeed without throwing — which would expose a plumbing bug in
    // `spineAlarmSet`'s Date conversion or the underlying scheduler.
    const target = Date.now() + 60 * 60 * 1000;
    await expect(spine(stub).spineAlarmSet(caller, target)).resolves.toBeUndefined();
  });
});

// --- Budget enforcement scenarios ---
//
// These tests exercise the per-DO BudgetTracker that moved from
// SpineService into AgentRuntime. Each scenario calls spine methods
// directly on the DO stub (bypassing SpineService) to verify the
// tracker is correctly keyed by nonce, category, and DO identity.

describe("spine budget enforcement (per-DO)", () => {
  it("cap enforcement: 100 sql ops succeed, the 101st throws ERR_BUDGET_EXCEEDED", async () => {
    const stub = getStub("spine-budget-cap-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    // All 100 calls share the same nonce (same "turn")
    const nonce = crypto.randomUUID();
    const caller = makeCaller({ sid: sessionId, nonce });

    for (let i = 0; i < 100; i++) {
      await spine(stub).spineAppendEntry(caller, {
        type: "message",
        data: { role: "user", content: `msg-${i}`, timestamp: i },
      });
    }

    // 101st call should exceed the default maxSqlOps=100
    await expect(
      spine(stub).spineAppendEntry(caller, {
        type: "message",
        data: { role: "user", content: "overflow", timestamp: 200 },
      }),
    ).rejects.toThrow(/budget exceeded/i);

    client.close();
  });

  it("per-nonce isolation: exhausting nonce A does not affect nonce B", async () => {
    const stub = getStub("spine-budget-nonce-iso-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const nonceA = "nonce-a";
    const nonceB = "nonce-b";

    // Exhaust nonce A
    for (let i = 0; i < 100; i++) {
      await spine(stub).spineAppendEntry(makeCaller({ sid: sessionId, nonce: nonceA }), {
        type: "message",
        data: { role: "user", content: `a-${i}`, timestamp: i },
      });
    }

    // Nonce A is exhausted
    await expect(
      spine(stub).spineAppendEntry(makeCaller({ sid: sessionId, nonce: nonceA }), {
        type: "message",
        data: { role: "user", content: "overflow", timestamp: 999 },
      }),
    ).rejects.toThrow(/budget exceeded/i);

    // Nonce B should still work — fresh budget
    await expect(
      spine(stub).spineAppendEntry(makeCaller({ sid: sessionId, nonce: nonceB }), {
        type: "message",
        data: { role: "user", content: "b-first", timestamp: 1 },
      }),
    ).resolves.toBeTruthy();

    client.close();
  });

  it("per-category isolation: exhausting sql does not affect kv", async () => {
    const stub = getStub("spine-budget-cat-iso-1");
    const { sessionId, client } = await connectAndGetSession(stub);
    const nonce = "nonce-cat";
    const caller = makeCaller({ sid: sessionId, nonce });

    // Exhaust sql budget (default 100)
    for (let i = 0; i < 100; i++) {
      await spine(stub).spineAppendEntry(caller, {
        type: "message",
        data: { role: "user", content: `msg-${i}`, timestamp: i },
      });
    }

    // sql is exhausted
    await expect(
      spine(stub).spineAppendEntry(caller, {
        type: "message",
        data: { role: "user", content: "overflow", timestamp: 999 },
      }),
    ).rejects.toThrow(/budget exceeded/i);

    // kv should still work — independent category with default maxKvOps=50
    await expect(
      spine(stub).spineKvPut(caller, "test-cap", "key", "value"),
    ).resolves.toBeUndefined();

    client.close();
  });

  it("per-agent isolation: exhausting agent X does not affect agent Y", async () => {
    const stubX = getStub("spine-budget-agent-x");
    const stubY = getStub("spine-budget-agent-y");
    const { sessionId: sidX, client: clientX } = await connectAndGetSession(stubX);
    const { sessionId: sidY, client: clientY } = await connectAndGetSession(stubY);
    const nonce = "shared-nonce";

    // Exhaust agent X's sql budget
    for (let i = 0; i < 100; i++) {
      await spine(stubX).spineAppendEntry(makeCaller({ sid: sidX, nonce }), {
        type: "message",
        data: { role: "user", content: `x-${i}`, timestamp: i },
      });
    }

    // Agent X is exhausted
    await expect(
      spine(stubX).spineAppendEntry(makeCaller({ sid: sidX, nonce }), {
        type: "message",
        data: { role: "user", content: "overflow", timestamp: 999 },
      }),
    ).rejects.toThrow(/budget exceeded/i);

    // Agent Y should still work — separate DO, separate BudgetTracker
    await expect(
      spine(stubY).spineAppendEntry(makeCaller({ sid: sidY, nonce }), {
        type: "message",
        data: { role: "user", content: "y-first", timestamp: 1 },
      }),
    ).resolves.toBeTruthy();

    clientX.close();
    clientY.close();
  });
});
