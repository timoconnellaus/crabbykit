import type { CommandInfo } from "@claw-for-cloudflare/agent-runtime/client";
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface CommandPickerProps extends ComponentPropsWithoutRef<"div"> {
  /** Current text input value. Picker shows when this starts with "/". */
  input: string;
  /** Available commands to show. */
  commands: CommandInfo[];
  /** Called when a command should be executed (Enter pressed or clicked). */
  onPick: (command: CommandInfo) => void;
  /** Called when a command should be autocompleted (Tab pressed). */
  onAutocomplete?: (command: CommandInfo) => void;
  /** Called when the picker should be dismissed (Escape pressed). */
  onDismiss?: () => void;
  /** Called when picker visibility changes. */
  onVisibilityChange?: (visible: boolean) => void;
}

/** Match commands by prefix. Returns all commands when query is empty. */
function matchCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  if (!query) return commands;
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * A command autocomplete picker that appears when the user types "/".
 * Renders a floating panel with matching commands, keyboard navigation,
 * and mouse selection.
 *
 * Place this component adjacent to (above) the chat input. It is
 * absolutely positioned relative to its nearest positioned ancestor.
 *
 * @example
 * ```tsx
 * <div style={{ position: "relative" }}>
 *   <CommandPicker
 *     input={text}
 *     commands={availableCommands}
 *     onPick={(cmd) => setText(`/${cmd.name} `)}
 *     onDismiss={() => setText("")}
 *   />
 *   <textarea value={text} ... />
 * </div>
 * ```
 */
export const CommandPicker = forwardRef<HTMLDivElement, CommandPickerProps>(function CommandPicker(
  { input, commands, onPick, onAutocomplete, onDismiss, onVisibilityChange, ...props },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const query = input.startsWith("/") ? input.slice(1) : "";
  const matches = useMemo(() => matchCommands(commands, query), [commands, query]);
  const visible = input.startsWith("/") && matches.length > 0;

  // Notify parent of visibility changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only fire when visibility changes
  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible]);

  // Reset selection when matches change
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset index when match list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [matches.length, query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-agent-ui='command-picker-item']");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % matches.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + matches.length) % matches.length);
          break;
        case "Enter":
          e.preventDefault();
          if (matches[selectedIndex]) {
            onPick(matches[selectedIndex]);
          }
          break;
        case "Tab":
          e.preventDefault();
          if (matches[selectedIndex]) {
            (onAutocomplete ?? onPick)(matches[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onDismiss?.();
          break;
      }
    },
    [visible, matches, selectedIndex, onPick, onDismiss],
  );

  // Attach keyboard listener to document so it captures events from the textarea
  useEffect(() => {
    if (!visible) return;
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [visible, handleKeyDown]);

  if (!visible) return null;

  return (
    <div data-agent-ui="command-picker" ref={ref} {...props}>
      <div data-agent-ui="command-picker-panel" ref={listRef} role="listbox">
        {matches.map((cmd, i) => (
          <button
            key={cmd.name}
            type="button"
            data-agent-ui="command-picker-item"
            role="option"
            aria-selected={i === selectedIndex}
            data-selected={i === selectedIndex || undefined}
            onMouseDown={(e) => {
              e.preventDefault(); // prevent textarea blur
              onPick(cmd);
            }}
            onMouseEnter={() => setSelectedIndex(i)}
          >
            <svg
              data-agent-ui="command-picker-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Command"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <div data-agent-ui="command-picker-text">
              <span data-agent-ui="command-picker-name">
                <span data-agent-ui="command-picker-slash">/</span>
                {cmd.name}
              </span>
              <span data-agent-ui="command-picker-desc">{cmd.description}</span>
            </div>
            <kbd data-agent-ui="command-picker-hint">&crarr;</kbd>
          </button>
        ))}
        <div data-agent-ui="command-picker-footer">
          <span>
            {matches.length} command{matches.length !== 1 ? "s" : ""}
          </span>
          <div data-agent-ui="command-picker-shortcuts">
            <span>
              <kbd>&crarr;</kbd> run
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});
