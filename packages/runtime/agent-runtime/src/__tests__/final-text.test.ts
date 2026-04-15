import { describe, expect, it } from "vitest";
import { extractFinalAssistantText } from "../agent-runtime-helpers.js";

describe("extractFinalAssistantText", () => {
  it("returns the empty string for an empty messages array", () => {
    expect(extractFinalAssistantText([])).toBe("");
  });

  it("returns the empty string when no assistant message exists", () => {
    const msgs = [
      { role: "user", content: "hello", timestamp: 1 },
      // biome-ignore lint/suspicious/noExplicitAny: shaped-to-AgentMessage test fixture
    ] as any;
    expect(extractFinalAssistantText(msgs)).toBe("");
  });

  it("returns the string content of the final assistant message", () => {
    const msgs = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello there", timestamp: 2 },
      // biome-ignore lint/suspicious/noExplicitAny: shaped-to-AgentMessage test fixture
    ] as any;
    expect(extractFinalAssistantText(msgs)).toBe("hello there");
  });

  it("concatenates text blocks from an array-content assistant message", () => {
    const msgs = [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first " },
          { type: "text", text: "second" },
        ],
        timestamp: 2,
      },
      // biome-ignore lint/suspicious/noExplicitAny: shaped-to-AgentMessage test fixture
    ] as any;
    expect(extractFinalAssistantText(msgs)).toBe("first second");
  });

  it("ignores non-text blocks like tool_use", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "the answer is " },
          { type: "tool_use", id: "t1", name: "calc" },
          { type: "text", text: "42" },
        ],
        timestamp: 1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: shaped-to-AgentMessage test fixture
    ] as any;
    expect(extractFinalAssistantText(msgs)).toBe("the answer is 42");
  });

  it("picks the LAST assistant message when multiple exist", () => {
    const msgs = [
      { role: "assistant", content: "intermediate", timestamp: 1 },
      { role: "toolResult", content: "tool", timestamp: 2 },
      { role: "assistant", content: "final", timestamp: 3 },
      // biome-ignore lint/suspicious/noExplicitAny: shaped-to-AgentMessage test fixture
    ] as any;
    expect(extractFinalAssistantText(msgs)).toBe("final");
  });

  it("returns the empty string for an assistant message with non-string, non-array content", () => {
    const msgs = [
      {
        role: "assistant",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed content
        content: { some: "object" } as any,
        timestamp: 1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: shaped-to-AgentMessage test fixture
    ] as any;
    expect(extractFinalAssistantText(msgs)).toBe("");
  });

  it("returns the empty string when the last assistant message has empty array content", () => {
    const msgs = [
      { role: "assistant", content: [], timestamp: 1 },
      // biome-ignore lint/suspicious/noExplicitAny: shaped-to-AgentMessage test fixture
    ] as any;
    expect(extractFinalAssistantText(msgs)).toBe("");
  });
});
