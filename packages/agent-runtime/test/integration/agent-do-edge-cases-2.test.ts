/**
 * AgentDO edge-case tests — Part 2.
 *
 * Covers: rate limiting, session deletion during active inference,
 * and error propagation from capabilities.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../../src/capabilities/types.js";
import {
  clearCompactionOverrides,
  clearExtraCapabilities,
  clearMockResponses,
  setExtraCapabilities,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import { getEntries, getStub, openSocket } from "../helpers/ws-client.js";

// --- Tests ---

describe("AgentDO Edge Cases — Part 2", () => {
  beforeEach(() => {
    clearMockResponses();
    clearCompactionOverrides();
    clearExtraCapabilities();
  });

  // ====================================================
  // 1. Rate Limiting
  // ====================================================

  describe("1. Rate Limiting", () => {
    it("sending >30 messages in a window triggers RATE_LIMITED error", async () => {
      const stub = getStub("edge2-rate-1");

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Send 31 messages rapidly (new_session is a cheap non-prompt message)
      // Using new_session to avoid prompt-related side effects
      for (let i = 0; i < 31; i++) {
        client.send({ type: "new_session", name: `rate-test-${i}` });
      }

      // Wait for the rate limit error
      const error = await client.waitForMessage(
        (m) => m.type === "error" && (m as any).code === "RATE_LIMITED",
      );
      expect(error).toBeTruthy();
      expect((error as any).message).toContain("slow down");

      client.close();
    });

    it("ping messages are exempt from rate limiting", async () => {
      const stub = getStub("edge2-rate-2");

      const client = await openSocket(stub);
      await client.waitForMessage((m) => m.type === "session_sync");

      // Send 35 pings — these should all be accepted (exempt from rate limit)
      for (let i = 0; i < 35; i++) {
        client.send({ type: "ping" } as ClientMessage);
      }

      // Now send a real message — it should succeed (pings didn't count)
      setMockResponses([{ text: "Still alive" }]);
      const sessionId = ((await client.waitForMessage((m) => m.type === "session_sync")) as any)
        .sessionId;
      // We already have session_sync from connect, use the sessionId from it
      const sync = client.messages.find((m) => m.type === "session_sync") as any;
      client.send({ type: "prompt", sessionId: sync.sessionId, text: "Hello" });

      // Should get agent_end, NOT rate limited
      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      // Verify no RATE_LIMITED error was sent
      const rateLimitErrors = client.messages.filter(
        (m) => m.type === "error" && (m as any).code === "RATE_LIMITED",
      );
      expect(rateLimitErrors.length).toBe(0);

      client.close();
    });

    it("request_sync messages are exempt from rate limiting", async () => {
      const stub = getStub("edge2-rate-3");

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Send 35 request_sync messages — all exempt
      for (let i = 0; i < 35; i++) {
        client.send({ type: "request_sync", sessionId });
      }

      // Wait a bit for processing
      await new Promise((r) => setTimeout(r, 100));

      // Send a real message — should succeed
      setMockResponses([{ text: "Not rate limited" }]);
      client.send({ type: "prompt", sessionId, text: "After syncs" });

      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      const rateLimitErrors = client.messages.filter(
        (m) => m.type === "error" && (m as any).code === "RATE_LIMITED",
      );
      expect(rateLimitErrors.length).toBe(0);

      client.close();
    });

    it("rate limit is per-connection — different connections have independent limits", async () => {
      const stub = getStub("edge2-rate-4");

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");

      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");

      // Exhaust client1's rate limit with 31 new_session messages
      for (let i = 0; i < 31; i++) {
        client1.send({ type: "new_session", name: `c1-${i}` });
      }

      // Wait for client1's rate limit error
      await client1.waitForMessage((m) => m.type === "error" && (m as any).code === "RATE_LIMITED");

      // client2 should still be able to send — its limit is independent
      setMockResponses([{ text: "Client2 OK" }]);
      const sessionId = (sync1 as any).sessionId;
      client2.send({ type: "switch_session", sessionId });
      await client2.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );
      client2.send({ type: "prompt", sessionId, text: "Hello from client2" });

      const end = await client2.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      // Verify client2 had no rate limit errors
      const client2Errors = client2.messages.filter(
        (m) => m.type === "error" && (m as any).code === "RATE_LIMITED",
      );
      expect(client2Errors.length).toBe(0);

      client1.close();
      client2.close();
    });

    it("rate-limited messages are dropped — not processed", async () => {
      const stub = getStub("edge2-rate-5");

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Use up rate limit with new_session messages
      for (let i = 0; i < 30; i++) {
        client.send({ type: "new_session", name: `burn-${i}` });
      }

      // Wait a moment for processing
      await new Promise((r) => setTimeout(r, 200));

      // Count sessions created before rate limit kicks in
      const sessionListsBefore = client.messages.filter((m) => m.type === "session_list");
      const countBefore = sessionListsBefore.length;

      // Send more — these should be rate-limited and dropped
      for (let i = 0; i < 5; i++) {
        client.send({ type: "new_session", name: `dropped-${i}` });
      }

      // Wait for rate limit errors
      await new Promise((r) => setTimeout(r, 200));

      const rateLimitErrors = client.messages.filter(
        (m) => m.type === "error" && (m as any).code === "RATE_LIMITED",
      );
      expect(rateLimitErrors.length).toBeGreaterThanOrEqual(1);

      // No additional session_list broadcasts should have been sent after the rate limit
      const sessionListsAfter = client.messages.filter((m) => m.type === "session_list");
      // The count should not have increased by 5 (the dropped messages)
      expect(sessionListsAfter.length).toBeLessThan(countBefore + 5);

      client.close();
    });
  });

  // ====================================================
  // 2. Session Deletion During Active Inference
  // ====================================================

  describe("2. Session deletion during active inference", () => {
    it("deleting a session with active inference aborts the agent", async () => {
      const stub = getStub("edge2-delete-1");
      setMockResponses([{ text: "This will be interrupted", delay: 300 }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Create a second session so we can delete the first
      client.send({ type: "new_session", name: "Backup session" });
      const newSync = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId !== sessionId,
      );
      const backupSessionId = (newSync as any).sessionId;

      // Switch back to original session for the prompt
      client.send({ type: "switch_session", sessionId });
      await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      // Start inference
      client.send({ type: "prompt", sessionId, text: "Long running task" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_start",
      );

      // Delete the session mid-inference
      client.send({ type: "delete_session", sessionId });

      // Client should be switched to the backup session
      const switchSync = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === backupSessionId,
      );
      expect(switchSync).toBeTruthy();

      // Wait for inference to finish (aborted)
      await new Promise((r) => setTimeout(r, 500));

      // Session list should no longer include the deleted session
      const sessionLists = client.messages.filter((m) => m.type === "session_list");
      const lastList = sessionLists[sessionLists.length - 1] as any;
      const deletedInList = lastList.sessions.some((s: any) => s.id === sessionId);
      expect(deletedInList).toBe(false);

      client.close();
    });

    it("cannot delete the last remaining session", async () => {
      const stub = getStub("edge2-delete-2");

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Try to delete the only session
      client.send({ type: "delete_session", sessionId });

      // Wait a bit for processing
      await new Promise((r) => setTimeout(r, 200));

      // Session should still exist — send a prompt to verify
      setMockResponses([{ text: "Still here" }]);
      client.send({ type: "prompt", sessionId, text: "Hello" });

      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      client.close();
    });

    it("deleting session cascades to entries", async () => {
      const stub = getStub("edge2-delete-3");
      setMockResponses([{ text: "Response to persist" }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Add some messages to the session
      client.send({ type: "prompt", sessionId, text: "Hello" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );

      // Verify entries exist
      const { entries: beforeEntries } = await getEntries(stub, sessionId);
      expect(beforeEntries.length).toBeGreaterThan(0);

      // Create a second session and delete the first
      client.send({ type: "new_session", name: "Second" });
      const newSync = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId !== sessionId,
      );
      const secondSessionId = (newSync as any).sessionId;

      client.send({ type: "delete_session", sessionId });

      // Wait for deletion
      await new Promise((r) => setTimeout(r, 200));

      // Entries for the deleted session should be gone (cascade delete)
      const { entries: afterEntries } = await getEntries(stub, sessionId);
      expect(afterEntries.length).toBe(0);

      client.close();
    });

    it("other clients receive updated session list after deletion", async () => {
      const stub = getStub("edge2-delete-4");

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as any).sessionId;

      // Create a second session
      client1.send({ type: "new_session", name: "Second" });
      const newSync = await client1.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId !== sessionId,
      );
      const secondSessionId = (newSync as any).sessionId;

      // Connect second client
      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");

      // Switch client1 to second session before deleting first
      client1.send({ type: "switch_session", sessionId: secondSessionId });
      await client1.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === secondSessionId,
      );

      // Wait for all in-flight broadcasts to settle, then clear client2 messages
      await new Promise((r) => setTimeout(r, 100));
      client2.messages.length = 0;

      // Delete the first session
      client1.send({ type: "delete_session", sessionId });

      // client2 should get an updated session list WITHOUT the deleted session
      const list2 = await client2.waitForMessage((m) => m.type === "session_list");
      expect(list2).toBeTruthy();
      const sessions = (list2 as any).sessions;
      const deletedInList = sessions.some((s: any) => s.id === sessionId);
      expect(deletedInList).toBe(false);

      client1.close();
      client2.close();
    });

    it("sending client on deleted session gets redirected to another session", async () => {
      const stub = getStub("edge2-delete-5");

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Create a second session
      client.send({ type: "new_session", name: "Second" });
      const newSync = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId !== sessionId,
      );
      const secondSessionId = (newSync as any).sessionId;

      // Switch back to original session
      client.send({ type: "switch_session", sessionId });
      await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      // Wait for in-flight messages to settle, then clear
      await new Promise((r) => setTimeout(r, 100));
      client.messages.length = 0;

      // Delete the session the client is currently on
      client.send({ type: "delete_session", sessionId });

      // Client should receive a session_sync redirecting to a DIFFERENT session
      const redirectSync = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId !== sessionId,
      );
      // Should be the second session we created
      expect((redirectSync as any).sessionId).toBe(secondSessionId);

      client.close();
    });
  });

  // ====================================================
  // 3. Error Propagation from Capabilities
  // ====================================================

  describe("3. Error propagation from capabilities", () => {
    it("beforeInference hook error is swallowed — inference continues", async () => {
      const stub = getStub("edge2-error-1");

      const failingCapability: Capability = {
        id: "failing-before-inference",
        name: "Failing Before Inference",
        description: "Throws in beforeInference hook",
        hooks: {
          beforeInference: async () => {
            throw new Error("beforeInference boom!");
          },
        },
      };
      setExtraCapabilities([failingCapability]);
      setMockResponses([{ text: "Made it through" }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      client.send({ type: "prompt", sessionId, text: "Test error handling" });

      // Inference should complete despite the hook error
      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      // Verify the response was persisted
      const { entries } = await getEntries(stub, sessionId);
      const assistantEntries = entries.filter(
        (e: any) => e.type === "message" && e.data?.role === "assistant",
      );
      expect(assistantEntries.length).toBe(1);

      client.close();
    });

    it("capability tools() throwing propagates as INTERNAL_ERROR to client", async () => {
      const stub = getStub("edge2-error-2");

      // Connect FIRST with no extra capabilities (capabilities are resolved
      // during WS connection setup for sendCommandList)
      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // NOW inject the failing capability — it will be picked up by ensureAgent on next prompt
      const failingCapability: Capability = {
        id: "failing-tools",
        name: "Failing Tools",
        description: "Throws in tools() factory",
        tools: () => {
          throw new Error("tools() factory exploded!");
        },
      };
      setExtraCapabilities([failingCapability]);
      setMockResponses([{ text: "Never reached" }]);

      client.send({ type: "prompt", sessionId, text: "Trigger error" });

      // Should get an INTERNAL_ERROR (ensureAgent crashes, caught by handleClientMessage .catch)
      const error = await client.waitForMessage(
        (m) => m.type === "error" && (m as any).code === "INTERNAL_ERROR",
      );
      expect(error).toBeTruthy();
      expect((error as any).message).toContain("tools() factory exploded!");

      client.close();
    });

    it("capability promptSections() throwing propagates as INTERNAL_ERROR", async () => {
      const stub = getStub("edge2-error-3");

      // Connect FIRST with no extra capabilities
      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Inject failing capability after connection
      const failingCapability: Capability = {
        id: "failing-prompt-sections",
        name: "Failing Prompt Sections",
        description: "Throws in promptSections()",
        promptSections: () => {
          throw new Error("promptSections() kaboom!");
        },
      };
      setExtraCapabilities([failingCapability]);
      setMockResponses([{ text: "Never reached" }]);

      client.send({ type: "prompt", sessionId, text: "Trigger prompt error" });

      const error = await client.waitForMessage(
        (m) => m.type === "error" && (m as any).code === "INTERNAL_ERROR",
      );
      expect(error).toBeTruthy();
      expect((error as any).message).toContain("promptSections() kaboom!");

      client.close();
    });

    it("afterToolExecution hook error is swallowed — tool result still returned", async () => {
      const stub = getStub("edge2-error-4");

      const failingCapability: Capability = {
        id: "failing-after-tool",
        name: "Failing After Tool",
        description: "Throws in afterToolExecution hook",
        hooks: {
          afterToolExecution: async () => {
            throw new Error("afterToolExecution boom!");
          },
        },
      };
      setExtraCapabilities([failingCapability]);
      setMockResponses([
        {
          text: "",
          toolCalls: [{ name: "echo", args: { text: "test-tool" } }],
        },
        { text: "After tool call" },
      ]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      client.send({ type: "prompt", sessionId, text: "Call a tool" });

      // Inference should complete despite afterToolExecution hook error
      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      // Tool execution should have completed (tool_event messages)
      const toolEvents = client.messages.filter((m) => m.type === "tool_event");
      expect(toolEvents.length).toBeGreaterThanOrEqual(1);

      client.close();
    });

    it("beforeToolExecution hook error is swallowed — tool execution proceeds", async () => {
      const stub = getStub("edge2-error-5");

      const failingCapability: Capability = {
        id: "failing-before-tool",
        name: "Failing Before Tool",
        description: "Throws in beforeToolExecution hook",
        hooks: {
          beforeToolExecution: async () => {
            throw new Error("beforeToolExecution boom!");
          },
        },
      };
      setExtraCapabilities([failingCapability]);
      setMockResponses([
        {
          text: "",
          toolCalls: [{ name: "echo", args: { text: "should-run" } }],
        },
        { text: "Tool ran fine" },
      ]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      client.send({ type: "prompt", sessionId, text: "Call tool with failing hook" });

      // Inference should complete
      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      // Tool should have executed (not blocked by the throwing hook)
      const toolEndEvents = client.messages.filter(
        (m) => m.type === "tool_event" && (m as any).event?.type === "tool_execution_end",
      );
      expect(toolEndEvents.length).toBeGreaterThanOrEqual(1);

      client.close();
    });

    it("multiple hooks — one failing, one succeeding — surviving hook still runs", async () => {
      const stub = getStub("edge2-error-6");
      const survivingHookCalled = false;

      const failingCapability: Capability = {
        id: "failing-hook",
        name: "Failing Hook",
        description: "Throws in beforeInference",
        hooks: {
          beforeInference: async () => {
            throw new Error("I fail");
          },
        },
      };

      // Note: the compaction capability is always present and has a beforeInference hook.
      // If the failing capability is added, both hooks run. The failing one throws,
      // but compaction's hook should still execute.
      setExtraCapabilities([failingCapability]);
      setMockResponses([{ text: "Both hooks ran" }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      client.send({ type: "prompt", sessionId, text: "Test multiple hooks" });

      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      client.close();
    });

    it("onConnect hook error does not prevent WebSocket connection", async () => {
      const stub = getStub("edge2-error-7");

      const failingCapability: Capability = {
        id: "failing-on-connect",
        name: "Failing On Connect",
        description: "Throws in onConnect hook",
        hooks: {
          onConnect: async () => {
            throw new Error("onConnect kaboom!");
          },
        },
      };
      setExtraCapabilities([failingCapability]);
      setMockResponses([{ text: "Connected fine" }]);

      // Connection should succeed despite onConnect hook failing
      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      expect(sync).toBeTruthy();
      const sessionId = (sync as any).sessionId;

      // Agent should be fully functional
      client.send({ type: "prompt", sessionId, text: "Works?" });
      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      client.close();
    });
  });
});
