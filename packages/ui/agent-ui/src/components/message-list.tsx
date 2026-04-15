import type { AgentMessage } from "@claw-for-cloudflare/agent-runtime";
import { type ToolState, useChatSession } from "@claw-for-cloudflare/agent-runtime/client";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ComponentPropsWithoutRef,
  Fragment,
  forwardRef,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { extractResultText, Message } from "./message";

/** Threshold above which virtualization is enabled. */
const VIRTUALIZATION_THRESHOLD = 100;

export type ToolResultInfo =
  | { status: "executing"; toolName: string }
  | { status: "streaming"; toolName: string; content: string }
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
    } else if (state.status === "streaming") {
      map.set(toolCallId, {
        status: "streaming",
        toolName: state.toolName,
        content: extractResultText(state.partialResult),
      });
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

/** Extract role from a message, defaulting to "unknown". */
function getRole(msg: AgentMessage): string {
  return ("role" in msg ? (msg.role as string) : "unknown") ?? "unknown";
}

export interface MessageListProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** Custom message renderer. Falls back to built-in <Message> component. */
  renderMessage?: (message: AgentMessage, index: number) => ReactNode;
}

export const MessageList = forwardRef<HTMLDivElement, MessageListProps>(function MessageList(
  { renderMessage, dir: _dir, ...props },
  ref,
) {
  const { messages, toolStates, agentStatus, thinking, error } = useChatSession();
  const endRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;

  const { displayMessages, toolResultMap } = useMemo(() => {
    const trMap = buildToolResultMap(messages, toolStates);
    const display = messages.filter((msg) => {
      // Filter out toolResult messages — they render inline with their tool calls
      if ("role" in msg && msg.role === "toolResult") return false;
      // Filter out messages marked as hidden via metadata
      if ("metadata" in msg) {
        const meta = (msg as { metadata?: { hidden?: boolean } }).metadata;
        if (meta?.hidden) return false;
      }
      return true;
    });
    return { displayMessages: display, toolResultMap: trMap };
  }, [messages, toolStates]);

  const useVirtual = !renderMessage && displayMessages.length > VIRTUALIZATION_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 80,
    overscan: 10,
    enabled: useVirtual,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll to bottom when message count changes
  useEffect(() => {
    if (useVirtual) {
      virtualizer.scrollToIndex(displayMessages.length - 1, { align: "end", behavior: "smooth" });
    } else {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageCount]);

  return (
    <ScrollArea.Root
      data-agent-ui="message-list-root"
      role="log"
      aria-live="polite"
      ref={ref}
      {...props}
    >
      <ScrollArea.Viewport data-agent-ui="message-list-viewport" ref={viewportRef}>
        {messages.length === 0 && agentStatus === "idle" && !error && (
          <div data-agent-ui="message-list-empty">Send a message to get started</div>
        )}
        {renderMessage ? (
          messages.map((msg, i) => renderMessage(msg, i))
        ) : useVirtual ? (
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const idx = virtualRow.index;
              return (
                <div
                  key={idx}
                  data-index={idx}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <Message
                    message={displayMessages[idx]}
                    toolResultMap={toolResultMap}
                    liveThinking={
                      idx === displayMessages.length - 1 &&
                      getRole(displayMessages[idx]) === "assistant" &&
                      agentStatus !== "idle"
                        ? thinking
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        ) : (
          displayMessages.map((msg, i) => {
            const currRole = getRole(msg);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: Messages don't have stable IDs during streaming
              <Fragment key={i}>
                <Message
                  message={msg}
                  toolResultMap={toolResultMap}
                  liveThinking={
                    i === displayMessages.length - 1 &&
                    currRole === "assistant" &&
                    agentStatus !== "idle"
                      ? thinking
                      : undefined
                  }
                />
              </Fragment>
            );
          })
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
