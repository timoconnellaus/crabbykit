import type { UseAgentChatReturn } from "@claw-for-cloudflare/agent-runtime/client";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { ChatInput } from "./chat-input";
import { ChatProvider } from "./chat-provider";
import { MessageList } from "./message-list";
import { StatusBar } from "./status-bar";

export interface ChatPanelProps extends ComponentPropsWithoutRef<"div"> {
  /** The chat hook return value. */
  chat: UseAgentChatReturn;
  /** Override the default layout with custom children. */
  children?: ReactNode;
}

/**
 * All-in-one chat panel. Wraps ChatProvider and renders
 * StatusBar + MessageList + ChatInput by default.
 * Pass children to fully customise the layout.
 */
export const ChatPanel = forwardRef<HTMLDivElement, ChatPanelProps>(function ChatPanel(
  { chat, children, ...props },
  ref,
) {
  return (
    <ChatProvider chat={chat}>
      <div data-agent-ui="chat-panel" ref={ref} {...props}>
        {children ?? (
          <>
            <StatusBar />
            <MessageList />
            <ChatInput />
          </>
        )}
      </div>
    </ChatProvider>
  );
});
