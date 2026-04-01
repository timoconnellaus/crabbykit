import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPicker } from "./command-picker";

// jsdom doesn't implement scrollIntoView
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

const q = (attr: string) => document.querySelector(`[data-agent-ui="${attr}"]`);
const qAll = (attr: string) => document.querySelectorAll(`[data-agent-ui="${attr}"]`);

const COMMANDS = [
  { name: "help", description: "Show help" },
  { name: "history", description: "Show history" },
  { name: "clear", description: "Clear chat" },
];

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------
describe("CommandPicker — visibility", () => {
  it("renders nothing when input does not start with /", () => {
    render(<CommandPicker input="hello" commands={COMMANDS} onPick={vi.fn()} />);
    expect(q("command-picker")).toBeNull();
  });

  it("renders when input starts with /", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    expect(q("command-picker")).not.toBeNull();
  });

  it("renders nothing when no commands match", () => {
    render(<CommandPicker input="/zzz" commands={COMMANDS} onPick={vi.fn()} />);
    expect(q("command-picker")).toBeNull();
  });

  it("calls onVisibilityChange when visibility changes", () => {
    const onVisChange = vi.fn();
    const { rerender } = render(
      <CommandPicker input="" commands={COMMANDS} onPick={vi.fn()} onVisibilityChange={onVisChange} />,
    );
    expect(onVisChange).toHaveBeenCalledWith(false);
    rerender(
      <CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} onVisibilityChange={onVisChange} />,
    );
    expect(onVisChange).toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
describe("CommandPicker — filtering", () => {
  it("shows all commands when query is empty (/)", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    expect(qAll("command-picker-item")).toHaveLength(3);
  });

  it("filters commands by prefix", () => {
    render(<CommandPicker input="/he" commands={COMMANDS} onPick={vi.fn()} />);
    const items = qAll("command-picker-item");
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('[data-agent-ui="command-picker-name"]')?.textContent).toContain("help");
  });

  it("filters case-insensitively", () => {
    render(<CommandPicker input="/HE" commands={COMMANDS} onPick={vi.fn()} />);
    expect(qAll("command-picker-item")).toHaveLength(1);
  });

  it("shows command count in footer", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    expect(q("command-picker-footer")?.textContent).toContain("3 commands");
  });

  it("uses singular 'command' for single match", () => {
    render(<CommandPicker input="/cl" commands={COMMANDS} onPick={vi.fn()} />);
    expect(q("command-picker-footer")?.textContent).toContain("1 command");
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
describe("CommandPicker — selection", () => {
  it("first item is selected by default", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    const items = qAll("command-picker-item");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(items[1].getAttribute("aria-selected")).toBe("false");
  });

  it("selects item on mouse enter", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    const items = qAll("command-picker-item");
    fireEvent.mouseEnter(items[2]);
    expect(items[2].getAttribute("aria-selected")).toBe("true");
    expect(items[0].getAttribute("aria-selected")).toBe("false");
  });

  it("resets selection when filter changes", () => {
    const { rerender } = render(
      <CommandPicker input="/h" commands={COMMANDS} onPick={vi.fn()} />,
    );
    // Two matches: help, history
    const items = qAll("command-picker-item");
    expect(items).toHaveLength(2);
    fireEvent.mouseEnter(items[1]); // select "history"

    // Type more to narrow
    rerender(<CommandPicker input="/he" commands={COMMANDS} onPick={vi.fn()} />);
    const newItems = qAll("command-picker-item");
    expect(newItems).toHaveLength(1);
    expect(newItems[0].getAttribute("aria-selected")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------
describe("CommandPicker — keyboard", () => {
  it("ArrowDown moves selection down", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    const items = qAll("command-picker-item");
    expect(items[1].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown wraps around", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" }); // wrap
    const items = qAll("command-picker-item");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowUp moves selection up (wraps)", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    fireEvent.keyDown(document, { key: "ArrowUp" }); // wrap to last
    const items = qAll("command-picker-item");
    expect(items[2].getAttribute("aria-selected")).toBe("true");
  });

  it("Enter picks the selected command", () => {
    const onPick = vi.fn();
    render(<CommandPicker input="/" commands={COMMANDS} onPick={onPick} />);
    fireEvent.keyDown(document, { key: "ArrowDown" }); // select "history"
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(COMMANDS[1]);
  });

  it("Tab calls onAutocomplete when provided", () => {
    const onAutocomplete = vi.fn();
    render(
      <CommandPicker
        input="/"
        commands={COMMANDS}
        onPick={vi.fn()}
        onAutocomplete={onAutocomplete}
      />,
    );
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onAutocomplete).toHaveBeenCalledWith(COMMANDS[0]);
  });

  it("Tab falls back to onPick when onAutocomplete is not provided", () => {
    const onPick = vi.fn();
    render(<CommandPicker input="/" commands={COMMANDS} onPick={onPick} />);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onPick).toHaveBeenCalledWith(COMMANDS[0]);
  });

  it("Escape calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} onDismiss={onDismiss} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("does not handle keyboard when not visible", () => {
    const onPick = vi.fn();
    render(<CommandPicker input="hello" commands={COMMANDS} onPick={onPick} />);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mouse click
// ---------------------------------------------------------------------------
describe("CommandPicker — mouse", () => {
  it("picks command on mouseDown", () => {
    const onPick = vi.fn();
    render(<CommandPicker input="/" commands={COMMANDS} onPick={onPick} />);
    const items = qAll("command-picker-item");
    fireEvent.mouseDown(items[2]);
    expect(onPick).toHaveBeenCalledWith(COMMANDS[2]);
  });
});

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
describe("CommandPicker — display", () => {
  it("shows slash prefix in command name", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    const slash = document.querySelector('[data-agent-ui="command-picker-slash"]');
    expect(slash?.textContent).toBe("/");
  });

  it("shows command description", () => {
    render(<CommandPicker input="/he" commands={COMMANDS} onPick={vi.fn()} />);
    const desc = q("command-picker-desc");
    expect(desc?.textContent).toBe("Show help");
  });

  it("has listbox role on panel", () => {
    render(<CommandPicker input="/" commands={COMMANDS} onPick={vi.fn()} />);
    const panel = q("command-picker-panel");
    expect(panel?.getAttribute("role")).toBe("listbox");
  });
});
