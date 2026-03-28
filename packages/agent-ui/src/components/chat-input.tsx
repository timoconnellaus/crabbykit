import {
  type ComponentPropsWithoutRef,
  type FormEvent,
  forwardRef,
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { useChat } from "./chat-provider";
import { CommandPicker } from "./command-picker";

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
  const { sendMessage, abort, agentStatus, availableCommands } = useChat();
  const isRunning = agentStatus !== "idle";
  const [text, setText] = useState("");
  const pickerVisibleRef = useRef(false);

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
      if (!pickerVisibleRef.current) submit();
    },
    [submit],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // When command picker is visible, it captures Enter/Escape/Arrow/Tab via document listener
      if (pickerVisibleRef.current) return;

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
      <CommandPicker
        input={text}
        commands={availableCommands}
        onPick={(cmd) => {
          sendMessage(`/${cmd.name}`);
          setText("");
        }}
        onAutocomplete={(cmd) => setText(`/${cmd.name} `)}
        onDismiss={() => setText("")}
        onVisibilityChange={(v) => {
          pickerVisibleRef.current = v;
        }}
      />
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
