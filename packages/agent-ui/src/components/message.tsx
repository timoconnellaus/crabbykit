import type { AgentMessage } from "@claw-for-cloudflare/agent-runtime";
import type { CommandResultTag } from "@claw-for-cloudflare/agent-runtime/client";
import { type ComponentPropsWithoutRef, useMemo } from "react";
import type { ToolResultInfo } from "./message-list";

/** Format a timestamp as a relative time string (e.g., "2m ago", "1h ago"). */
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** AgentMessage with an optional streaming flag added during live updates. */
// biome-ignore lint/style/useNamingConvention: _streaming/_thinking are conventions for internal transient state
type StreamableMessage = AgentMessage & {
  _streaming?: boolean;
  _thinking?: string;
} & Partial<CommandResultTag>;

export interface MessageProps extends ComponentPropsWithoutRef<"div"> {
  message: StreamableMessage;
  /** Map from toolCallId to result info. When provided, results render inline beneath tool calls. */
  toolResultMap?: Map<string, ToolResultInfo>;
}

/** Extract text content from an AgentMessage or content array. */
function getTextContent(message: StreamableMessage): string {
  const { content } = message as { content: unknown };
  return extractTextFromContent(content);
}

/** Extract text from a content value (string, array, or nested result object). */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          b != null && typeof b === "object" && "type" in b && b.type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/**
 * Extract human-readable text from a tool result value.
 * Handles: AgentMessage (with role/content), raw content arrays,
 * result objects ({content, details}), and JSON-stringified variants.
 */
export function extractResultText(value: unknown): string {
  if (value == null) return "";

  // AgentMessage with content field (from persisted toolResult messages)
  if (typeof value === "object" && "content" in value) {
    const obj = value as { content: unknown };
    const text = extractTextFromContent(obj.content);
    if (text) return cleanToolResultText(text);
  }

  // Plain string (legacy JSON.stringify'd results)
  if (typeof value === "string") return cleanToolResultText(value);

  return "";
}

/** Try to extract human-readable text from a tool result that may be wrapped in JSON. */
function cleanToolResultText(raw: string): string {
  if (!raw.startsWith("{") && !raw.startsWith("[")) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed != null &&
      typeof parsed === "object" &&
      "content" in parsed &&
      Array.isArray((parsed as { content: unknown }).content)
    ) {
      const texts = (parsed as { content: Array<{ type: string; text?: string }> }).content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      if (texts.length > 0) return texts.join("\n");
    }
  } catch {
    // Not valid JSON — return as-is
  }
  return raw;
}

/** Extract image content blocks from a message. */
function getImageBlocks(message: StreamableMessage): Array<{
  type: "image";
  source?: { type: string; media_type?: string; data?: string };
  url?: string;
}> {
  const { content } = message as { content: unknown };
  if (!Array.isArray(content)) return [];
  return content.filter(
    (
      b,
    ): b is {
      type: "image";
      source?: { type: string; media_type?: string; data?: string };
      url?: string;
    } => b != null && typeof b === "object" && "type" in b && b.type === "image",
  );
}

/** Extract tool calls from an assistant message. */
function getToolCalls(message: StreamableMessage): Array<{
  type: "toolCall";
  toolCallId?: string;
  id?: string;
  toolName?: string;
  name?: string;
  args?: unknown;
  arguments?: Record<string, unknown>;
}> {
  const { content } = message as { content: unknown };
  if (!Array.isArray(content)) return [];
  return content.filter(
    (
      b,
    ): b is {
      type: "toolCall";
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      args?: unknown;
      arguments?: Record<string, unknown>;
    } => b != null && typeof b === "object" && "type" in b && b.type === "toolCall",
  );
}

/** Lightweight markdown → HTML for assistant messages. No external deps. */
function renderMarkdown(text: string): string {
  let html = text
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre><code>${code.trimEnd()}</code></pre>`,
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Headings (### ... )
  html = html.replace(/^### (.+)$/gm, "<strong>$1</strong>");
  html = html.replace(/^## (.+)$/gm, "<strong>$1</strong>");
  html = html.replace(/^# (.+)$/gm, "<strong>$1</strong>");

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // Unordered lists (- item)
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
  // Collapse adjacent </ul><ul>
  html = html.replace(/<\/ul>\s*<ul>/g, "");

  // Ordered lists (1. item)
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Line breaks (double newline → paragraph break, single → <br>)
  html = html.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>");

  return `<p>${html}</p>`.replace(/<p><\/p>/g, "");
}

/** Check if a message is an A2A system note (task result injected by callback handler). */
function isA2ASystemNote(role: string, text: string): boolean {
  return role === "user" && text.startsWith("[A2A Task");
}

/** Parse an A2A system note into structured parts. */
function parseA2ANote(text: string): { status: "complete" | "failed" | "other"; body: string } {
  const status = text.startsWith("[A2A Task Complete]")
    ? ("complete" as const)
    : text.startsWith("[A2A Task Failed]")
      ? ("failed" as const)
      : ("other" as const);
  // Strip the prefix tag to get the body
  const body = text.replace(/^\[A2A Task[^\]]*\]\s*/, "");
  return { status, body };
}

export function Message({ message, toolResultMap, ...props }: MessageProps) {
  const role = ("role" in message ? message.role : "unknown") ?? "unknown";
  const text = getTextContent(message);
  const toolCalls = role === "assistant" ? getToolCalls(message) : [];
  const imageBlocks = getImageBlocks(message);
  const isStreaming = !!message._streaming;
  const isCommandResult = !!message._commandResult;
  const thinkingText = (message as StreamableMessage)._thinking;
  const timestamp = "timestamp" in message ? (message.timestamp as number) : undefined;

  const toolResultName = "toolName" in message ? (message.toolName as string) : "";
  const renderedHtml = useMemo(
    () => (role === "assistant" && text && !isCommandResult ? renderMarkdown(text) : null),
    [role, text, isCommandResult],
  );

  // A2A task results render as system notes, not user bubbles
  if (isA2ASystemNote(role, text)) {
    const { status, body } = parseA2ANote(text);
    return (
      <div data-agent-ui="a2a-note" data-status={status} {...props}>
        <span data-agent-ui="a2a-note-tag">
          {status === "complete"
            ? "Task complete"
            : status === "failed"
              ? "Task failed"
              : "Task update"}
        </span>
        <span data-agent-ui="a2a-note-body">{body}</span>
      </div>
    );
  }

  if (isCommandResult) {
    return (
      <div
        data-agent-ui="command-result"
        data-command={message._commandName}
        data-error={message._isError || undefined}
        {...props}
      >
        <span data-agent-ui="command-result-label">/{message._commandName}</span>
        <div data-agent-ui="command-result-content">{text}</div>
      </div>
    );
  }

  return (
    <div
      data-agent-ui="message"
      data-role={role}
      data-streaming={isStreaming || undefined}
      {...props}
    >
      {role !== "toolResult" && <div data-agent-ui="message-role">{role}</div>}

      {thinkingText && (
        <details data-agent-ui="thinking-fold">
          <summary>Thinking</summary>
          <div data-agent-ui="thinking-fold-content">{thinkingText}</div>
        </details>
      )}

      {text &&
        role !== "toolResult" &&
        (renderedHtml ? (
          <div
            data-agent-ui="message-content"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendered from agent text content, not user input
            // biome-ignore lint/style/useNamingConvention: React API requires __html key
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : (
          <div data-agent-ui="message-content">{text}</div>
        ))}

      {imageBlocks.map((img, i) => {
        const src =
          img.source?.type === "base64" && img.source.data
            ? `data:${img.source.media_type ?? "image/png"};base64,${img.source.data}`
            : (img.url ?? undefined);
        if (!src) return null;
        return (
          <img
            // biome-ignore lint/suspicious/noArrayIndexKey: Image blocks don't have stable IDs
            key={i}
            data-agent-ui="message-image"
            src={src}
            alt="Image content"
          />
        );
      })}

      {toolCalls.map((tc, i) => {
        const callId = tc.toolCallId ?? tc.id;
        const toolResult = callId ? toolResultMap?.get(callId) : undefined;

        return (
          <div key={callId ?? i} data-agent-ui="tool-call" data-tool={tc.toolName ?? tc.name}>
            <span data-agent-ui="tool-call-name">{tc.toolName ?? tc.name}</span>
            {(tc.args ?? tc.arguments) && (
              <pre data-agent-ui="tool-call-args">
                {JSON.stringify(tc.args ?? tc.arguments, null, 2)}
              </pre>
            )}

            {toolResult?.status === "executing" && (
              <div data-agent-ui="tool-result-inline" data-status="executing">
                <span data-agent-ui="tool-result-spinner" />
                Running...
              </div>
            )}
            {toolResult?.status === "streaming" && (
              <div data-agent-ui="tool-result-inline" data-status="streaming">
                <pre data-agent-ui="tool-result-content">{toolResult.content}</pre>
                <span data-agent-ui="tool-result-spinner" />
              </div>
            )}
            {toolResult?.status === "complete" && (
              <div
                data-agent-ui="tool-result-inline"
                data-status="complete"
                data-error={toolResult.isError || undefined}
              >
                <pre data-agent-ui="tool-result-content">{toolResult.content}</pre>
              </div>
            )}
          </div>
        );
      })}

      {role === "toolResult" && (
        <div
          data-agent-ui="tool-result"
          data-error={("isError" in message && message.isError) || undefined}
        >
          {toolResultName && <span data-agent-ui="tool-result-name">{toolResultName}</span>}
          <pre data-agent-ui="tool-result-content">{extractResultText(message)}</pre>
        </div>
      )}

      {timestamp != null && (
        <div data-agent-ui="message-timestamp">{formatRelativeTime(timestamp)}</div>
      )}
    </div>
  );
}
