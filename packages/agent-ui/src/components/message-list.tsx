import type { AgentMessage } from "@claw-for-cloudflare/agent-runtime";
import type { ToolState } from "@claw-for-cloudflare/agent-runtime/client";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useChat } from "./chat-provider";
import { extractResultText, Message } from "./message";

export type ToolResultInfo =
  | { status: "executing"; toolName: string }
  | { status: "complete"; toolName: string; content: string; isError: boolean };

/** Build a map from toolCallId → ToolResultInfo, merging persisted messages and live tool states. */
function buildToolResultMap(
  messages: AgentMessage[],
  toolStates: Map<string, ToolState>,
): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();

  // Extract from persisted toolResult messages
  for (const msg of messages) {
    if (!("role" in msg) || msg.role !== "toolResult") continue;
    const toolCallId = "toolCallId" in msg ? (msg.toolCallId as string) : undefined;
    if (!toolCallId) continue;
    map.set(toolCallId, {
      status: "complete",
      toolName: ("toolName" in msg ? (msg.toolName as string) : undefined) ?? "",
      content: extractResultText(msg),
      isError: ("isError" in msg && (msg.isError as boolean)) || false,
    });
  }

  // Overlay live tool states (take precedence — they exist before toolResult messages arrive)
  for (const [toolCallId, state] of toolStates) {
    if (map.has(toolCallId)) continue;
    if (state.status === "executing") {
      map.set(toolCallId, { status: "executing", toolName: state.toolName });
    } else {
      map.set(toolCallId, {
        status: "complete",
        toolName: state.toolName,
        content: extractResultText(state.result),
        isError: state.isError,
      });
    }
  }

  return map;
}

export interface MessageListProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** Custom message renderer. Falls back to built-in <Message> component. */
  renderMessage?: (message: AgentMessage, index: number) => ReactNode;
}

export const MessageList = forwardRef<HTMLDivElement, MessageListProps>(function MessageList(
  { renderMessage, dir: _dir, ...props },
  ref,
) {
  const { messages, toolStates, thinking, error } = useChat();
  const endRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;

  const { displayMessages, toolResultMap } = useMemo(() => {
    const trMap = buildToolResultMap(messages, toolStates);
    // Filter out toolResult messages — they render inline with their tool calls
    const display = messages.filter((msg) => !("role" in msg && msg.role === "toolResult"));
    return { displayMessages: display, toolResultMap: trMap };
  }, [messages, toolStates]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll to bottom when message count changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  return (
    <ScrollArea.Root data-agent-ui="message-list-root" ref={ref} {...props}>
      <ScrollArea.Viewport data-agent-ui="message-list-viewport">
        {renderMessage
          ? messages.map((msg, i) => renderMessage(msg, i))
          : displayMessages.map((msg, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Messages don't have stable IDs during streaming
              <Message key={i} message={msg} toolResultMap={toolResultMap} />
            ))}
        {thinking != null && (
          <div data-agent-ui="thinking">
            <span data-agent-ui="thinking-indicator" />
            {thinking || "Thinking..."}
          </div>
        )}
        {error && <div data-agent-ui="error-banner">{error}</div>}
        <div ref={endRef} />
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical" data-agent-ui="message-list-scrollbar">
        <ScrollArea.Thumb data-agent-ui="message-list-thumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
});
