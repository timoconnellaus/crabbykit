/**
 * Tests for capability onConnect hook reconciliation after hibernation.
 *
 * Verifies that onConnect hooks:
 * - Fire exactly once per connection recovery (not on every subsequent message)
 * - Receive correct sessionId context
 * - Fire independently for each connection
 * - Don't block message processing when they throw
 * - Have access to capability-scoped storage
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Capability, CapabilityHookContext } from "../../src/capabilities/types.js";
import {
  clearExtraCapabilities,
  clearMockResponses,
  setExtraCapabilities,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import type { ServerMessage } from "../../src/transport/types.js";
import {
  connectAndGetSession,
  getStub,
  openSocket,
  prompt,
  simulateHibernation,
} from "../helpers/ws-client.js";

type SessionSyncMsg = Extract<ServerMessage, { type: "session_sync" }>;
type AgentEventMsg = Extract<ServerMessage, { type: "agent_event" }>;
type CustomEventMsg = Extract<ServerMessage, { type: "custom_event" }>;

/**
 * Create a capability that broadcasts a custom event from its onConnect hook,
 * letting tests observe when and how many times the hook fires.
 */
function createOnConnectTrackerCapability(eventName = "onconnect_fired"): Capability {
  return {
    id: "onconnect-tracker",
    name: "OnConnect Tracker",
    description: "Tracks onConnect hook invocations via custom events",
    hooks: {
      onConnect: async (ctx: CapabilityHookContext) => {
        ctx.broadcast(eventName, { sessionId: ctx.sessionId, timestamp: Date.now() });
      },
    },
  };
}

describe("Hibernation — onConnect hook reconciliation", () => {
  beforeEach(() => {
    clearMockResponses();
    clearExtraCapabilities();
  });

  describe("hook fires on recovery", () => {
    it("onConnect hook fires with correct sessionId after hibernation + request_sync", async () => {
      setExtraCapabilities([createOnConnectTrackerCapability()]);

      const stub = getStub("hib-onconn-1");

      setMockResponses([{ text: "Before hibernation" }]);
      await prompt(stub, "Hello");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      // request_sync triggers recovery — onConnect hook should fire
      client.send({ type: "request_sync", sessionId });

      const event = await client.waitForMessage(
        (m) => m.type === "custom_event" && (m as CustomEventMsg).event.name === "onconnect_fired",
      );
      const data = (event as CustomEventMsg).event.data as { sessionId: string };
      expect(data.sessionId).toBe(sessionId);

      client.close();
    });

    it("onConnect hook fires after hibernation + prompt", async () => {
      setExtraCapabilities([createOnConnectTrackerCapability()]);

      const stub = getStub("hib-onconn-2");

      setMockResponses([{ text: "Pre" }]);
      await prompt(stub, "Setup");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      // Prompt triggers recovery — onConnect hook should fire
      setMockResponses([{ text: "Post" }]);
      client.send({ type: "prompt", sessionId, text: "After wake" });

      const event = await client.waitForMessage(
        (m) => m.type === "custom_event" && (m as CustomEventMsg).event.name === "onconnect_fired",
      );
      const data = (event as CustomEventMsg).event.data as { sessionId: string };
      expect(data.sessionId).toBe(sessionId);

      // Inference should also complete
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );

      client.close();
    });
  });

  describe("hook fires exactly once per recovery", () => {
    it("consecutive prompts after hibernation fire onConnect only once", async () => {
      let hookCallCount = 0;
      const countingCapability: Capability = {
        id: "onconnect-counter",
        name: "OnConnect Counter",
        description: "Counts onConnect invocations",
        hooks: {
          onConnect: async (ctx: CapabilityHookContext) => {
            hookCallCount++;
            ctx.broadcast("onconnect_count", { count: hookCallCount });
          },
        },
      };
      setExtraCapabilities([countingCapability]);

      const stub = getStub("hib-onconn-3");

      setMockResponses([{ text: "Setup" }]);
      await prompt(stub, "Setup");

      const { client, sessionId } = await connectAndGetSession(stub);

      // Record hook count from initial connection
      await new Promise((r) => setTimeout(r, 100));
      const countBeforeHibernation = hookCallCount;

      await simulateHibernation(stub);
      client.messages.length = 0;

      // First prompt after recovery
      setMockResponses([{ text: "Reply 1" }, { text: "Reply 2" }]);
      client.send({ type: "prompt", sessionId, text: "Prompt 1" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );

      // Second prompt — should NOT re-fire onConnect
      client.send({ type: "prompt", sessionId, text: "Prompt 2" });
      await client.waitForMessage(
        (m) =>
          m.type === "agent_event" &&
          (m as AgentEventMsg).event.type === "agent_end" &&
          // Wait for the second agent_end
          client.messages.filter(
            (x) => x.type === "agent_event" && (x as AgentEventMsg).event.type === "agent_end",
          ).length >= 2,
      );

      // onConnect should have fired exactly once after hibernation
      const hookCallsAfterHibernation = hookCallCount - countBeforeHibernation;
      expect(hookCallsAfterHibernation).toBe(1);

      client.close();
    });

    it("request_sync then prompt after hibernation fires onConnect only once", async () => {
      let hookCallCount = 0;
      const countingCapability: Capability = {
        id: "onconnect-counter-2",
        name: "OnConnect Counter 2",
        description: "Counts onConnect invocations",
        hooks: {
          onConnect: async (ctx: CapabilityHookContext) => {
            hookCallCount++;
            ctx.broadcast("onconnect_count", { count: hookCallCount });
          },
        },
      };
      setExtraCapabilities([countingCapability]);

      const stub = getStub("hib-onconn-4");

      setMockResponses([{ text: "Setup" }]);
      await prompt(stub, "Setup");

      const { client, sessionId } = await connectAndGetSession(stub);
      await new Promise((r) => setTimeout(r, 100));
      const countBefore = hookCallCount;

      await simulateHibernation(stub);
      client.messages.length = 0;

      // request_sync triggers recovery
      client.send({ type: "request_sync", sessionId });
      await client.waitForMessage((m) => m.type === "session_sync");

      // prompt should NOT re-fire onConnect
      setMockResponses([{ text: "Reply" }]);
      client.send({ type: "prompt", sessionId, text: "Hello" });
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );

      const hookCallsAfter = hookCallCount - countBefore;
      expect(hookCallsAfter).toBe(1);

      client.close();
    });
  });

  describe("independent per-connection recovery", () => {
    it("two clients on same session each get onConnect once after hibernation", async () => {
      setExtraCapabilities([createOnConnectTrackerCapability()]);

      const stub = getStub("hib-onconn-5");

      setMockResponses([{ text: "Setup" }]);
      await prompt(stub, "Setup");

      const { client: client1, sessionId } = await connectAndGetSession(stub);
      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");

      client1.messages.length = 0;
      client2.messages.length = 0;

      await simulateHibernation(stub);

      // Client 1 recovers
      client1.send({ type: "request_sync", sessionId });
      const event1 = await client1.waitForMessage(
        (m) => m.type === "custom_event" && (m as CustomEventMsg).event.name === "onconnect_fired",
      );
      expect(event1).toBeTruthy();

      // Client 2 should NOT have received the onConnect event yet
      // (hooks broadcast to the session, so it might have received it if client2 was already recovered)
      // But client2 should get its OWN recovery when it sends a message
      client2.messages.length = 0;

      client2.send({ type: "request_sync", sessionId });
      const event2 = await client2.waitForMessage(
        (m) => m.type === "custom_event" && (m as CustomEventMsg).event.name === "onconnect_fired",
      );
      expect(event2).toBeTruthy();

      client1.close();
      client2.close();
    });
  });

  describe("error resilience", () => {
    it("throwing onConnect hook does not block message processing", async () => {
      const failingCapability: Capability = {
        id: "failing-onconnect",
        name: "Failing OnConnect",
        description: "Throws in onConnect",
        hooks: {
          onConnect: async () => {
            throw new Error("onConnect boom");
          },
        },
      };
      setExtraCapabilities([failingCapability]);

      const stub = getStub("hib-onconn-6");

      setMockResponses([{ text: "Before" }]);
      await prompt(stub, "Setup");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      // Prompt should still work despite failing onConnect hook
      setMockResponses([{ text: "After recovery" }]);
      client.send({ type: "prompt", sessionId, text: "Works?" });

      const end = await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as AgentEventMsg).event.type === "agent_end",
      );
      expect(end).toBeTruthy();

      client.close();
    });

    it("failing hook does not prevent other hooks from running", async () => {
      const failingCapability: Capability = {
        id: "failing-onconnect-2",
        name: "Failing OnConnect 2",
        description: "Throws in onConnect",
        hooks: {
          onConnect: async () => {
            throw new Error("first hook fails");
          },
        },
      };
      const trackerCapability = createOnConnectTrackerCapability("second_hook_fired");
      setExtraCapabilities([failingCapability, trackerCapability]);

      const stub = getStub("hib-onconn-7");

      setMockResponses([{ text: "Setup" }]);
      await prompt(stub, "Setup");

      const { client, sessionId } = await connectAndGetSession(stub);
      client.messages.length = 0;

      await simulateHibernation(stub);

      client.send({ type: "request_sync", sessionId });

      // Second hook should still fire despite first one throwing
      const event = await client.waitForMessage(
        (m) => m.type === "custom_event" && (m as CustomEventMsg).event.name === "second_hook_fired",
      );
      expect(event).toBeTruthy();

      client.close();
    });
  });

  describe("storage access", () => {
    it("onConnect hook can read/write capability storage after hibernation", async () => {
      const storageCapability: Capability = {
        id: "storage-onconnect",
        name: "Storage OnConnect",
        description: "Uses storage in onConnect hook",
        hooks: {
          onConnect: async (ctx: CapabilityHookContext) => {
            // Read previous count
            const prev = await ctx.storage.get("connect_count");
            const count = prev ? Number(prev) + 1 : 1;
            await ctx.storage.put("connect_count", String(count));
            ctx.broadcast("storage_onconnect", { count });
          },
        },
      };
      setExtraCapabilities([storageCapability]);

      const stub = getStub("hib-onconn-8");

      setMockResponses([{ text: "Setup" }]);
      await prompt(stub, "Setup");

      // First connect — hook fires, count=1
      const { client, sessionId } = await connectAndGetSession(stub);
      await client.waitForMessage(
        (m) => m.type === "custom_event" && (m as CustomEventMsg).event.name === "storage_onconnect",
      );

      client.messages.length = 0;
      await simulateHibernation(stub);

      // Recovery — hook fires again, count should be 2 (persisted across hibernation)
      client.send({ type: "request_sync", sessionId });
      const event = await client.waitForMessage(
        (m) => m.type === "custom_event" && (m as CustomEventMsg).event.name === "storage_onconnect",
      );
      const data = (event as CustomEventMsg).event.data as { count: number };
      expect(data.count).toBe(2);

      client.close();
    });
  });
});
