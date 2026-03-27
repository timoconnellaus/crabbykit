import {
  type ComponentPropsWithoutRef,
  type FormEvent,
  forwardRef,
  type KeyboardEvent,
  useCallback,
  useState,
} from "react";
import { useChat } from "./chat-provider";

export interface ChatInputProps extends Omit<ComponentPropsWithoutRef<"form">, "onSubmit"> {
  /** Placeholder text for the input. */
  placeholder?: string;
  /** Called after a message is sent. */
  onSend?: (text: string) => void;
}

export const ChatInput = forwardRef<HTMLFormElement, ChatInputProps>(function ChatInput(
  { placeholder = "Type a message...", onSend, ...props },
  ref,
) {
  const { sendMessage, abort, agentStatus } = useChat();
  const isRunning = agentStatus !== "idle";
  const [text, setText] = useState("");

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setText("");
    onSend?.(trimmed);
  }, [text, sendMessage, onSend]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      submit();
    },
    [submit],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <form
      data-agent-ui="chat-input"
      data-status={agentStatus}
      ref={ref}
      onSubmit={handleSubmit}
      {...props}
    >
      <textarea
        data-agent-ui="chat-input-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
      />
      {isRunning ? (
        <button data-agent-ui="chat-input-abort" type="button" onClick={abort}>
          Stop
        </button>
      ) : (
        <button data-agent-ui="chat-input-submit" type="submit" disabled={!text.trim()}>
          Send
        </button>
      )}
    </form>
  );
});
