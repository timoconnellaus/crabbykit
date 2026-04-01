/**
 * Multi-session reliability tests.
 *
 * These tests exercise the WebSocket transport, session isolation, concurrent
 * inference (per-session agent instances), and state management.
 *
 * Each session gets its own Agent instance, so multiple sessions can run
 * inference in parallel within a single Durable Object.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCompactionOverrides,
  clearMockResponses,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import {
  findMessages,
  getEntries,
  getStub,
  openSocket,
  prompt as httpPrompt,
} from "../helpers/ws-client.js";

// --- Tests ---

describe("Multi-session WebSocket reliability", () => {
  beforeEach(() => {
    clearMockResponses();
    clearCompactionOverrides();
  });

  // ====================================================
  // 1. Basic WebSocket connection and session sync
  // ====================================================

  describe("1. WebSocket connection basics", () => {
    it("sends session_sync on connect", async () => {
      const stub = getStub("ws-connect-1");
      const client = await openSocket(stub);

      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      expect(sync.type).toBe("session_sync");
      if (sync.type === "session_sync") {
        expect(sync.sessionId).toBeTruthy();
        expect(sync.session).toBeTruthy();
        expect(Array.isArray(sync.messages)).toBe(true);
      }

      client.close();
    });

    it("sends session_list on connect", async () => {
      const stub = getStub("ws-connect-2");
      const client = await openSocket(stub);

      const list = await client.waitForMessage((m) => m.type === "session_list");
      expect(list.type).toBe("session_list");

      client.close();
    });

    it("receives agent events via WebSocket after prompt", async () => {
      const stub = getStub("ws-prompt-1");
      setMockResponses([{ text: "Hello via WS" }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as { sessionId: string }).sessionId;

      client.send({ type: "prompt", sessionId, text: "Hi" });

      // Should receive agent_event with message_end
      const agentEnd = await client.waitForMessage(
        (m) =>
          m.type === "agent_event" &&
          "event" in m &&
          (m as { event: { type: string } }).event.type === "agent_end",
      );
      expect(agentEnd).toBeTruthy();

      client.close();
    });
  });

  // ====================================================
  // 2. Session switching
  // ====================================================

  describe("2. Session switching", () => {
    it("switch_session sends session_sync for the new session", async () => {
      const stub = getStub("ws-switch-1");
      setMockResponses([{ text: "Session A response" }]);

      const client = await openSocket(stub);
      const sync1 = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync1 as { sessionId: string }).sessionId;

      // Prompt session A so it has content
      client.send({ type: "prompt", sessionId: sessionA, text: "Hello A" });
      await client.waitForMessage(
        (m) =>
          m.type === "agent_event" && (m as { event: { type: string } }).event.type === "agent_end",
      );

      // Create session B
      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      expect(syncB.type).toBe("session_sync");
      if (syncB.type === "session_sync") {
        expect(syncB.messages).toEqual([]);
        expect(syncB.sessionId).not.toBe(sessionA);
      }

      client.close();
    });

    it("switch_session includes streamMessage when target session is actively streaming", async () => {
      const stub = getStub("ws-switch-stream-1");
      // Set up a delayed response so session A is mid-stream
      setMockResponses([{ text: "Streaming response...", delay: 200 }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync1 as { sessionId: string }).sessionId;

      // Start streaming on session A
      client1.send({ type: "prompt", sessionId: sessionA, text: "Stream this" });

      // Wait for streaming to start
      await client1.waitForMessage(
        (m) =>
          m.type === "agent_event" &&
          (m as { event: { type: string } }).event.type === "message_start",
      );

      // Open a second connection (simulating a new tab)
      const client2 = await openSocket(stub);

      // Client2 should get session_sync with streamMessage reflecting the in-progress stream
      // for the default session (session A)
      const sync2 = await client2.waitForMessage((m) => m.type === "session_sync");

      // BUG: The initial sync should include streamMessage when the session is actively streaming.
      // Currently, switch_session always sends streamMessage: null.
      // The initial connect DOES include streamMessage (agent-do.ts:275), but it uses the
      // singleton agent's state which may not match the synced session.
      if (sync2.type === "session_sync") {
        // This is what we WANT: streamMessage should be non-null when the session is streaming
        expect(sync2.streamMessage).not.toBeNull();
      }

      // Wait for completion
      await client1.waitForMessage(
        (m) =>
          m.type === "agent_event" && (m as { event: { type: string } }).event.type === "agent_end",
      );

      client1.close();
      client2.close();
    });
  });

  // ====================================================
  // 3. Session isolation: events must not leak across sessions
  // ====================================================

  describe("3. Session isolation", () => {
    it("prompting session B while A is running: both sessions complete independently", async () => {
      const stub = getStub("ws-isolate-1");

      setMockResponses([
        { text: "Session A thinking deeply...", delay: 200 },
        { text: "Session B quick answer" },
      ]);

      const client = await openSocket(stub);
      const sync1 = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync1 as { sessionId: string }).sessionId;

      // Start inference on session A
      client.send({ type: "prompt", sessionId: sessionA, text: "Long running task" });
      await client.waitForMessage(
        (m) =>
          m.type === "agent_event" &&
          (m as { event: { type: string } }).event.type === "agent_start",
      );

      // Create session B and prompt it concurrently
      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      // Session B should run in parallel, not get AGENT_BUSY
      client.send({ type: "prompt", sessionId: sessionB, text: "Quick question for B" });

      // Wait for everything to settle
      await new Promise((r) => setTimeout(r, 500));

      // Session A should have its response correctly persisted
      const entriesA = await getEntries(stub, sessionA);
      const assistantEntriesA = entriesA.entries.filter(
        (e) => e.type === "message" && e.data.role === "assistant",
      );
      expect(assistantEntriesA.length).toBe(1);
      expect(JSON.stringify(assistantEntriesA[0].data.content)).toContain(
        "Session A thinking deeply",
      );

      // Session B should also have its response (parallel inference)
      const entriesB = await getEntries(stub, sessionB);
      const assistantEntriesB = entriesB.entries.filter(
        (e) => e.type === "message" && e.data.role === "assistant",
      );
      expect(assistantEntriesB.length).toBe(1);
      expect(JSON.stringify(assistantEntriesB[0].data.content)).toContain("Session B quick answer");

      // No AGENT_BUSY errors
      const errors = client.messages.filter((m) => m.type === "error");
      expect(errors.length).toBe(0);
    });

    it("B's watchers only receive B's events, not A's, when both sessions run concurrently", async () => {
      const stub = getStub("ws-broadcast-1");

      setMockResponses([
        { text: "Long response from A", delay: 200 },
        { text: "Quick response from B" },
      ]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync1 as { sessionId: string }).sessionId;

      // Create session B
      client1.send({ type: "new_session", name: "Session B" });
      const syncB = await client1.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      // Switch client1 back to session A
      client1.send({ type: "switch_session", sessionId: sessionA });
      await client1.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionA,
      );

      // Open client2 on session B
      const client2 = await openSocket(stub);
      client2.send({ type: "switch_session", sessionId: sessionB });
      await client2.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionB,
      );

      // Clear for clean tracking
      client1.messages.length = 0;
      client2.messages.length = 0;

      // Start inference on session A
      client1.send({ type: "prompt", sessionId: sessionA, text: "Long task for A" });
      await client1.waitForMessage(
        (m) =>
          m.type === "agent_event" &&
          (m as { event: { type: string } }).event.type === "agent_start",
      );

      // Prompt session B — runs in parallel
      client2.send({ type: "prompt", sessionId: sessionB, text: "Quick B task" });

      // Wait for everything
      await new Promise((r) => setTimeout(r, 500));

      // Client2 (on session B) should receive agent_events only for session B
      const client2AgentEvents = client2.messages.filter((m) => m.type === "agent_event");
      expect(client2AgentEvents.length).toBeGreaterThan(0);
      // All agent events on client2 should be for session B
      for (const evt of client2AgentEvents) {
        expect((evt as { sessionId: string }).sessionId).toBe(sessionB);
      }

      // Client1 (on session A) should only have events for session A
      const client1AgentEvents = client1.messages.filter((m) => m.type === "agent_event");
      for (const evt of client1AgentEvents) {
        expect((evt as { sessionId: string }).sessionId).toBe(sessionA);
      }

      // No errors
      const client2Errors = client2.messages.filter((m) => m.type === "error");
      expect(client2Errors.length).toBe(0);

      client1.close();
      client2.close();
    });
  });

  // ====================================================
  // 4. Abort scoping
  // ====================================================

  describe("4. Abort scoping", () => {
    it("abort for session B does not kill session A's inference", async () => {
      const stub = getStub("ws-abort-scope-1");

      setMockResponses([{ text: "Session A long response", delay: 300 }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync as { sessionId: string }).sessionId;

      // Create session B
      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      // Switch back to session A and start inference
      client.send({ type: "switch_session", sessionId: sessionA });
      await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionA,
      );

      client.send({ type: "prompt", sessionId: sessionA, text: "Long task" });

      // Wait for inference to start
      await client.waitForMessage(
        (m) =>
          m.type === "agent_event" &&
          (m as { event: { type: string } }).event.type === "agent_start",
      );

      // Switch to session B
      client.send({ type: "switch_session", sessionId: sessionB });
      await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionB,
      );

      // Abort session B (which has no running inference)
      client.send({ type: "abort", sessionId: sessionB });

      // Wait for things to settle
      await new Promise((r) => setTimeout(r, 500));

      // Session A's inference should NOT have been aborted
      const entriesA = await getEntries(stub, sessionA);
      const assistantEntries = entriesA.entries.filter(
        (e) => e.type === "message" && e.data.role === "assistant",
      );

      // If abort was properly scoped, session A should complete with full response
      expect(assistantEntries.length).toBeGreaterThan(0);
      const text = JSON.stringify(assistantEntries[0].data.content);
      // Full response, not truncated
      expect(text).toContain("Session A long response");

      client.close();
    });
  });

  // ====================================================
  // 5. Steer scoping
  // ====================================================

  describe("5. Steer scoping", () => {
    it("steer for session B is persisted but NOT injected into session A's agent", async () => {
      const stub = getStub("ws-steer-scope-1");

      setMockResponses([{ text: "Working on A...", delay: 200 }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync as { sessionId: string }).sessionId;

      // Create session B
      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      // Switch back to session A and start inference
      client.send({ type: "switch_session", sessionId: sessionA });
      await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionA,
      );

      client.send({ type: "prompt", sessionId: sessionA, text: "Do something" });
      await new Promise((r) => setTimeout(r, 50));

      // Send a steer for session B while session A is running
      client.send({ type: "steer", sessionId: sessionB, text: "Message for B only" });

      // Wait for completion
      await new Promise((r) => setTimeout(r, 500));

      // The steer is persisted to session B's store
      const entriesB = await getEntries(stub, sessionB);
      const userEntriesB = entriesB.entries.filter(
        (e) => e.type === "message" && e.data.role === "user",
      );
      expect(userEntriesB.length).toBe(1);
      expect(userEntriesB[0].data.content).toBe("Message for B only");

      // The steer should NOT have been injected into the agent (session B != inferring session A)
      const historyRes = await stub.fetch("http://fake/steer-history");
      const history = (await historyRes.json()) as { steeredMessages: Array<{ content: string }> };
      expect(history.steeredMessages.length).toBe(0);

      client.close();
    });
  });

  // ====================================================
  // 6. Concurrent prompts on different sessions
  // ====================================================

  describe("6. Concurrent prompts", () => {
    it("concurrent HTTP prompts: both sessions complete independently", async () => {
      const stub = getStub("ws-concurrent-1");

      setMockResponses([
        { text: "Response for session A", delay: 100 },
        { text: "Response for session B" },
      ]);

      // Create two sessions via first prompt (creates default) + WS
      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync as { sessionId: string }).sessionId;

      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      // Fire both prompts concurrently — both should succeed
      await Promise.all([
        httpPrompt(stub, "Question for A", sessionA),
        httpPrompt(stub, "Question for B", sessionB),
      ]);

      // Session A should have its response
      const entriesA = await getEntries(stub, sessionA);
      const assistantA = entriesA.entries.filter(
        (e) => e.type === "message" && e.data.role === "assistant",
      );
      expect(assistantA.length).toBe(1);
      expect(JSON.stringify(assistantA[0].data.content)).toContain("session A");

      // Session B should also have its response (parallel inference)
      const entriesB = await getEntries(stub, sessionB);
      const assistantB = entriesB.entries.filter(
        (e) => e.type === "message" && e.data.role === "assistant",
      );
      expect(assistantB.length).toBe(1);
      expect(JSON.stringify(assistantB[0].data.content)).toContain("session B");

      client.close();
    });
  });

  // ====================================================
  // 7. Multi-tab (multiple WebSocket connections)
  // ====================================================

  describe("7. Multi-tab", () => {
    it("two connections on the same session both receive agent events", async () => {
      const stub = getStub("ws-multi-tab-1");
      setMockResponses([{ text: "Shared response" }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as { sessionId: string }).sessionId;

      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");

      // Prompt from client1
      client1.send({ type: "prompt", sessionId, text: "Shared message" });

      // Both clients should receive agent_end
      const end1 = client1.waitForMessage(
        (m) =>
          m.type === "agent_event" && (m as { event: { type: string } }).event.type === "agent_end",
      );
      const end2 = client2.waitForMessage(
        (m) =>
          m.type === "agent_event" && (m as { event: { type: string } }).event.type === "agent_end",
      );

      await Promise.all([end1, end2]);

      client1.close();
      client2.close();
    });

    it("connections on different sessions only get their own events", async () => {
      const stub = getStub("ws-multi-tab-2");
      setMockResponses([{ text: "Response for A" }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync1 as { sessionId: string }).sessionId;

      // Create session B
      client1.send({ type: "new_session", name: "Session B" });
      const syncB = await client1.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      // Open client2 and put it on session B
      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");
      client2.send({ type: "switch_session", sessionId: sessionB });
      await client2.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionB,
      );

      // Clear messages
      client2.messages.length = 0;

      // Switch client1 back to session A
      client1.send({ type: "switch_session", sessionId: sessionA });
      await client1.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionA,
      );

      // Prompt session A
      client1.send({ type: "prompt", sessionId: sessionA, text: "Only for A" });
      await client1.waitForMessage(
        (m) =>
          m.type === "agent_event" && (m as { event: { type: string } }).event.type === "agent_end",
      );

      // Client2 (on session B) should NOT have received any agent_events
      const client2AgentEvents = client2.messages.filter((m) => m.type === "agent_event");
      expect(client2AgentEvents.length).toBe(0);

      client1.close();
      client2.close();
    });
  });

  // ====================================================
  // 8. WebSocket connection cleanup
  // ====================================================

  describe("8. Connection lifecycle", () => {
    it("closing a WebSocket removes it from the connections map", async () => {
      const stub = getStub("ws-cleanup-1");
      setMockResponses([{ text: "After disconnect" }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as { sessionId: string }).sessionId;

      // Close client1
      client1.close();

      // Open client2 - should work fine
      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");

      // Prompt should work on client2
      client2.send({ type: "prompt", sessionId, text: "Still works" });
      const end = await client2.waitForMessage(
        (m) =>
          m.type === "agent_event" && (m as { event: { type: string } }).event.type === "agent_end",
      );
      expect(end).toBeTruthy();

      client2.close();
    });
  });

  // ====================================================
  // 9. New session creation during active inference
  // ====================================================

  describe("9. New session during active inference", () => {
    it("prompting session B while A runs: both sessions complete independently", async () => {
      const stub = getStub("ws-new-mid-infer-1");

      setMockResponses([
        { text: "Session A deep thought", delay: 200 },
        { text: "Session B quick answer" },
      ]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync as { sessionId: string }).sessionId;

      // Start inference on session A
      client.send({ type: "prompt", sessionId: sessionA, text: "Think deeply" });
      await client.waitForMessage(
        (m) =>
          m.type === "agent_event" &&
          (m as { event: { type: string } }).event.type === "agent_start",
      );

      // Create session B and prompt it concurrently
      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;
      client.send({ type: "prompt", sessionId: sessionB, text: "Quick question" });

      // Wait for everything
      await new Promise((r) => setTimeout(r, 500));

      // Session A's response stays in session A
      const entriesA = await getEntries(stub, sessionA);
      const assistantA = entriesA.entries.filter(
        (e) => e.type === "message" && e.data.role === "assistant",
      );
      expect(assistantA.length).toBe(1);
      expect(JSON.stringify(assistantA[0].data.content)).toContain("Session A deep thought");

      // Session B also completes (parallel inference)
      const entriesB = await getEntries(stub, sessionB);
      const assistantB = entriesB.entries.filter(
        (e) => e.type === "message" && e.data.role === "assistant",
      );
      expect(assistantB.length).toBe(1);
      expect(JSON.stringify(assistantB[0].data.content)).toContain("Session B quick answer");

      client.close();
    });
  });

  // ====================================================
  // 10. Session deletion during active inference
  // ====================================================

  describe("10. Session deletion edge cases", () => {
    it("deleting a non-active session doesn't affect current session", async () => {
      const stub = getStub("ws-delete-1");
      setMockResponses([{ text: "Response A" }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync as { sessionId: string }).sessionId;

      // Create session B
      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      // Switch back to A
      client.send({ type: "switch_session", sessionId: sessionA });
      await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId === sessionA,
      );

      // Delete session B while on session A
      client.send({ type: "delete_session", sessionId: sessionB });

      // Should still be able to prompt session A
      client.send({ type: "prompt", sessionId: sessionA, text: "Still here" });
      const end = await client.waitForMessage(
        (m) =>
          m.type === "agent_event" && (m as { event: { type: string } }).event.type === "agent_end",
      );
      expect(end).toBeTruthy();

      client.close();
    });
  });

  // ====================================================
  // 11. Rapid session switching
  // ====================================================

  describe("11. Rapid session switching", () => {
    it("rapid switching settles on the last session", async () => {
      const stub = getStub("ws-rapid-switch-1");

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionA = (sync as { sessionId: string }).sessionId;

      // Create sessions B and C
      client.send({ type: "new_session", name: "Session B" });
      const syncB = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as { sessionId: string }).sessionId !== sessionA,
      );
      const sessionB = (syncB as { sessionId: string }).sessionId;

      client.send({ type: "new_session", name: "Session C" });
      const syncC = await client.waitForMessage(
        (m) =>
          m.type === "session_sync" &&
          (m as { sessionId: string }).sessionId !== sessionA &&
          (m as { sessionId: string }).sessionId !== sessionB,
      );
      const sessionC = (syncC as { sessionId: string }).sessionId;

      // Rapidly switch: A → B → C → A → C
      client.send({ type: "switch_session", sessionId: sessionA });
      client.send({ type: "switch_session", sessionId: sessionB });
      client.send({ type: "switch_session", sessionId: sessionC });
      client.send({ type: "switch_session", sessionId: sessionA });
      client.send({ type: "switch_session", sessionId: sessionC });

      // Wait for all syncs to arrive
      await new Promise((r) => setTimeout(r, 200));

      // The last session_sync received should be for session C
      const syncs = client.messages.filter((m) => m.type === "session_sync");
      const lastSync = syncs[syncs.length - 1];
      if (lastSync.type === "session_sync") {
        expect(lastSync.sessionId).toBe(sessionC);
      }

      client.close();
    });
  });
});
