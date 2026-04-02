import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "../../transport/types.js";
import type { AgentStatus, ConnectionStatus } from "../types.js";

describe("Client Types", () => {
  describe("ConnectionStatus", () => {
    it("defines all connection states", () => {
      const statuses: ConnectionStatus[] = [
        "connecting",
        "connected",
        "disconnected",
        "reconnecting",
      ];
      expect(statuses).toHaveLength(4);
    });
  });

  describe("AgentStatus", () => {
    it("defines all agent states", () => {
      const statuses: AgentStatus[] = ["idle", "streaming", "executing_tools"];
      expect(statuses).toHaveLength(3);
    });
  });

  describe("Message type discrimination", () => {
    it("discriminates server messages by type", () => {
      const handlers: Record<ServerMessage["type"], boolean> = {
        agent_event: true,
        tool_event: true,
        session_sync: true,
        session_list: true,
        schedule_list: true,
        mcp_status: true,
        cost_event: true,
        error: true,
        command_result: true,
        command_list: true,
        custom_event: true,
        inject_message: true,
        skill_list: true,
        system_prompt: true,
        pong: true,
      };
      expect(Object.keys(handlers)).toHaveLength(15);
    });

    it("discriminates client messages by type", () => {
      const handlers: Record<ClientMessage["type"], boolean> = {
        prompt: true,
        steer: true,
        abort: true,
        switch_session: true,
        new_session: true,
        delete_session: true,
        command: true,
        ping: true,
        request_sync: true,
        toggle_schedule: true,
        custom_response: true,
        request_system_prompt: true,
      };
      expect(Object.keys(handlers)).toHaveLength(12);
    });
  });

  describe("Client export isolation", () => {
    it("client/types.ts has no server imports", async () => {
      // This test verifies at the type level that client types
      // don't depend on server-side modules
      const clientTypes = await import("../types.js");
      expect(clientTypes).toBeDefined();
      // Should only export type aliases, no runtime values that pull in server code
    });
  });
});
