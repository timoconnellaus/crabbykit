import type { AgentMessage } from "@claw-for-cloudflare/agent-runtime";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { useChat } from "./chat-provider";
import { Message } from "./message";

export interface MessageListProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** Custom message renderer. Falls back to built-in <Message> component. */
  renderMessage?: (message: AgentMessage, index: number) => ReactNode;
}

export const MessageList = forwardRef<HTMLDivElement, MessageListProps>(function MessageList(
  { renderMessage, dir: _dir, ...props },
  ref,
) {
  const { messages } = useChat();
  const endRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll to bottom when message count changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  return (
    <ScrollArea.Root data-agent-ui="message-list-root" ref={ref} {...props}>
      <ScrollArea.Viewport data-agent-ui="message-list-viewport">
        {messages.map((msg, i) =>
          renderMessage ? (
            renderMessage(msg, i)
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: Messages don't have stable IDs during streaming
            <Message key={i} message={msg} />
          ),
        )}
        <div ref={endRef} />
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical" data-agent-ui="message-list-scrollbar">
        <ScrollArea.Thumb data-agent-ui="message-list-thumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
});
