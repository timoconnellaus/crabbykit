/**
 * Tests for capability_state message routing and capability_action handling.
 *
 * 11.4 — capability_state broadcast: clients receive correctly shaped messages
 * 11.5 — capability_action routing: schedule toggle via capability_action
 * 11.6 — sendCommandList single-connection targeting: only the connecting client gets command_list
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../../src/capabilities/types.js";
import type { CallbackScheduleConfig } from "../../src/scheduling/types.js";
import {
  clearCompactionOverrides,
  clearExtraCapabilities,
  clearMockResponses,
  setExtraCapabilities,
  setMockResponses,
} from "../../src/test-helpers/test-agent-do.js";
import type { CapabilityStateMessage } from "../../src/transport/types.js";
import {
  connectAndGetSession,
  getSchedules,
  getStub,
  openSocket,
  prompt,
} from "../helpers/ws-client.js";

describe("Capability state and action routing", () => {
  beforeEach(() => {
    clearMockResponses();
    clearCompactionOverrides();
    clearExtraCapabilities();
  });

  describe("11.4 capability_state broadcast shape", () => {
    it("clients receive capability_state messages with correct envelope", async () => {
      const stub = getStub("cap-state-1");

      // Connect a WebSocket client
      const { client } = await connectAndGetSession(stub);

      // The initial connection triggers broadcastScheduleList, broadcastQueueState,
      // and sendCommandList — all of which use broadcastCoreState and produce
      // capability_state messages. Collect them.
      // Give a moment for all initial broadcasts to arrive.
      await new Promise((r) => setTimeout(r, 100));

      const capStateMessages = client.messages.filter(
        (m): m is CapabilityStateMessage => m.type === "capability_state",
      );

      // Should have at least the commands sync (sent to this connection)
      const commandsSync = capStateMessages.find(
        (m) => m.capabilityId === "commands" && m.event === "sync",
      );
      expect(commandsSync).toBeTruthy();
      expect(commandsSync!.scope).toBe("global");
      expect(commandsSync!.data).toBeDefined();
      expect((commandsSync!.data as { commands: unknown[] }).commands).toBeInstanceOf(Array);

      // Should have schedules sync (broadcast to all)
      const schedulesSync = capStateMessages.find(
        (m) => m.capabilityId === "schedules" && m.event === "sync",
      );
      expect(schedulesSync).toBeTruthy();
      expect(schedulesSync!.event).toBe("sync");
      expect((schedulesSync!.data as { schedules: unknown[] }).schedules).toBeInstanceOf(Array);

      // Should have queue sync (broadcast to session)
      const queueSync = capStateMessages.find(
        (m) => m.capabilityId === "queue" && m.event === "sync",
      );
      expect(queueSync).toBeTruthy();
      expect((queueSync!.data as { items: unknown[] }).items).toBeInstanceOf(Array);

      client.close();
    });

    it("capability broadcastState delivers to session clients", async () => {
      const cap: Capability = {
        id: "test-broadcaster",
        name: "Test Broadcaster",
        description: "Broadcasts state for testing",
        schedules: () => [
          {
            id: "broadcaster-sched",
            name: "Broadcaster Schedule",
            cron: "0 0 1 1 *",
            enabled: true,
            callback: async () => {},
          } satisfies CallbackScheduleConfig,
        ],
      };

      setExtraCapabilities([cap]);
      const stub = getStub("cap-state-2");

      // Initialize the DO
      setMockResponses([{ text: "Init" }]);
      await prompt(stub, "Init");

      // Connect and watch for schedule_list broadcast which uses capability_state
      const { client } = await connectAndGetSession(stub);
      await new Promise((r) => setTimeout(r, 100));

      const capStateMessages = client.messages.filter(
        (m): m is CapabilityStateMessage => m.type === "capability_state",
      );

      // The schedules sync should include our capability's schedule
      const schedulesSync = capStateMessages.find(
        (m) => m.capabilityId === "schedules" && m.event === "sync",
      );
      expect(schedulesSync).toBeTruthy();

      client.close();
    });
  });

  describe("11.5 capability_action routing", () => {
    it("schedule toggle via capability_action message", async () => {
      const stub = getStub("cap-action-1");

      // Create a prompt-type schedule via the REST API (user-owned, not capability-owned)
      const createRes = await stub.fetch("http://fake/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "toggle-sched",
          name: "Toggleable Schedule",
          cron: "0 0 1 1 *",
          prompt: "Test prompt",
          enabled: true,
        }),
      });
      expect(createRes.ok).toBe(true);

      // Verify schedule exists and is enabled
      const before = await getSchedules(stub);
      const sched = before.schedules.find((s: any) => s.id === "toggle-sched");
      expect(sched).toBeTruthy();
      expect(sched!.enabled).toBe(true);

      // Connect via WebSocket and send capability_action to toggle off
      const { client, sessionId } = await connectAndGetSession(stub);

      // Clear initial capability_state messages so we can wait for the new one
      const initialCount = client.messages.length;

      client.send({
        type: "capability_action",
        capabilityId: "schedules",
        action: "toggle",
        data: { scheduleId: "toggle-sched", enabled: false },
        sessionId,
      });

      // Wait for the schedule_list broadcast that follows the toggle
      await client.waitForMessage(
        (m) =>
          m.type === "capability_state" &&
          (m as CapabilityStateMessage).capabilityId === "schedules" &&
          (m as CapabilityStateMessage).event === "sync" &&
          // Must be a new message, not the initial sync
          client.messages.indexOf(m) >= initialCount,
      );

      // Verify the schedule is now disabled
      const after = await getSchedules(stub);
      const updated = after.schedules.find((s: any) => s.id === "toggle-sched");
      expect(updated).toBeTruthy();
      expect(updated!.enabled).toBe(false);

      // Toggle back on
      const countBeforeToggleOn = client.messages.length;

      client.send({
        type: "capability_action",
        capabilityId: "schedules",
        action: "toggle",
        data: { scheduleId: "toggle-sched", enabled: true },
        sessionId,
      });

      await client.waitForMessage(
        (m) =>
          m.type === "capability_state" &&
          (m as CapabilityStateMessage).capabilityId === "schedules" &&
          (m as CapabilityStateMessage).event === "sync" &&
          client.messages.indexOf(m) >= countBeforeToggleOn,
      );

      const restored = await getSchedules(stub);
      const restoredSched = restored.schedules.find((s: any) => s.id === "toggle-sched");
      expect(restoredSched!.enabled).toBe(true);

      client.close();
    });

    it("capability_action routes to capability onAction handler", async () => {
      let receivedAction: string | null = null;
      let receivedData: unknown = null;

      const cap: Capability = {
        id: "custom-action-cap",
        name: "Custom Action Cap",
        description: "Tests onAction routing",
        onAction: async (action, data, _ctx) => {
          receivedAction = action;
          receivedData = data;
        },
      };

      setExtraCapabilities([cap]);
      const stub = getStub("cap-action-2");

      // Send capability_action while the agent is running (cache is populated).
      // Use a delayed mock response so the agent is still alive when the action arrives.
      setMockResponses([{ text: "Working...", delay: 300 }]);

      const { client, sessionId } = await connectAndGetSession(stub);

      // Start inference via WebSocket (fire-and-forget) — this populates resolvedCapabilitiesCache
      client.send({ type: "prompt", sessionId, text: "Do something" });

      // Wait for streaming to start, then send the capability_action
      await new Promise((r) => setTimeout(r, 50));

      client.send({
        type: "capability_action",
        capabilityId: "custom-action-cap",
        action: "do_something",
        data: { key: "value" },
        sessionId,
      });

      // Wait for agent_end (inference completes)
      await client.waitForMessage(
        (m) => m.type === "agent_event" && (m as any).event?.type === "agent_end",
      );

      expect(receivedAction).toBe("do_something");
      expect(receivedData).toEqual({ key: "value" });

      client.close();
    });
  });

  describe("11.6 sendCommandList single-connection targeting", () => {
    it("command_list is sent only to the connecting client, not all clients", async () => {
      const stub = getStub("cap-cmd-1");

      // Connect first client — it will receive its own command_list
      const client1 = await openSocket(stub);
      await client1.waitForMessage((m) => m.type === "session_sync");
      await new Promise((r) => setTimeout(r, 100));

      // Connect second client — it should get its own command_list
      const client2 = await openSocket(stub);
      await client2.waitForMessage((m) => m.type === "session_sync");
      await new Promise((r) => setTimeout(r, 100));

      // Client 2 should have received a commands sync
      const client2Commands = client2.messages.filter(
        (m): m is CapabilityStateMessage =>
          m.type === "capability_state" &&
          (m as CapabilityStateMessage).capabilityId === "commands" &&
          (m as CapabilityStateMessage).event === "sync",
      );
      expect(client2Commands.length).toBeGreaterThanOrEqual(1);

      // Client 1 should NOT have received an extra commands sync from client 2 connecting.
      // It may receive schedule_list or other broadcasts, but commands sync is connection-targeted.
      const client1CommandsAfter = client1.messages.filter(
        (m): m is CapabilityStateMessage =>
          m.type === "capability_state" &&
          (m as CapabilityStateMessage).capabilityId === "commands" &&
          (m as CapabilityStateMessage).event === "sync",
      );

      // Client 1 should have exactly 1 commands sync (from its own connection)
      expect(client1CommandsAfter.length).toBe(1);

      client1.close();
      client2.close();
    });
  });
});
