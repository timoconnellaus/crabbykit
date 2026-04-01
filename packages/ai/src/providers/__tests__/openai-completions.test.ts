import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Context,
  Model,
  OpenAICompletionsCompat,
  ToolResultMessage,
  UserMessage,
} from "../../types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { convertMessages } from "../openai-completions.js";

const DEFAULT_COMPAT: Required<OpenAICompletionsCompat> = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  reasoningEffortMap: {},
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: true,
};

const model: Model<"openai-completions"> = {
  id: "gpt-4o",
  name: "GPT-4o",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
  headers: {},
};

function makeUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function userMsg(content: UserMessage["content"] = "hello"): UserMessage {
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
    provider: "openai",
    model: "gpt-4o",
    usage: makeUsage(),
    stopReason: "stop",
    timestamp: 2000,
    ...overrides,
  };
}

function toolResultMsg(
  toolCallId = "tc-1",
  text = "result",
  toolName = "test_tool",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3000,
  };
}

function ctx(messages: Context["messages"], systemPrompt?: string, tools?: Context["tools"]): Context {
  return { messages, systemPrompt, tools };
}

describe("convertMessages", () => {
  describe("system prompt", () => {
    it('uses "system" role for non-reasoning models', () => {
      const result = convertMessages(model, ctx([], "You are helpful"), DEFAULT_COMPAT);
      expect(result[0]).toEqual({ role: "system", content: "You are helpful" });
    });

    it('uses "developer" role for reasoning models with supportsDeveloperRole', () => {
      const reasoningModel = { ...model, reasoning: true };
      const result = convertMessages(reasoningModel, ctx([], "You are helpful"), DEFAULT_COMPAT);
      expect(result[0]).toEqual({ role: "developer", content: "You are helpful" });
    });

    it('uses "system" role for reasoning models without supportsDeveloperRole', () => {
      const reasoningModel = { ...model, reasoning: true };
      const compat = { ...DEFAULT_COMPAT, supportsDeveloperRole: false };
      const result = convertMessages(reasoningModel, ctx([], "You are helpful"), compat);
      expect(result[0]).toEqual({ role: "system", content: "You are helpful" });
    });
  });

  describe("user messages", () => {
    it("converts string content", () => {
      const result = convertMessages(model, ctx([userMsg("hi there")]), DEFAULT_COMPAT);
      expect(result[0]).toEqual({ role: "user", content: "hi there" });
    });

    it("converts text+image content", () => {
      const msg = userMsg([
        { type: "text", text: "look at this" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ]);
      const result = convertMessages(model, ctx([msg]), DEFAULT_COMPAT);
      const userResult = result[0] as any;
      expect(userResult.role).toBe("user");
      expect(userResult.content).toHaveLength(2);
      expect(userResult.content[0]).toEqual({ type: "text", text: "look at this" });
      expect(userResult.content[1]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/png;base64,base64data" },
      });
    });

    it("filters image content when model does not support images", () => {
      const textOnlyModel = { ...model, input: ["text"] as ("text" | "image")[] };
      const msg = userMsg([
        { type: "text", text: "look" },
        { type: "image", data: "data", mimeType: "image/png" },
      ]);
      const result = convertMessages(textOnlyModel, ctx([msg]), DEFAULT_COMPAT);
      const userResult = result[0] as any;
      expect(userResult.content).toHaveLength(1);
      expect(userResult.content[0].type).toBe("text");
    });
  });

  describe("assistant messages", () => {
    it("joins text content as a single string (not array)", () => {
      const msg = assistantMsg([
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ]);
      const result = convertMessages(model, ctx([msg]), DEFAULT_COMPAT);
      const assistant = result[0] as any;
      expect(assistant.role).toBe("assistant");
      expect(assistant.content).toBe("Hello world");
    });

    it("filters out empty text blocks", () => {
      const msg = assistantMsg([
        { type: "text", text: "" },
        { type: "text", text: "actual content" },
      ]);
      const result = convertMessages(model, ctx([msg]), DEFAULT_COMPAT);
      const assistant = result[0] as any;
      expect(assistant.content).toBe("actual content");
    });

    it("converts tool calls", () => {
      const msg = assistantMsg([
        {
          type: "toolCall",
          id: "tc-1",
          name: "get_weather",
          arguments: { city: "NYC" },
        },
      ]);
      const result = convertMessages(model, ctx([msg]), DEFAULT_COMPAT);
      const assistant = result[0] as any;
      expect(assistant.tool_calls).toHaveLength(1);
      expect(assistant.tool_calls[0]).toEqual({
        id: "tc-1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      });
    });

    it("skips assistant messages with no content and no tool calls", () => {
      const msg = assistantMsg([{ type: "text", text: "" }]);
      const result = convertMessages(model, ctx([userMsg(), msg, userMsg("follow up")]), DEFAULT_COMPAT);
      // Should have user, user (assistant skipped)
      expect(result).toHaveLength(2);
      expect(result.every((m: any) => m.role === "user")).toBe(true);
    });
  });

  describe("tool results", () => {
    it('converts to "tool" role messages', () => {
      const msg = assistantMsg([
        { type: "toolCall", id: "tc-1", name: "test", arguments: {} },
      ]);
      const tr = toolResultMsg("tc-1", "the result");
      const result = convertMessages(model, ctx([msg, tr]), DEFAULT_COMPAT);
      const toolMsg = result[1] as any;
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content).toBe("the result");
      expect(toolMsg.tool_call_id).toBe("tc-1");
    });

    it("includes name field when requiresToolResultName is true", () => {
      const msg = assistantMsg([
        { type: "toolCall", id: "tc-1", name: "my_tool", arguments: {} },
      ]);
      const tr = toolResultMsg("tc-1", "result", "my_tool");
      const compat = { ...DEFAULT_COMPAT, requiresToolResultName: true };
      const result = convertMessages(model, ctx([msg, tr]), compat);
      const toolMsg = result[1] as any;
      expect(toolMsg.name).toBe("my_tool");
    });
  });

  describe("requiresAssistantAfterToolResult", () => {
    it("inserts synthetic assistant message between toolResult and user", () => {
      const msg = assistantMsg([
        { type: "toolCall", id: "tc-1", name: "test", arguments: {} },
      ]);
      const tr = toolResultMsg("tc-1");
      const user = userMsg("next question");
      const compat = { ...DEFAULT_COMPAT, requiresAssistantAfterToolResult: true };
      const result = convertMessages(model, ctx([msg, tr, user]), compat);

      // assistant, tool, synthetic-assistant, user
      const syntheticIdx = result.findIndex(
        (m: any) => m.role === "assistant" && m.content === "I have processed the tool results.",
      );
      expect(syntheticIdx).toBeGreaterThan(0);
    });
  });

  describe("tool result images", () => {
    it("appends image blocks as user message with image_url parts", () => {
      const msg = assistantMsg([
        { type: "toolCall", id: "tc-1", name: "screenshot", arguments: {} },
      ]);
      const tr: ToolResultMessage = {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "screenshot",
        content: [
          { type: "text", text: "captured" },
          { type: "image", data: "imgdata", mimeType: "image/jpeg" },
        ],
        isError: false,
        timestamp: 3000,
      };
      const result = convertMessages(model, ctx([msg, tr]), DEFAULT_COMPAT);
      // assistant, tool, user (with images)
      const imageUserMsg = result.find(
        (m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((c: any) => c.type === "image_url"),
      ) as any;
      expect(imageUserMsg).toBeDefined();
      expect(imageUserMsg.content[0]).toEqual({
        type: "text",
        text: "Attached image(s) from tool result:",
      });
      expect(imageUserMsg.content[1]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,imgdata" },
      });
    });
  });

  describe("thinking blocks", () => {
    it("converts thinking to text array when requiresThinkingAsText is true (no text blocks)", () => {
      const msg = assistantMsg([{ type: "thinking", thinking: "my reasoning" }]);
      const compat = { ...DEFAULT_COMPAT, requiresThinkingAsText: true };
      const result = convertMessages(model, ctx([msg]), compat);
      const assistant = result[0] as any;
      // No text blocks, so content was null -> thinking becomes the content
      expect(assistant.content).toEqual([{ type: "text", text: "my reasoning" }]);
    });

    it("writes thinking to the named field when requiresThinkingAsText is false", () => {
      const msg = assistantMsg([
        { type: "thinking", thinking: "deep thought", thinkingSignature: "reasoning_content" },
        { type: "text", text: "answer" },
      ]);
      const result = convertMessages(model, ctx([msg]), DEFAULT_COMPAT);
      const assistant = result[0] as any;
      expect(assistant.reasoning_content).toBe("deep thought");
      expect(assistant.content).toBe("answer");
    });
  });

  describe("tool call thoughtSignature", () => {
    it("adds reasoning_details to assistant message", () => {
      const msg = assistantMsg([
        {
          type: "toolCall",
          id: "tc-1",
          name: "test",
          arguments: {},
          thoughtSignature: JSON.stringify({
            type: "reasoning.encrypted",
            id: "tc-1",
            data: "encrypted-data",
          }),
        },
      ]);
      const result = convertMessages(model, ctx([msg]), DEFAULT_COMPAT);
      const assistant = result[0] as any;
      expect(assistant.reasoning_details).toHaveLength(1);
      expect(assistant.reasoning_details[0]).toEqual({
        type: "reasoning.encrypted",
        id: "tc-1",
        data: "encrypted-data",
      });
    });
  });

  describe("sanitizeSurrogates", () => {
    it("removes unpaired surrogates from text content", () => {
      const unpaired = String.fromCharCode(0xd83d); // high surrogate without low
      const msg = userMsg(`Hello ${unpaired} World`);
      const result = convertMessages(model, ctx([msg]), DEFAULT_COMPAT);
      expect((result[0] as any).content).toBe("Hello  World");
    });
  });
});
