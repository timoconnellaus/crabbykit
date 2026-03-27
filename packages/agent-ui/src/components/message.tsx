import type { ComponentPropsWithoutRef } from "react";

export interface MessageProps extends ComponentPropsWithoutRef<"div"> {
  message: any;
}

/** Extract text content from a pi-agent-core message. */
function getTextContent(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}

/** Extract tool calls from an assistant message. */
function getToolCalls(message: any): any[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((b: any) => b.type === "toolCall");
}

export function Message({ message, ...props }: MessageProps) {
  const role = message.role ?? "unknown";
  const text = getTextContent(message);
  const toolCalls = role === "assistant" ? getToolCalls(message) : [];
  const isStreaming = !!(message as any)._streaming;

  return (
    <div data-agent-ui="message" data-role={role} data-streaming={isStreaming || undefined} {...props}>
      <div data-agent-ui="message-role">{role}</div>

      {text && <div data-agent-ui="message-content">{text}</div>}

      {toolCalls.map((tc: any, i: number) => (
        <div key={tc.toolCallId ?? i} data-agent-ui="tool-call" data-tool={tc.toolName}>
          <span data-agent-ui="tool-call-name">{tc.toolName}</span>
          {tc.args && (
            <pre data-agent-ui="tool-call-args">
              {JSON.stringify(tc.args, null, 2)}
            </pre>
          )}
        </div>
      ))}

      {role === "toolResult" && (
        <div data-agent-ui="tool-result" data-error={message.isError || undefined}>
          <span data-agent-ui="tool-result-name">{message.toolName}</span>
          <pre data-agent-ui="tool-result-content">{text}</pre>
        </div>
      )}
    </div>
  );
}
