import { describe, expect, it } from "vitest";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "../../types.js";
import { transformMessages } from "../transform-messages.js";

const TEST_MODEL: Model<Api> = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://api.test.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function userMsg(content: string = "hello"): UserMessage {
  return { role: "user", content, timestamp: 1000 };
}

function assistantMsg(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2000,
    ...overrides,
  };
}

function toolResult(toolCallId: string, toolName = "test_tool"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 3000,
  };
}

function toolCall(id: string, name = "test_tool"): ToolCall {
  return { type: "toolCall", id, name, arguments: {} };
}

describe("transformMessages", () => {
  it("passes user messages through unchanged", () => {
    const messages: Message[] = [userMsg("hello world")];
    const result = transformMessages(messages, TEST_MODEL);
    expect(result).toEqual(messages);
  });

  describe("thinking blocks", () => {
    it("preserves thinking blocks with signature for same model", () => {
      const msg = assistantMsg([
        { type: "thinking", thinking: "let me think", thinkingSignature: "sig-123" },
        { type: "text", text: "answer" },
      ]);
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content[0]).toEqual({
        type: "thinking",
        thinking: "let me think",
        thinkingSignature: "sig-123",
      });
    });

    it("converts thinking blocks to text for cross-model", () => {
      const msg = assistantMsg(
        [
          { type: "thinking", thinking: "reasoning here" },
          { type: "text", text: "answer" },
        ],
        { provider: "other-provider" },
      );
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content[0]).toEqual({ type: "text", text: "reasoning here" });
    });

    it("drops redacted thinking blocks for cross-model", () => {
      const msg = assistantMsg(
        [
          {
            type: "thinking",
            thinking: "encrypted",
            thinkingSignature: "sig",
            redacted: true,
          },
          { type: "text", text: "answer" },
        ],
        { provider: "other-provider" },
      );
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content).toHaveLength(1);
      expect(assistant.content[0].type).toBe("text");
    });

    it("preserves redacted thinking blocks for same model", () => {
      const msg = assistantMsg([
        {
          type: "thinking",
          thinking: "encrypted",
          thinkingSignature: "sig",
          redacted: true,
        },
        { type: "text", text: "answer" },
      ]);
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content[0]).toEqual({
        type: "thinking",
        thinking: "encrypted",
        thinkingSignature: "sig",
        redacted: true,
      });
    });

    it("drops empty thinking blocks for cross-model", () => {
      const msg = assistantMsg(
        [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
        { provider: "other-provider" },
      );
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content).toHaveLength(1);
      expect(assistant.content[0]).toEqual({ type: "text", text: "answer" });
    });

    it("drops empty thinking blocks for same model (no signature)", () => {
      const msg = assistantMsg([
        { type: "thinking", thinking: "  " },
        { type: "text", text: "answer" },
      ]);
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content).toHaveLength(1);
      expect(assistant.content[0].type).toBe("text");
    });

    it("keeps empty thinking blocks with signature for same model (OpenAI encrypted reasoning)", () => {
      const msg = assistantMsg([
        { type: "thinking", thinking: "", thinkingSignature: "sig-enc" },
        { type: "text", text: "answer" },
      ]);
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content).toHaveLength(2);
      expect(assistant.content[0]).toEqual({
        type: "thinking",
        thinking: "",
        thinkingSignature: "sig-enc",
      });
    });
  });

  describe("tool calls", () => {
    it("removes thoughtSignature from tool calls for cross-model", () => {
      const tc: ToolCall = {
        type: "toolCall",
        id: "tc-1",
        name: "test",
        arguments: {},
        thoughtSignature: "thought-sig",
      };
      const msg = assistantMsg([tc], { provider: "other-provider" });
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      const resultTc = assistant.content[0] as ToolCall;
      expect(resultTc.thoughtSignature).toBeUndefined();
    });

    it("preserves thoughtSignature on tool calls for same model", () => {
      const tc: ToolCall = {
        type: "toolCall",
        id: "tc-1",
        name: "test",
        arguments: {},
        thoughtSignature: "thought-sig",
      };
      const msg = assistantMsg([tc]);
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      const resultTc = assistant.content[0] as ToolCall;
      expect(resultTc.thoughtSignature).toBe("thought-sig");
    });
  });

  describe("tool call ID normalization", () => {
    it("normalizes tool call IDs via callback and updates toolResult IDs", () => {
      const tc = toolCall("original-id-123");
      const msg = assistantMsg([tc], { provider: "other-provider" });
      const tr = toolResult("original-id-123");

      const normalizer = (id: string) => `norm_${id}`;
      const result = transformMessages([msg, tr], TEST_MODEL, normalizer);

      const assistant = result[0] as AssistantMessage;
      const resultTc = assistant.content[0] as ToolCall;
      expect(resultTc.id).toBe("norm_original-id-123");

      const resultTr = result[1] as ToolResultMessage;
      expect(resultTr.toolCallId).toBe("norm_original-id-123");
    });

    it("does not normalize IDs for same model", () => {
      const tc = toolCall("tc-1");
      const msg = assistantMsg([tc]);
      const tr = toolResult("tc-1");

      const normalizer = (id: string) => `norm_${id}`;
      const result = transformMessages([msg, tr], TEST_MODEL, normalizer);

      const assistant = result[0] as AssistantMessage;
      expect((assistant.content[0] as ToolCall).id).toBe("tc-1");
      expect((result[1] as ToolResultMessage).toolCallId).toBe("tc-1");
    });
  });

  describe("error/aborted assistant messages", () => {
    it("drops assistant messages with error stopReason", () => {
      const msg = assistantMsg([{ type: "text", text: "partial" }], { stopReason: "error" });
      const result = transformMessages([userMsg(), msg], TEST_MODEL);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
    });

    it("drops assistant messages with aborted stopReason", () => {
      const msg = assistantMsg([{ type: "text", text: "partial" }], { stopReason: "aborted" });
      const result = transformMessages([userMsg(), msg], TEST_MODEL);
      expect(result).toHaveLength(1);
    });
  });

  describe("orphaned tool calls", () => {
    it("inserts synthetic toolResult before next assistant message", () => {
      const tc = toolCall("orphan-1", "orphan_tool");
      const msg1 = assistantMsg([tc]);
      // No toolResult for orphan-1, then another assistant message
      const msg2 = assistantMsg([{ type: "text", text: "next turn" }]);
      const result = transformMessages([msg1, msg2], TEST_MODEL);

      // msg1, synthetic toolResult, msg2
      expect(result).toHaveLength(3);
      const synthetic = result[1] as ToolResultMessage;
      expect(synthetic.role).toBe("toolResult");
      expect(synthetic.toolCallId).toBe("orphan-1");
      expect(synthetic.toolName).toBe("orphan_tool");
      expect(synthetic.isError).toBe(true);
      expect(synthetic.content[0]).toEqual({ type: "text", text: "No result provided" });
    });

    it("inserts synthetic toolResult before user message", () => {
      const tc = toolCall("orphan-2", "some_tool");
      const msg = assistantMsg([tc]);
      const result = transformMessages([msg, userMsg("next question")], TEST_MODEL);

      expect(result).toHaveLength(3);
      const synthetic = result[1] as ToolResultMessage;
      expect(synthetic.role).toBe("toolResult");
      expect(synthetic.toolCallId).toBe("orphan-2");
      expect(synthetic.isError).toBe(true);
    });

    it("does not insert synthetic result when toolResult exists", () => {
      const tc = toolCall("tc-ok");
      const msg = assistantMsg([tc]);
      const tr = toolResult("tc-ok");
      const result = transformMessages([msg, tr, userMsg()], TEST_MODEL);

      // assistant, toolResult, user - no synthetic
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe("assistant");
      expect(result[1].role).toBe("toolResult");
      expect(result[2].role).toBe("user");
    });

    it("handles multiple tool calls with partial results", () => {
      const tc1 = toolCall("tc-a", "tool_a");
      const tc2 = toolCall("tc-b", "tool_b");
      const msg = assistantMsg([tc1, tc2]);
      const tr1 = toolResult("tc-a");
      // tc-b has no result
      const result = transformMessages([msg, tr1, userMsg()], TEST_MODEL);

      // assistant, toolResult(tc-a), synthetic(tc-b), user
      expect(result).toHaveLength(4);
      expect((result[1] as ToolResultMessage).toolCallId).toBe("tc-a");
      const synthetic = result[2] as ToolResultMessage;
      expect(synthetic.toolCallId).toBe("tc-b");
      expect(synthetic.isError).toBe(true);
    });
  });

  describe("text blocks", () => {
    it("strips textSignature for cross-model (reconstructed as plain text)", () => {
      const msg = assistantMsg(
        [{ type: "text", text: "hello", textSignature: "sig-abc" }],
        { provider: "other-provider" },
      );
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect(assistant.content[0]).toEqual({ type: "text", text: "hello" });
      expect((assistant.content[0] as any).textSignature).toBeUndefined();
    });

    it("preserves textSignature for same model", () => {
      const msg = assistantMsg([{ type: "text", text: "hello", textSignature: "sig-abc" }]);
      const result = transformMessages([msg], TEST_MODEL);
      const assistant = result[0] as AssistantMessage;
      expect((assistant.content[0] as any).textSignature).toBe("sig-abc");
    });
  });
});
