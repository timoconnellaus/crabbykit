import type { AgentMessage } from "@claw-for-cloudflare/agent-runtime";
import type { ComponentPropsWithoutRef } from "react";

/** AgentMessage with an optional streaming flag added during live updates. */
// biome-ignore lint/style/useNamingConvention: _streaming is a convention for internal transient state
type StreamableMessage = AgentMessage & { _streaming?: boolean };

export interface MessageProps extends ComponentPropsWithoutRef<"div"> {
  message: StreamableMessage;
}

/** Extract text content from an AgentMessage. */
function getTextContent(message: StreamableMessage): string {
  const { content } = message as { content: unknown };
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

export function Message({ message, ...props }: MessageProps) {
  const role = ("role" in message ? message.role : "unknown") ?? "unknown";
  const text = getTextContent(message);
  const toolCalls = role === "assistant" ? getToolCalls(message) : [];
  const isStreaming = !!message._streaming;

  return (
    <div
      data-agent-ui="message"
      data-role={role}
      data-streaming={isStreaming || undefined}
      {...props}
    >
      <div data-agent-ui="message-role">{role}</div>

      {text && <div data-agent-ui="message-content">{text}</div>}

      {toolCalls.map((tc, i) => (
        <div
          key={tc.toolCallId ?? tc.id ?? i}
          data-agent-ui="tool-call"
          data-tool={tc.toolName ?? tc.name}
        >
          <span data-agent-ui="tool-call-name">{tc.toolName ?? tc.name}</span>
          {(tc.args ?? tc.arguments) && (
            <pre data-agent-ui="tool-call-args">
              {JSON.stringify(tc.args ?? tc.arguments, null, 2)}
            </pre>
          )}
        </div>
      ))}

      {role === "toolResult" && (
        <div
          data-agent-ui="tool-result"
          data-error={("isError" in message && message.isError) || undefined}
        >
          <span data-agent-ui="tool-result-name">
            {"toolName" in message ? (message.toolName as string) : ""}
          </span>
          <pre data-agent-ui="tool-result-content">{text}</pre>
        </div>
      )}
    </div>
  );
}
