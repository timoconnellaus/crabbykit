import { describe, expect, it } from "vitest";
import {
  abortMessage,
  agentEventMessage,
  customResponseMessage,
  errorMessage,
  mcpStatusMessage,
  newSessionMessage,
  promptMessage,
  sessionListMessage,
  sessionSyncMessage,
  steerMessage,
  switchSessionMessage,
  toolEventMessage,
} from "../../../test/fixtures/transport-messages.js";
import type { ClientMessage, ServerMessage } from "../types.js";

describe("Transport Message Types", () => {
  describe("Server → Client messages", () => {
    it("session_sync has required fields", () => {
      const msg: ServerMessage = sessionSyncMessage;
      expect(msg.type).toBe("session_sync");
      if (msg.type === "session_sync") {
        expect(msg.sessionId).toBeTruthy();
        expect(msg.session.id).toBeTruthy();
        expect(msg.messages).toBeInstanceOf(Array);
      }
    });

    it("session_list has sessions array", () => {
      const msg: ServerMessage = sessionListMessage;
      expect(msg.type).toBe("session_list");
      if (msg.type === "session_list") {
        expect(msg.sessions.length).toBeGreaterThan(0);
        expect(msg.sessions[0].id).toBeTruthy();
        expect(msg.sessions[0].name).toBeTruthy();
      }
    });

    it("agent_event wraps pi-agent-core event", () => {
      const msg: ServerMessage = agentEventMessage;
      expect(msg.type).toBe("agent_event");
      if (msg.type === "agent_event") {
        expect(msg.sessionId).toBeTruthy();
        expect(msg.event.type).toBe("message_start");
      }
    });

    it("tool_event wraps tool execution event", () => {
      const msg: ServerMessage = toolEventMessage;
      expect(msg.type).toBe("tool_event");
      if (msg.type === "tool_event") {
        expect(msg.event.toolCallId).toBeTruthy();
        expect(msg.event.toolName).toBeTruthy();
      }
    });

    it("mcp_status has server list", () => {
      const msg: ServerMessage = mcpStatusMessage;
      expect(msg.type).toBe("mcp_status");
      if (msg.type === "mcp_status") {
        expect(msg.servers.length).toBe(2);
        expect(msg.servers[0].status).toBe("connected");
        expect(msg.servers[1].status).toBe("error");
        expect(msg.servers[1].error).toBeTruthy();
      }
    });

    it("error has code and message", () => {
      const msg: ServerMessage = errorMessage;
      expect(msg.type).toBe("error");
      if (msg.type === "error") {
        expect(msg.code).toBeTruthy();
        expect(msg.message).toBeTruthy();
      }
    });

    it("all server messages are JSON-serializable", () => {
      const messages = [
        sessionSyncMessage,
        sessionListMessage,
        agentEventMessage,
        toolEventMessage,
        mcpStatusMessage,
        errorMessage,
      ];

      for (const msg of messages) {
        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);
        expect(parsed.type).toBe(msg.type);
      }
    });
  });

  describe("Client → Server messages", () => {
    it("prompt has sessionId and text", () => {
      const msg: ClientMessage = promptMessage;
      expect(msg.type).toBe("prompt");
      if (msg.type === "prompt") {
        expect(msg.sessionId).toBeTruthy();
        expect(msg.text).toBeTruthy();
      }
    });

    it("steer has sessionId and text", () => {
      const msg: ClientMessage = steerMessage;
      expect(msg.type).toBe("steer");
      if (msg.type === "steer") {
        expect(msg.text).toBeTruthy();
      }
    });

    it("abort has sessionId", () => {
      const msg: ClientMessage = abortMessage;
      expect(msg.type).toBe("abort");
      if (msg.type === "abort") {
        expect(msg.sessionId).toBeTruthy();
      }
    });

    it("switch_session has target sessionId", () => {
      const msg: ClientMessage = switchSessionMessage;
      expect(msg.type).toBe("switch_session");
      if (msg.type === "switch_session") {
        expect(msg.sessionId).toBe("sess_456");
      }
    });

    it("new_session has optional name", () => {
      const msg: ClientMessage = newSessionMessage;
      expect(msg.type).toBe("new_session");
      if (msg.type === "new_session") {
        expect(msg.name).toBe("Research Task");
      }
    });

    it("custom_response has requestId and data", () => {
      const msg: ClientMessage = customResponseMessage;
      expect(msg.type).toBe("custom_response");
      if (msg.type === "custom_response") {
        expect(msg.sessionId).toBeTruthy();
        expect(msg.requestId).toBeTruthy();
        expect(msg.data).toBeDefined();
        expect(msg.data.logs).toBeInstanceOf(Array);
      }
    });

    it("all client messages are JSON-serializable", () => {
      const messages = [
        promptMessage,
        steerMessage,
        abortMessage,
        switchSessionMessage,
        newSessionMessage,
        customResponseMessage,
      ];

      for (const msg of messages) {
        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);
        expect(parsed.type).toBe(msg.type);
      }
    });
  });
});
