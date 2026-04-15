import type { AgentEvent } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it } from "vitest";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  textResponseEvents,
  thinkingEvents,
  toolCallEvents,
} from "../agent-events.js";

describe("Agent Event Fixtures", () => {
  describe("Message creators", () => {
    it("creates user messages", () => {
      const msg = createUserMessage("hello");
      expect((msg as any).role).toBe("user");
      expect((msg as any).content).toBe("hello");
      expect((msg as any).timestamp).toBeTruthy();
    });

    it("creates assistant messages", () => {
      const msg = createAssistantMessage("hi");
      expect((msg as any).role).toBe("assistant");
      expect((msg as any).content[0].text).toBe("hi");
    });

    it("creates tool result messages", () => {
      const msg = createToolResultMessage("call_1", "search", "results", false);
      expect((msg as any).role).toBe("toolResult");
      expect((msg as any).toolCallId).toBe("call_1");
      expect((msg as any).toolName).toBe("search");
      expect((msg as any).isError).toBe(false);
    });

    it("creates error tool results", () => {
      const msg = createToolResultMessage("call_1", "bash", "failed", true);
      expect((msg as any).isError).toBe(true);
    });
  });

  describe("Text response event sequence", () => {
    it("starts with agent_start and ends with agent_end", () => {
      expect(textResponseEvents[0].type).toBe("agent_start");
      expect(textResponseEvents[textResponseEvents.length - 1].type).toBe("agent_end");
    });

    it("has turn_start and turn_end", () => {
      const types = textResponseEvents.map((e) => e.type);
      expect(types).toContain("turn_start");
      expect(types).toContain("turn_end");
    });

    it("has message lifecycle events", () => {
      const types = textResponseEvents.map((e) => e.type);
      expect(types).toContain("message_start");
      expect(types).toContain("message_update");
      expect(types).toContain("message_end");
    });

    it("agent_end contains final messages", () => {
      const endEvent = textResponseEvents[textResponseEvents.length - 1];
      if (endEvent.type === "agent_end") {
        expect(endEvent.messages.length).toBe(2);
      }
    });
  });

  describe("Tool call event sequence", () => {
    it("includes tool execution events", () => {
      const types = toolCallEvents.map((e) => e.type);
      expect(types).toContain("tool_execution_start");
      expect(types).toContain("tool_execution_end");
    });

    it("has two turns (tool call + response)", () => {
      const turnStarts = toolCallEvents.filter((e) => e.type === "turn_start");
      expect(turnStarts.length).toBe(2);
    });

    it("tool execution has correct tool name", () => {
      const start = toolCallEvents.find((e) => e.type === "tool_execution_start") as Extract<
        AgentEvent,
        { type: "tool_execution_start" }
      >;
      expect(start.toolName).toBe("file_read");
      expect(start.toolCallId).toBe("call_abc");
    });
  });

  describe("Thinking event sequence", () => {
    it("includes thinking events in message_update", () => {
      const updates = thinkingEvents.filter((e) => e.type === "message_update") as Extract<
        AgentEvent,
        { type: "message_update" }
      >[];

      const thinkingTypes = updates
        .map((u) => (u.assistantMessageEvent as any)?.type)
        .filter(Boolean);

      expect(thinkingTypes).toContain("thinking_start");
      expect(thinkingTypes).toContain("thinking_delta");
      expect(thinkingTypes).toContain("thinking_end");
    });
  });
});
