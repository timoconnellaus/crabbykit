import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "../../types.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
  inferCopilotInitiator,
} from "../github-copilot-headers.js";

function userMsg(content: UserMessage["content"] = "hello"): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistantMsg(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "response" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResultMsg(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "test_tool",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("inferCopilotInitiator", () => {
  it('returns "user" when last message is user', () => {
    expect(inferCopilotInitiator([userMsg()])).toBe("user");
  });

  it('returns "agent" when last message is assistant', () => {
    expect(inferCopilotInitiator([userMsg(), assistantMsg()])).toBe("agent");
  });

  it('returns "agent" when last message is toolResult', () => {
    expect(inferCopilotInitiator([userMsg(), assistantMsg(), toolResultMsg()])).toBe("agent");
  });

  it('returns "user" for empty messages array', () => {
    expect(inferCopilotInitiator([])).toBe("user");
  });
});

describe("hasCopilotVisionInput", () => {
  it("returns false when no images present", () => {
    expect(hasCopilotVisionInput([userMsg("hello")])).toBe(false);
  });

  it("returns true when user message has image content", () => {
    const msg = userMsg([
      { type: "text", text: "look at this" },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
    expect(hasCopilotVisionInput([msg])).toBe(true);
  });

  it("returns true when toolResult has image content", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "screenshot",
      content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
      isError: false,
      timestamp: Date.now(),
    };
    expect(hasCopilotVisionInput([msg])).toBe(true);
  });

  it("returns false when user message has text only (array form)", () => {
    const msg = userMsg([{ type: "text", text: "just text" }]);
    expect(hasCopilotVisionInput([msg])).toBe(false);
  });

  it("returns false for assistant messages with any content", () => {
    // Assistant messages are not checked for images
    expect(hasCopilotVisionInput([assistantMsg()])).toBe(false);
  });
});

describe("buildCopilotDynamicHeaders", () => {
  it("includes X-Initiator and Openai-Intent", () => {
    const messages: Message[] = [userMsg()];
    const headers = buildCopilotDynamicHeaders({ messages, hasImages: false });
    expect(headers["X-Initiator"]).toBe("user");
    expect(headers["Openai-Intent"]).toBe("conversation-edits");
  });

  it("adds Copilot-Vision-Request when hasImages is true", () => {
    const messages: Message[] = [userMsg()];
    const headers = buildCopilotDynamicHeaders({ messages, hasImages: true });
    expect(headers["Copilot-Vision-Request"]).toBe("true");
  });

  it("does not add Copilot-Vision-Request when hasImages is false", () => {
    const messages: Message[] = [userMsg()];
    const headers = buildCopilotDynamicHeaders({ messages, hasImages: false });
    expect(headers["Copilot-Vision-Request"]).toBeUndefined();
  });

  it("sets X-Initiator to agent when last message is assistant", () => {
    const messages: Message[] = [userMsg(), assistantMsg()];
    const headers = buildCopilotDynamicHeaders({ messages, hasImages: false });
    expect(headers["X-Initiator"]).toBe("agent");
  });
});
