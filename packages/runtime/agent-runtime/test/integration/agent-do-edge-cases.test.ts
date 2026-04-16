/**
 * AgentDO edge-case tests.
 *
 * Covers: compaction during inference, broadcast to dead connections,
 * compaction boundary correctness, and multi-client session sharing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCompactionOverrides,
  clearMockResponses,
  setCompactionOverride,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import { getEntries, getStub, openSocket, prompt } from "../helpers/ws-client.js";

// --- Tests ---

describe("AgentDO Edge Cases", () => {
  beforeEach(() => {
    clearMockResponses();
    clearCompactionOverrides();
  });

  // ====================================================
  // 1. Compaction during inference
  // ====================================================

  describe("1. Compaction during inference", () => {
    it("compaction triggers mid-conversation and agent receives compacted context", async () => {
      const stub = getStub("edge-compact-1");

      setCompactionOverride("edge-compact-1", {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      });

      // Fill session with messages ~120 tokens each (400 chars / 4 * 1.2)
      // Threshold = 0.5 * 500 = 250 tokens. 3+ messages should trigger.
      const responses = Array.from({ length: 5 }, (_, i) => ({
        text: `Response ${i}: ${"x".repeat(400)}`,
      }));
      setMockResponses(responses);

      for (let i = 0; i < 5; i++) {
        await prompt(stub, `Message ${i}: ${"y".repeat(400)}`);
      }

      // Verify compaction entry was created
      const { entries } = await getEntries(stub);
      const compactionEntries = entries.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(1);

      // The last prompt response should still work (agent got compacted context)
      const assistantEntries = entries.filter(
        (e: any) => e.type === "message" && e.data?.role === "assistant",
      );
      expect(assistantEntries.length).toBe(5);
    });

    it("context after compaction includes summary message", async () => {
      const stub = getStub("edge-compact-2");

      setCompactionOverride("edge-compact-2", {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      });

      // Fill to trigger compaction
      const responses = Array.from({ length: 4 }, (_, i) => ({
        text: `Response ${i}: ${"x".repeat(400)}`,
      }));
      // Add one more for the post-compaction prompt
      responses.push({ text: "Post-compaction response" });
      setMockResponses(responses);

      for (let i = 0; i < 4; i++) {
        await prompt(stub, `Message ${i}: ${"y".repeat(400)}`);
      }

      // Verify compaction happened
      const { entries: entriesBefore } = await getEntries(stub);
      const compactionEntries = entriesBefore.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(1);

      // Send one more prompt — its context should include the summary
      const result = await prompt(stub, "What happened?");
      const summaryMessage = result.messages.find(
        (m: any) =>
          typeof m.content === "string" && m.content.includes("[Previous conversation summary]"),
      );
      expect(summaryMessage).toBeTruthy();
    });

    it("multiple turns after compaction continue working correctly", async () => {
      const stub = getStub("edge-compact-3");

      setCompactionOverride("edge-compact-3", {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      });

      // Fill to trigger compaction
      const fillResponses = Array.from({ length: 4 }, (_, i) => ({
        text: `Fill ${i}: ${"x".repeat(400)}`,
      }));
      // 3 more turns after compaction
      const postResponses = [
        { text: "After compaction 1" },
        { text: "After compaction 2" },
        { text: "After compaction 3" },
      ];
      setMockResponses([...fillResponses, ...postResponses]);

      for (let i = 0; i < 4; i++) {
        await prompt(stub, `Fill ${i}: ${"y".repeat(400)}`);
      }

      // Post-compaction turns
      for (let i = 0; i < 3; i++) {
        const result = await prompt(stub, `Post ${i}`);
        // Each should return messages including the summary + recent context
        expect(result.messages.length).toBeGreaterThanOrEqual(2);
      }

      const { entries } = await getEntries(stub);
      const assistantEntries = entries.filter(
        (e: any) => e.type === "message" && e.data?.role === "assistant",
      );
      expect(assistantEntries.length).toBe(7); // 4 fill + 3 post
    });

    it("compaction entry has expected structure", async () => {
      const stub = getStub("edge-compact-4");

      setCompactionOverride("edge-compact-4", {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      });

      const responses = Array.from({ length: 4 }, (_, i) => ({
        text: `Response ${i}: ${"x".repeat(400)}`,
      }));
      setMockResponses(responses);

      for (let i = 0; i < 4; i++) {
        await prompt(stub, `Message ${i}: ${"y".repeat(400)}`);
      }

      const { entries } = await getEntries(stub);
      const compactionEntries = entries.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(1);

      const compaction = compactionEntries[0];
      expect(compaction.data.summary).toBeTruthy();
      expect(typeof compaction.data.summary).toBe("string");
      expect(compaction.data.firstKeptEntryId).toBeTruthy();
      expect(compaction.data.tokensBefore).toBeGreaterThan(0);
    });
  });

  // ====================================================
  // 2. Broadcast to dead connections
  // ====================================================

  describe("2. Broadcast to dead connections", () => {
    it("client disconnects mid-inference, remaining client still gets events", async () => {
      const stub = getStub("edge-broadcast-1");
      setMockResponses([{ text: "Delayed response", delay: 200 }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as any).sessionId;

      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");
      // Switch client2 to the same session
      client2.send({ type: "switch_session", sessionId });
      await client2.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      // Start inference from client1
      client1.send({ type: "prompt", sessionId, text: "Hello" });

      // Wait for streaming to start
      await client1.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_start",
      );

      // Close client1 mid-inference
      client1.close();

      // Client2 should still receive agent_end
      const end = await client2.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );
      expect(end).toBeTruthy();

      client2.close();
    });

    it("all clients disconnect mid-inference, inference completes without error", async () => {
      const stub = getStub("edge-broadcast-2");
      setMockResponses([{ text: "Lonely response", delay: 200 }]);

      const client = await openSocket(stub);
      const sync = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync as any).sessionId;

      // Start inference
      client.send({ type: "prompt", sessionId, text: "Hello" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_start",
      );

      // Disconnect all clients
      client.close();

      // Wait for inference to complete
      await new Promise((r) => setTimeout(r, 500));

      // Reconnect and verify entries were persisted
      const client2 = await openSocket(stub);
      client2.send({ type: "switch_session", sessionId });
      const sync2 = await client2.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      // session_sync should have persisted messages
      expect((sync2 as any).messages.length).toBeGreaterThanOrEqual(2);

      client2.close();
    });

    it("new client connects mid-inference, gets streamMessage in sync", async () => {
      const stub = getStub("edge-broadcast-3");
      setMockResponses([{ text: "Streaming response...", delay: 300 }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as any).sessionId;

      // Start inference
      client1.send({ type: "prompt", sessionId, text: "Stream this" });
      await client1.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "message_start",
      );

      // Connect client2 mid-stream
      const client2 = await openSocket(stub);
      const sync2 = await client2.waitForMessage((m) => m.type === "session_sync");

      // The initial sync for a new connection should include streamMessage
      // when the default session is actively streaming
      expect((sync2 as any).streamMessage).not.toBeNull();

      // Wait for inference to complete
      await client1.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );

      client1.close();
      client2.close();
    });
  });

  // ====================================================
  // 3. Compaction boundary correctness
  // ====================================================

  describe("3. Compaction boundary correctness", () => {
    it("buildContext after compaction returns summary + kept entries only", async () => {
      const stub = getStub("edge-boundary-1");

      setCompactionOverride("edge-boundary-1", {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      });

      // Fill with enough messages to trigger compaction
      const responses = Array.from({ length: 5 }, (_, i) => ({
        text: `Response ${i}: ${"x".repeat(400)}`,
      }));
      // One more for the post-compaction query
      responses.push({ text: "After boundary" });
      setMockResponses(responses);

      for (let i = 0; i < 5; i++) {
        await prompt(stub, `Message ${i}: ${"y".repeat(400)}`);
      }

      // Verify compaction happened
      const { entries } = await getEntries(stub);
      const compactionEntries = entries.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(1);

      // Total message entries (user + assistant) should be 10
      const messageEntries = entries.filter((e: any) => e.type === "message");
      expect(messageEntries.length).toBe(10);

      // But the context returned to the agent should be trimmed
      const result = await prompt(stub, "After compaction");
      // Context should have: summary (user msg) + kept recent msgs + new user msg
      // It should NOT have all 10 original messages
      const hasSummary = result.messages.some(
        (m: any) =>
          typeof m.content === "string" && m.content.includes("[Previous conversation summary]"),
      );
      expect(hasSummary).toBe(true);
      // The context should be smaller than all 12 messages (10 original + 1 new user + 1 new assistant)
      expect(result.messages.length).toBeLessThan(12);
    });

    it("multiple compactions: latest summary used, old entries excluded", async () => {
      const stub = getStub("edge-boundary-2");

      setCompactionOverride("edge-boundary-2", {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      });

      // First batch: trigger first compaction
      const batch1 = Array.from({ length: 4 }, (_, i) => ({
        text: `Batch1-${i}: ${"x".repeat(400)}`,
      }));
      // Second batch: trigger second compaction
      const batch2 = Array.from({ length: 4 }, (_, i) => ({
        text: `Batch2-${i}: ${"z".repeat(400)}`,
      }));
      // Final query
      const finalResponse = [{ text: "Final response" }];
      setMockResponses([...batch1, ...batch2, ...finalResponse]);

      // First batch
      for (let i = 0; i < 4; i++) {
        await prompt(stub, `Batch1-${i}: ${"y".repeat(400)}`);
      }

      // Verify first compaction
      let { entries } = await getEntries(stub);
      let compactionEntries = entries.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(1);

      // Second batch — should trigger another compaction
      for (let i = 0; i < 4; i++) {
        await prompt(stub, `Batch2-${i}: ${"w".repeat(400)}`);
      }

      // Verify second compaction
      ({ entries } = await getEntries(stub));
      compactionEntries = entries.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(2);

      // Final query — context should use latest compaction only
      const result = await prompt(stub, "What now?");
      const hasSummary = result.messages.some(
        (m: any) =>
          typeof m.content === "string" && m.content.includes("[Previous conversation summary]"),
      );
      expect(hasSummary).toBe(true);
      // Context should be much smaller than all 16 original messages + 1 new
      expect(result.messages.length).toBeLessThan(16);
    });

    it("compaction with tool results: tool results after boundary preserved", async () => {
      const stub = getStub("edge-boundary-3");

      setCompactionOverride("edge-boundary-3", {
        threshold: 0.5,
        contextWindowTokens: 800,
        keepRecentTokens: 200,
      });

      // Fill session with some messages first
      const fillResponses = Array.from({ length: 3 }, (_, i) => ({
        text: `Fill ${i}: ${"x".repeat(400)}`,
      }));
      // Then a tool call turn
      const toolResponse = {
        text: "",
        toolCalls: [{ name: "echo", args: { text: "tool-test" } }],
      };
      const followUp = { text: "The echo said: tool-test" };
      // More fill to push past threshold
      const moreFill = Array.from({ length: 3 }, (_, i) => ({
        text: `More ${i}: ${"z".repeat(400)}`,
      }));
      // Final query
      const finalResp = [{ text: "Final" }];
      setMockResponses([...fillResponses, toolResponse, followUp, ...moreFill, ...finalResp]);

      for (let i = 0; i < 3; i++) {
        await prompt(stub, `Fill ${i}: ${"y".repeat(400)}`);
      }
      // Tool call turn
      await prompt(stub, "Echo something");
      // More fill
      for (let i = 0; i < 3; i++) {
        await prompt(stub, `More ${i}: ${"w".repeat(400)}`);
      }

      // Verify compaction happened
      const { entries } = await getEntries(stub);
      const compactionEntries = entries.filter((e: any) => e.type === "compaction");
      expect(compactionEntries.length).toBeGreaterThanOrEqual(1);

      // Verify tool result entries exist in the full log
      const toolResults = entries.filter(
        (e: any) => e.type === "message" && e.data?.role === "toolResult",
      );
      expect(toolResults.length).toBeGreaterThanOrEqual(1);

      // Final query — should still work with compacted context
      const result = await prompt(stub, "Final question");
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ====================================================
  // 4. Multi-client session sharing
  // ====================================================

  describe("4. Multi-client session sharing", () => {
    it("three clients on same session all receive agent_end", async () => {
      const stub = getStub("edge-multi-1");
      setMockResponses([{ text: "Shared response" }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as any).sessionId;

      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");
      // client2 connects with its own default session initially; switch it
      client2.send({ type: "switch_session", sessionId });
      await client2.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      const client3 = await openSocket(stub);
      await client3.waitForMessage((m) => m.type === "session_sync");
      client3.send({ type: "switch_session", sessionId });
      await client3.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      // Prompt from client1
      client1.send({ type: "prompt", sessionId, text: "Hello all" });

      // All three should get agent_end
      const isAgentEnd = (m: ServerMessage) =>
        m.type === "agent_event" && (m as any).event?.type === "agent_end";

      const [end1, end2, end3] = await Promise.all([
        client1.waitForMessage(isAgentEnd),
        client2.waitForMessage(isAgentEnd),
        client3.waitForMessage(isAgentEnd),
      ]);

      expect(end1).toBeTruthy();
      expect(end2).toBeTruthy();
      expect(end3).toBeTruthy();

      client1.close();
      client2.close();
      client3.close();
    });

    it("client joins session late, gets session_sync with history", async () => {
      const stub = getStub("edge-multi-2");
      setMockResponses([{ text: "First response" }]);

      const client1 = await openSocket(stub);
      const sync1 = await client1.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as any).sessionId;

      // Client1 prompts and waits for response
      client1.send({ type: "prompt", sessionId, text: "Hello" });
      await client1.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );

      // Client2 connects now (late)
      const client2 = await openSocket(stub);
      // The new client may get assigned a new default session, switch to the one with history
      client2.send({ type: "switch_session", sessionId });
      const sync2 = await client2.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      // sync2 should have the conversation history
      const messages = (sync2 as any).messages;
      expect(messages.length).toBeGreaterThanOrEqual(2);

      // Should include the user message and assistant response
      const roles = messages.map((m: any) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");

      client1.close();
      client2.close();
    });

    it("client switches session, stops receiving events from old session", async () => {
      const stub = getStub("edge-multi-3");
      setMockResponses([{ text: "Response for S1", delay: 100 }]);

      const clientA = await openSocket(stub);
      const syncA = await clientA.waitForMessage((m) => m.type === "session_sync");
      const sessionS1 = (syncA as any).sessionId;

      const clientB = await openSocket(stub);
      await clientB.waitForMessage((m) => m.type === "session_sync");
      // Put clientB on S1
      clientB.send({ type: "switch_session", sessionId: sessionS1 });
      await clientB.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionS1,
      );

      // Create S2 and switch clientB to it
      clientB.send({ type: "new_session", name: "Session S2" });
      const syncS2 = await clientB.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId !== sessionS1,
      );
      const _sessionS2 = (syncS2 as any).sessionId;

      // Clear clientB messages for clean tracking
      clientB.messages.length = 0;

      // Prompt S1 from clientA
      clientA.send({ type: "prompt", sessionId: sessionS1, text: "Only for S1" });
      await clientA.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );

      // Wait a bit to ensure no straggler messages
      await new Promise((r) => setTimeout(r, 200));

      // clientB (on S2) should NOT have received agent_events for S1
      const clientBAgentEvents = clientB.messages.filter((m) => m.type === "agent_event");
      expect(clientBAgentEvents.length).toBe(0);

      clientA.close();
      clientB.close();
    });

    it("request_sync re-sends current session state", async () => {
      const stub = getStub("edge-multi-4");
      setMockResponses([{ text: "Existing response" }]);

      const client = await openSocket(stub);
      const sync1 = await client.waitForMessage((m) => m.type === "session_sync");
      const sessionId = (sync1 as any).sessionId;

      // Add some history
      client.send({ type: "prompt", sessionId, text: "Hello" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );

      // Clear messages
      client.messages.length = 0;

      // Request a fresh sync
      client.send({ type: "request_sync", sessionId });
      const resync = await client.waitForMessage(
        (m) => m.type === "session_sync" && (m as any).sessionId === sessionId,
      );

      // Should include the conversation messages
      expect((resync as any).messages.length).toBeGreaterThanOrEqual(2);

      client.close();
    });
  });
});
