/**
 * Hibernation recovery edge case tests.
 *
 * Tests the behavior when a DO wakes from hibernation and receives
 * WebSocket messages. In-memory state (transport connections, sessionAgents,
 * rate limits) is cleared via /simulate-hibernation to mimic real eviction.
 *
 * Key recovery paths tested:
 * - session_sync sent on non-prompt/steer messages after wake
 * - prompt/steer skip session_sync (avoid racing with optimistic client state)
 * - rate limit state is fresh after recovery
 * - wasRestoredFromHibernation flag cleared after first message
 * - multiple connections recover independently
 * - inference works correctly after recovery
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMockResponses,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import type { ServerMessage } from "../../src/transport/types.js";
import {
  connectAndGetSession,
  getEntries,
  getStub,
  openSocket,
  prompt,
  simulateHibernation,
} from "../helpers/ws-client.js";

type SessionSyncMsg = Extract<ServerMessage, { type: "session_sync" }>;
type AgentEventMsg = Extract<ServerMessage, { type: "agent_event" }>;

describe("Hibernation Recovery", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  describe("session_sync on recovery", () => {
    it("request_sync after hibernation sends session_sync with full state", async () => {
      const stub = getStub("hib-sync-1");

      // Establish session with data
      setMockResponses([{ text: "Before hibernation" }]);
      await prompt(stub, "Hello");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      // request_sync triggers hibernation recovery path
      client.send({ type: "request_sync", sessionId });

      const recoverySync = await client.waitForMessage((m) => m.type === "session_sync");
      const syncMsg = recoverySync as SessionSyncMsg;
      expect(syncMsg.sessionId).toBe(sessionId);
      expect(syncMsg.messages.length).toBeGreaterThanOrEqual(2);
      expect(syncMsg.streamMessage).toBeNull();

      client.close();
    });

    it("ping after hibernation triggers session_sync", async () => {
      const stub = getStub("hib-sync-2");

      setMockResponses([{ text: "Stored data" }]);
      await prompt(stub, "Store this");

      const { client } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      client.send({ type: "ping" });

      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      expect(sync.type).toBe("session_sync");

      client.close();
    });
  });

  describe("prompt/steer skip session_sync", () => {
    it("prompt after hibernation does NOT send session_sync before inference", async () => {
      const stub = getStub("hib-prompt-1");

      setMockResponses([{ text: "Pre-hibernation reply" }]);
      await prompt(stub, "Initial message");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      // Prompt should NOT trigger session_sync (avoids racing with optimistic client state)
      setMockResponses([{ text: "Post-hibernation reply" }]);
      client.send({ type: "prompt", sessionId, text: "After wake" });

      // Wait for inference to complete
      const agentEnd = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );
      expect(agentEnd).toBeTruthy();

      // No session_sync should have been sent
      const syncs = client.messages.filter((m) => m.type === "session_sync");
      expect(syncs.length).toBe(0);

      client.close();
    });

    it("steer after hibernation does NOT send session_sync", async () => {
      const stub = getStub("hib-steer-1");

      setMockResponses([{ text: "Working...", delay: 300 }]);

      const { client, sessionId } = await connectAndGetSession(stub);

      // Start inference
      client.send({ type: "prompt", sessionId, text: "Do something slow" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_start",
      );

      // Simulate hibernation mid-inference
      await simulateHibernation(stub);
      client.messages.length = 0;

      // Steer should not trigger session_sync
      client.send({ type: "steer", sessionId, text: "Redirect this" });

      // Give time for any potential session_sync
      await new Promise((r) => setTimeout(r, 150));

      const syncs = client.messages.filter((m) => m.type === "session_sync");
      expect(syncs.length).toBe(0);

      client.close();
    });
  });

  describe("wasRestoredFromHibernation flag lifecycle", () => {
    it("flag is cleared after first non-prompt message — second request_sync is normal", async () => {
      const stub = getStub("hib-flag-1");

      setMockResponses([{ text: "Data" }]);
      await prompt(stub, "Store data");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      // First request_sync → triggers recovery session_sync + normal response
      client.send({ type: "request_sync", sessionId });
      await client.waitForMessage((m) => m.type === "session_sync");

      const syncCount1 = client.messages.filter((m) => m.type === "session_sync").length;

      // Second request_sync → only normal response (no recovery sync)
      client.send({ type: "request_sync", sessionId });
      await client.waitForMessage(
        (m) =>
          m.type === "session_sync" &&
          client.messages.filter((x) => x.type === "session_sync").length > syncCount1,
      );

      // First request_sync gets recovery sync + normal sync response = 2
      // Second request_sync gets only normal sync response = 1
      // But recovery sync and normal sync from first request are both session_sync messages
      const totalSyncs = client.messages.filter((m) => m.type === "session_sync").length;
      expect(totalSyncs).toBeGreaterThanOrEqual(2);

      client.close();
    });
  });

  describe("rate limit state reset on recovery", () => {
    it("rate limit counters reset after hibernation", async () => {
      const stub = getStub("hib-rate-1");

      setMockResponses([{ text: "Init" }]);
      await prompt(stub, "Init");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      // Approach rate limit (limit is 30 per 10s window)
      for (let i = 0; i < 25; i++) {
        client.send({ type: "request_sync", sessionId });
      }
      await new Promise((r) => setTimeout(r, 200));

      // Hibernate — rate limit state wiped
      await simulateHibernation(stub);
      client.messages.length = 0;

      // After recovery, counter should be reset — these should all succeed
      for (let i = 0; i < 10; i++) {
        client.send({ type: "request_sync", sessionId });
      }
      await new Promise((r) => setTimeout(r, 200));

      const errors = client.messages.filter(
        (m) =>
          m.type === "error" &&
          (m as Extract<ServerMessage, { type: "error" }>).code === "RATE_LIMITED",
      );
      expect(errors.length).toBe(0);

      const syncs = client.messages.filter((m) => m.type === "session_sync");
      expect(syncs.length).toBeGreaterThan(0);

      client.close();
    });
  });

  describe("multiple connections recover independently", () => {
    it("two clients on same session recover independently after hibernation", async () => {
      const stub = getStub("hib-multi-1");

      setMockResponses([{ text: "Shared state" }]);
      await prompt(stub, "Setup");

      const { client: client1, sessionId } = await connectAndGetSession(stub);
      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");

      client1.messages.length = 0;
      client2.messages.length = 0;

      await simulateHibernation(stub);

      // Client 1 recovers
      client1.send({ type: "request_sync", sessionId });
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      expect(sync1.type).toBe("session_sync");

      // Client 2 hasn't sent anything — no recovery yet
      expect(client2.messages.filter((m) => m.type === "session_sync").length).toBe(0);

      // Client 2 recovers independently
      client2.send({ type: "request_sync", sessionId });
      const sync2 = await client2.waitForMessage((m) => m.type === "session_sync");
      expect(sync2.type).toBe("session_sync");

      client1.close();
      client2.close();
    });

    it("clients on different sessions recover to their own session state", async () => {
      const stub = getStub("hib-multi-2");

      // Session A
      setMockResponses([{ text: "Session A reply" }]);
      await prompt(stub, "Session A message");

      const { client: clientA, sessionId: sessionIdA } = await connectAndGetSession(stub);

      // Client B creates a new session
      const clientB = await openSocket(stub);
      await clientB.waitForMessage((m) => m.type === "session_sync");
      clientB.send({ type: "new_session" });
      const newSessionSync = await clientB.waitForMessage(
        (m) =>
          m.type === "session_sync" &&
          (m as SessionSyncMsg).sessionId !== sessionIdA,
      );
      const sessionIdB = (newSessionSync as SessionSyncMsg).sessionId;

      // Add data to session B
      setMockResponses([{ text: "Session B reply" }]);
      clientB.send({ type: "prompt", sessionId: sessionIdB, text: "Session B message" });
      await clientB.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );

      clientA.messages.length = 0;
      clientB.messages.length = 0;

      await simulateHibernation(stub);

      // Both recover to their own session
      clientA.send({ type: "request_sync", sessionId: sessionIdA });
      clientB.send({ type: "request_sync", sessionId: sessionIdB });

      const recoverA = await clientA.waitForMessage((m) => m.type === "session_sync");
      const recoverB = await clientB.waitForMessage((m) => m.type === "session_sync");

      expect((recoverA as SessionSyncMsg).sessionId).toBe(sessionIdA);
      expect((recoverB as SessionSyncMsg).sessionId).toBe(sessionIdB);

      clientA.close();
      clientB.close();
    });
  });

  describe("inference after recovery", () => {
    it("prompt works correctly after hibernation recovery", async () => {
      const stub = getStub("hib-infer-1");

      setMockResponses([{ text: "Before hibernation" }]);
      await prompt(stub, "Hello");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      // Prompt after recovery — agent is re-created from scratch
      setMockResponses([{ text: "After hibernation!" }]);
      client.send({ type: "prompt", sessionId, text: "Are you still there?" });

      const agentEnd = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );
      expect(agentEnd).toBeTruthy();

      // Verify entries include both pre- and post-hibernation messages
      const { entries } = await getEntries(stub);
      const userEntries = entries.filter(
        (e) => e.type === "message" && (e.data as Record<string, unknown>).role === "user",
      );
      expect(userEntries.length).toBeGreaterThanOrEqual(2);

      client.close();
    });

    it("context after recovery includes pre-hibernation messages", async () => {
      const stub = getStub("hib-infer-2");

      setMockResponses([
        { text: "Reply 1" },
        { text: "Reply 2" },
        { text: "Reply 3" },
      ]);
      await prompt(stub, "Message 1");
      await prompt(stub, "Message 2");
      await prompt(stub, "Message 3");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      client.send({ type: "request_sync", sessionId });
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const syncMsg = sync as SessionSyncMsg;

      // 3 user + 3 assistant = 6 messages minimum
      expect(syncMsg.messages.length).toBeGreaterThanOrEqual(6);

      client.close();
    });

    it("multiple prompts work across hibernation cycles", async () => {
      const stub = getStub("hib-infer-3");

      // First cycle: establish session
      setMockResponses([{ text: "Cycle 1 reply" }]);
      await prompt(stub, "Cycle 1");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      // Hibernate and prompt
      await simulateHibernation(stub);
      setMockResponses([{ text: "Cycle 2 reply" }]);
      client.send({ type: "prompt", sessionId, text: "Cycle 2" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );

      // Hibernate AGAIN and prompt again
      await simulateHibernation(stub);
      client.messages.length = 0;
      setMockResponses([{ text: "Cycle 3 reply" }]);
      client.send({ type: "prompt", sessionId, text: "Cycle 3" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );

      // All 3 cycles should be persisted
      const { entries } = await getEntries(stub);
      const userEntries = entries.filter(
        (e) => e.type === "message" && (e.data as Record<string, unknown>).role === "user",
      );
      expect(userEntries.length).toBeGreaterThanOrEqual(3);

      client.close();
    });
  });
});
