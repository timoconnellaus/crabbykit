import type { UseAgentChatReturn } from "@claw-for-cloudflare/agent-runtime/client";
import { createContext, type ReactNode, useContext } from "react";

const ChatContext = createContext<UseAgentChatReturn | null>(null);

export function useChat(): UseAgentChatReturn {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within <ChatProvider>");
  return ctx;
}

export interface ChatProviderProps {
  chat: UseAgentChatReturn;
  children: ReactNode;
}

export function ChatProvider({ chat, children }: ChatProviderProps) {
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}
