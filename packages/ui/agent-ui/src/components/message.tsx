import type { AgentMessage } from "@crabbykit/agent-runtime";
import type { CommandResultTag } from "@crabbykit/agent-runtime/client";
import { type ComponentPropsWithoutRef, useState } from "react";
import { MarkdownContent } from "./markdown-content";
import type { ToolResultInfo } from "./message-list";
import { ToolCallEntry } from "./tool-call-entry";

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
type StreamableMessage = AgentMessage & {
  // biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
  _streaming?: boolean;
  // biome-ignore lint/style/useNamingConvention: _thinking is a convention for internal transient state
  _thinking?: string;
} & Partial<CommandResultTag>;

export interface MessageProps extends ComponentPropsWithoutRef<"div"> {
  message: StreamableMessage;
  /** Map from toolCallId to result info. When provided, results render inline beneath tool calls. */
  toolResultMap?: Map<string, ToolResultInfo>;
  /** Live reasoning text currently being streamed. When set, renders an active reasoning block instead of the completed fold. */
  liveThinking?: string | null;
}

// --- Content part types for ordered rendering ---

type ContentPart =
  | { kind: "text"; text: string }
  | {
      kind: "toolCall";
      toolCallId: string;
      toolName: string;
      args?: unknown;
    }
  | {
      kind: "image";
      src: string;
    };

/** Extract content parts from a message in their original order, merging adjacent text parts. */
function getContentParts(message: StreamableMessage): ContentPart[] {
  const { content } = message as { content: unknown };
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: ContentPart[] = [];
  let pendingText = "";

  for (const block of content) {
    if (block == null || typeof block !== "object" || !("type" in block)) continue;

    if (block.type === "text" && typeof block.text === "string") {
      pendingText += block.text;
    } else {
      // Flush accumulated text before non-text parts
      if (pendingText) {
        parts.push({ kind: "text", text: pendingText });
        pendingText = "";
      }

      if (block.type === "toolCall") {
        const tc = block as {
          toolCallId?: string;
          id?: string;
          toolName?: string;
          name?: string;
          args?: unknown;
          arguments?: Record<string, unknown>;
        };
        parts.push({
          kind: "toolCall",
          toolCallId: (tc.toolCallId ?? tc.id) || "",
          toolName: (tc.toolName ?? tc.name) || "",
          args: tc.args ?? tc.arguments,
        });
      } else if (block.type === "image") {
        const img = block as {
          source?: { type: string; media_type?: string; data?: string };
          url?: string;
        };
        const src =
          img.source?.type === "base64" && img.source?.data
            ? `data:${img.source.media_type ?? "image/png"};base64,${img.source.data}`
            : (img.url ?? undefined);
        if (src) {
          parts.push({ kind: "image", src });
        }
      }
    }
  }

  // Flush remaining text
  if (pendingText) {
    parts.push({ kind: "text", text: pendingText });
  }

  return parts;
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

/** Check if a message is an A2A system note (task result injected by callback handler). */
function isA2ASystemNote(role: string, text: string): boolean {
  return role === "user" && text.startsWith("[A2A Task");
}

/** Parse an A2A system note into structured parts. */
function parseA2ANote(text: string): {
  status: "complete" | "failed" | "other";
  agentName: string | null;
  summary: string;
  body: string;
} {
  const status = text.startsWith("[A2A Task Complete]")
    ? ("complete" as const)
    : text.startsWith("[A2A Task Failed]")
      ? ("failed" as const)
      : ("other" as const);
  const body = text.replace(/^\[A2A Task[^\]]*\]\s*/, "");

  // Extract agent name from patterns like: Agent "child-agent" finished.
  const agentMatch = body.match(/^Agent "([^"]+)"/);
  const agentName = agentMatch ? agentMatch[1] : null;

  // Extract result/error text after "Result: " or "Error: "
  const resultMatch = body.match(/\n(?:Result|Error): ([\s\S]*)$/);
  const summary = resultMatch ? resultMatch[1].trim() : body;

  return { status, agentName, summary, body };
}

/** Live reasoning block shown while the LLM is streaming reasoning tokens. */
function ReasoningBlock({ text }: { text: string }) {
  return (
    <div data-agent-ui="reasoning-live">
      <div data-agent-ui="reasoning-live-header">
        <span data-agent-ui="reasoning-live-indicator" />
        Reasoning
      </div>
      <div data-agent-ui="reasoning-live-content">{text}</div>
    </div>
  );
}

/** Collapsible A2A task note, styled to match tool-entry rows. */
function A2ANote({ text, ...props }: { text: string } & ComponentPropsWithoutRef<"div">) {
  const [open, setOpen] = useState(false);
  const { status, agentName, summary, body } = parseA2ANote(text);

  const label =
    status === "complete" ? "Task complete" : status === "failed" ? "Task failed" : "Task update";

  return (
    // biome-ignore lint/a11y/useSemanticElements: interactive div styled as collapsible panel
    <div
      data-agent-ui="a2a-note"
      data-status={status}
      data-open={open || undefined}
      role="button"
      tabIndex={0}
      onClick={() => {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        setOpen(!open);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(!open);
        }
      }}
      {...props}
    >
      <div data-agent-ui="a2a-note-header">
        <span data-agent-ui="a2a-note-indicator" data-status={status} />
        <span data-agent-ui="a2a-note-tag">{label}</span>
        {agentName && <span data-agent-ui="a2a-note-detail">{agentName}</span>}
      </div>

      {open && (
        <div
          data-agent-ui="a2a-note-body"
          role="none"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MarkdownContent content={summary || body} />
        </div>
      )}
    </div>
  );
}

export function Message({ message, toolResultMap, liveThinking, ...props }: MessageProps) {
  const role = ("role" in message ? message.role : "unknown") ?? "unknown";
  const text = getTextContent(message);
  const isStreaming = !!message._streaming;
  const isCommandResult = !!message._commandResult;
  const thinkingText = (message as StreamableMessage)._thinking;
  const timestamp = "timestamp" in message ? (message.timestamp as number) : undefined;

  // A2A task results render as system notes (tool-entry style)
  if (isA2ASystemNote(role, text)) {
    return <A2ANote text={text} {...props} />;
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

  // Assistant messages: render content parts in source order
  if (role === "assistant") {
    const contentParts = getContentParts(message);
    return (
      <div
        data-agent-ui="message"
        data-role="assistant"
        data-streaming={isStreaming || undefined}
        {...props}
      >
        {contentParts.map((part, i) => {
          if (part.kind === "text") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: Content parts don't have stable IDs
              <div key={i}>
                <MarkdownContent content={part.text} />
              </div>
            );
          }
          if (part.kind === "toolCall") {
            const result = part.toolCallId ? toolResultMap?.get(part.toolCallId) : undefined;
            return (
              <ToolCallEntry
                key={part.toolCallId || i}
                toolName={part.toolName}
                toolCallId={part.toolCallId}
                args={part.args}
                result={result}
              />
            );
          }
          if (part.kind === "image") {
            return (
              <img
                // biome-ignore lint/suspicious/noArrayIndexKey: Image blocks don't have stable IDs
                key={i}
                data-agent-ui="message-image"
                src={part.src}
                alt=""
              />
            );
          }
          return null;
        })}

        {liveThinking != null ? (
          <ReasoningBlock text={liveThinking} />
        ) : thinkingText ? (
          <details data-agent-ui="thinking-fold">
            <summary>Reasoning</summary>
            <div data-agent-ui="thinking-fold-content">{thinkingText}</div>
          </details>
        ) : null}

        {timestamp != null && (
          <div data-agent-ui="message-timestamp">{formatRelativeTime(timestamp)}</div>
        )}
      </div>
    );
  }

  // User messages: simple text with subtle background
  return (
    <div
      data-agent-ui="message"
      data-role={role}
      data-streaming={isStreaming || undefined}
      {...props}
    >
      {text && <div data-agent-ui="message-content">{text}</div>}

      {timestamp != null && (
        <div data-agent-ui="message-timestamp">{formatRelativeTime(timestamp)}</div>
      )}
    </div>
  );
}
