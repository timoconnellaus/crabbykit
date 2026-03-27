import {
  forwardRef,
  useEffect,
  useRef,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from "react";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import { useChat } from "./chat-provider";
import { Message } from "./message";

export interface MessageListProps
  extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** Custom message renderer. Falls back to built-in <Message> component. */
  renderMessage?: (message: any, index: number) => ReactNode;
}

export const MessageList = forwardRef<HTMLDivElement, MessageListProps>(
  function MessageList({ renderMessage, ...props }, ref) {
    const { messages } = useChat();
    const endRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages.length]);

    return (
      <ScrollArea.Root data-agent-ui="message-list-root" ref={ref}>
        <ScrollArea.Viewport data-agent-ui="message-list-viewport">
          {messages.map((msg, i) =>
            renderMessage ? (
              renderMessage(msg, i)
            ) : (
              <Message key={i} message={msg} />
            ),
          )}
          <div ref={endRef} />
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          orientation="vertical"
          data-agent-ui="message-list-scrollbar"
        >
          <ScrollArea.Thumb data-agent-ui="message-list-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    );
  },
);
