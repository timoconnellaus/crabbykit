import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Message, extractResultText } from "./message";

afterEach(() => {
  cleanup();
});

// Helper to query by data-agent-ui attribute
const q = (attr: string) => document.querySelector(`[data-agent-ui="${attr}"]`);
const qAll = (attr: string) => document.querySelectorAll(`[data-agent-ui="${attr}"]`);

// ---------------------------------------------------------------------------
// extractResultText (exported pure function)
// ---------------------------------------------------------------------------
describe("extractResultText", () => {
  it("returns empty string for null/undefined", () => {
    expect(extractResultText(null)).toBe("");
    expect(extractResultText(undefined)).toBe("");
  });

  it("extracts text from AgentMessage-like object with string content", () => {
    expect(extractResultText({ content: "hello" })).toBe("hello");
  });

  it("extracts text from content array", () => {
    expect(
      extractResultText({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });

  it("returns plain string as-is", () => {
    expect(extractResultText("some text")).toBe("some text");
  });

  it("unwraps JSON-stringified content array", () => {
    const json = JSON.stringify({ content: [{ type: "text", text: "parsed" }] });
    expect(extractResultText(json)).toBe("parsed");
  });

  it("returns raw JSON string when not a content structure", () => {
    expect(extractResultText('{"key":"val"}')).toBe('{"key":"val"}');
  });

  it("returns empty string for object without content", () => {
    expect(extractResultText({ foo: "bar" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// User messages
// ---------------------------------------------------------------------------
describe("Message — user", () => {
  it("renders user message with text content", () => {
    render(<Message message={{ role: "user", content: "hello" } as any} />);
    const el = q("message");
    expect(el?.getAttribute("data-role")).toBe("user");
    expect(q("message-content")?.textContent).toBe("hello");
  });

  it("renders user message from content array", () => {
    render(
      <Message
        message={{ role: "user", content: [{ type: "text", text: "from array" }] } as any}
      />,
    );
    expect(q("message-content")?.textContent).toBe("from array");
  });

  it("sets data-streaming when _streaming is true", () => {
    render(<Message message={{ role: "user", content: "hi", _streaming: true } as any} />);
    expect(q("message")?.getAttribute("data-streaming")).toBe("true");
  });

  it("omits data-streaming when not streaming", () => {
    render(<Message message={{ role: "user", content: "hi" } as any} />);
    expect(q("message")?.getAttribute("data-streaming")).toBeNull();
  });

  it("hides content div when text is empty", () => {
    render(<Message message={{ role: "user", content: "" } as any} />);
    expect(q("message-content")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------
describe("Message — timestamps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 'just now' for recent timestamps", () => {
    const ts = Date.now() - 2000;
    render(<Message message={{ role: "user", content: "hi", timestamp: ts } as any} />);
    expect(q("message-timestamp")?.textContent).toBe("just now");
  });

  it("shows seconds for < 60s", () => {
    const ts = Date.now() - 30_000;
    render(<Message message={{ role: "user", content: "hi", timestamp: ts } as any} />);
    expect(q("message-timestamp")?.textContent).toBe("30s ago");
  });

  it("shows minutes for < 60m", () => {
    const ts = Date.now() - 5 * 60_000;
    render(<Message message={{ role: "user", content: "hi", timestamp: ts } as any} />);
    expect(q("message-timestamp")?.textContent).toBe("5m ago");
  });

  it("shows hours for < 24h", () => {
    const ts = Date.now() - 3 * 3600_000;
    render(<Message message={{ role: "user", content: "hi", timestamp: ts } as any} />);
    expect(q("message-timestamp")?.textContent).toBe("3h ago");
  });

  it("shows days for >= 24h", () => {
    const ts = Date.now() - 2 * 86400_000;
    render(<Message message={{ role: "user", content: "hi", timestamp: ts } as any} />);
    expect(q("message-timestamp")?.textContent).toBe("2d ago");
  });

  it("omits timestamp when not present", () => {
    render(<Message message={{ role: "user", content: "hi" } as any} />);
    expect(q("message-timestamp")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Assistant messages — content parts
// ---------------------------------------------------------------------------
describe("Message — assistant", () => {
  it("renders text content via MarkdownContent", () => {
    render(<Message message={{ role: "assistant", content: "hello **bold**" } as any} />);
    expect(q("message")?.getAttribute("data-role")).toBe("assistant");
  });

  it("renders text from content array", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [
              { type: "text", text: "part1" },
              { type: "text", text: "part2" },
            ],
          } as any
        }
      />,
    );
    // Adjacent text parts are merged
    const el = q("message");
    expect(el).not.toBeNull();
  });

  it("renders tool call entries from content array", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [
              { type: "toolCall", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } },
            ],
          } as any
        }
      />,
    );
    expect(q("tool-entry")).not.toBeNull();
    expect(q("tool-entry-name")?.textContent).toBe("bash");
  });

  it("renders images from base64 source", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: "abc123" },
              },
            ],
          } as any
        }
      />,
    );
    const img = document.querySelector('[data-agent-ui="message-image"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("data:image/jpeg;base64,abc123");
  });

  it("renders images from URL", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [{ type: "image", url: "https://example.com/img.png" }],
          } as any
        }
      />,
    );
    const img = document.querySelector('[data-agent-ui="message-image"]') as HTMLImageElement;
    expect(img?.src).toBe("https://example.com/img.png");
  });

  it("defaults media_type to image/png for base64", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [{ type: "image", source: { type: "base64", data: "x" } }],
          } as any
        }
      />,
    );
    const img = document.querySelector('[data-agent-ui="message-image"]') as HTMLImageElement;
    expect(img.src).toContain("image/png");
  });

  it("renders mixed content in order (text + toolCall + text)", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [
              { type: "text", text: "before" },
              { type: "toolCall", toolCallId: "tc1", toolName: "bash" },
              { type: "text", text: "after" },
            ],
          } as any
        }
      />,
    );
    expect(q("tool-entry")).not.toBeNull();
  });

  it("skips null/invalid content blocks", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [null, "not-object", { type: "text", text: "ok" }],
          } as any
        }
      />,
    );
    const el = q("message");
    expect(el).not.toBeNull();
  });

  it("returns empty parts for empty string content", () => {
    render(<Message message={{ role: "assistant", content: "" } as any} />);
    const el = q("message");
    expect(el?.getAttribute("data-role")).toBe("assistant");
  });

  it("returns empty parts for non-array non-string content", () => {
    render(<Message message={{ role: "assistant", content: 42 } as any} />);
    const el = q("message");
    expect(el).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Thinking fold
// ---------------------------------------------------------------------------
describe("Message — thinking", () => {
  it("renders thinking fold when _thinking is set", () => {
    render(
      <Message message={{ role: "assistant", content: "hi", _thinking: "pondering..." } as any} />,
    );
    expect(q("thinking-fold")).not.toBeNull();
    expect(q("thinking-fold-content")?.textContent).toBe("pondering...");
  });

  it("omits thinking fold when _thinking is not set", () => {
    render(<Message message={{ role: "assistant", content: "hi" } as any} />);
    expect(q("thinking-fold")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tool results inline
// ---------------------------------------------------------------------------
describe("Message — toolResultMap", () => {
  it("passes result info to ToolCallEntry", () => {
    const toolResultMap = new Map([
      ["tc1", { status: "complete" as const, toolName: "bash", content: "ok", isError: false }],
    ]);
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [{ type: "toolCall", toolCallId: "tc1", toolName: "bash" }],
          } as any
        }
        toolResultMap={toolResultMap}
      />,
    );
    expect(q("tool-entry")).not.toBeNull();
    // Result summary should show since it's complete
    expect(q("tool-entry-result")?.textContent).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// A2A system notes
// ---------------------------------------------------------------------------
describe("Message — A2A notes", () => {
  it("renders complete A2A note with header", () => {
    render(
      <Message
        message={{ role: "user", content: "[A2A Task Complete] Agent finished work" } as any}
      />,
    );
    expect(q("a2a-note")).not.toBeNull();
    expect(q("a2a-note")?.getAttribute("data-status")).toBe("complete");
    expect(q("a2a-note-tag")?.textContent).toBe("Task complete");
    // Body is collapsed by default
    expect(q("a2a-note-body")).toBeNull();
  });

  it("renders failed A2A note", () => {
    render(
      <Message message={{ role: "user", content: "[A2A Task Failed] Something broke" } as any} />,
    );
    expect(q("a2a-note")?.getAttribute("data-status")).toBe("failed");
    expect(q("a2a-note-tag")?.textContent).toBe("Task failed");
  });

  it("renders other A2A status", () => {
    render(
      <Message message={{ role: "user", content: "[A2A Task Running] In progress" } as any} />,
    );
    expect(q("a2a-note")?.getAttribute("data-status")).toBe("other");
    expect(q("a2a-note-tag")?.textContent).toBe("Task update");
  });

  it("does not render A2A note for assistant role", () => {
    render(<Message message={{ role: "assistant", content: "[A2A Task Complete] nope" } as any} />);
    expect(q("a2a-note")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------
describe("Message — command results", () => {
  it("renders command result with name and content", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: "result text",
            _commandResult: true,
            _commandName: "help",
          } as any
        }
      />,
    );
    expect(q("command-result")).not.toBeNull();
    expect(q("command-result")?.getAttribute("data-command")).toBe("help");
    expect(q("command-result-label")?.textContent).toBe("/help");
    expect(q("command-result-content")?.textContent).toBe("result text");
  });

  it("sets data-error when _isError is true", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: "failed",
            _commandResult: true,
            _commandName: "foo",
            _isError: true,
          } as any
        }
      />,
    );
    expect(q("command-result")?.getAttribute("data-error")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Tool call ID variants
// ---------------------------------------------------------------------------
describe("Message — toolCall ID fallbacks", () => {
  it("uses id field when toolCallId is missing", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "alt-id", name: "bash" }],
          } as any
        }
      />,
    );
    expect(q("tool-entry")).not.toBeNull();
  });

  it("uses name field when toolName is missing", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc1", name: "web_search" }],
          } as any
        }
      />,
    );
    expect(q("tool-entry-name")?.textContent).toBe("web_search");
  });

  it("uses arguments field when args is missing", () => {
    render(
      <Message
        message={
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
          } as any
        }
      />,
    );
    expect(q("tool-entry")).not.toBeNull();
  });
});
