import {
  type ChangeEvent,
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const MAX_TEXTAREA_HEIGHT = 160;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, []);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      resizeTextarea();
    },
    [resizeTextarea],
  );

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setText("");
    onSend?.(trimmed);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
    }
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
        ref={textareaRef}
        data-agent-ui="chat-input-textarea"
        aria-label="Message input"
        value={text}
        onChange={handleChange}
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
