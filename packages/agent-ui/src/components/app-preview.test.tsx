import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleLogEntry } from "./app-preview";
import { AppPreview } from "./app-preview";

afterEach(() => {
  cleanup();
});

const sampleLogs: ConsoleLogEntry[] = [
  { level: "log", text: "App started", ts: 1000 },
  { level: "error", text: "Something broke", ts: 1001 },
  { level: "warn", text: "Deprecated API", ts: 1002 },
  { level: "info", text: "Connected", ts: 1003 },
];

describe("AppPreview", () => {
  it("renders iframe with correct src", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={[]} />);
    const iframe = document.querySelector(
      '[data-agent-ui="app-preview-iframe"]',
    ) as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.src).toBe("http://localhost:5173/");
  });

  it("shows loading overlay initially", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={[]} />);
    const loading = document.querySelector('[data-agent-ui="app-preview-loading"]');
    expect(loading).not.toBeNull();
    expect(loading?.textContent).toContain("Loading");
  });

  it("hides loading overlay after iframe loads", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={[]} />);
    const iframe = document.querySelector(
      '[data-agent-ui="app-preview-iframe"]',
    ) as HTMLIFrameElement;
    fireEvent.load(iframe);
    const loading = document.querySelector('[data-agent-ui="app-preview-loading"]');
    expect(loading).toBeNull();
  });

  it("renders log entries", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={sampleLogs} />);
    const entries = document.querySelectorAll('[data-agent-ui="app-preview-console-entry"]');
    expect(entries).toHaveLength(4);
  });

  it("shows error badge count", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={sampleLogs} />);
    const errorBadge = document.querySelector(
      '[data-agent-ui="app-preview-badge"][data-level="error"]',
    );
    expect(errorBadge).not.toBeNull();
    expect(errorBadge?.textContent).toBe("1");
  });

  it("filters logs by level", () => {
    render(
      <AppPreview
        previewUrl="http://localhost:5173"
        logs={sampleLogs}
        logFilter="error"
        onLogFilterChange={vi.fn()}
      />,
    );
    const entries = document.querySelectorAll('[data-agent-ui="app-preview-console-entry"]');
    expect(entries).toHaveLength(1);
    expect(entries[0].getAttribute("data-level")).toBe("error");
  });

  it("shows all logs when filter is 'all'", () => {
    render(
      <AppPreview
        previewUrl="http://localhost:5173"
        logs={sampleLogs}
        logFilter="all"
        onLogFilterChange={vi.fn()}
      />,
    );
    const entries = document.querySelectorAll('[data-agent-ui="app-preview-console-entry"]');
    expect(entries).toHaveLength(4);
  });

  it("calls onClearLogs when clear button clicked", () => {
    const onClear = vi.fn();
    render(
      <AppPreview previewUrl="http://localhost:5173" logs={sampleLogs} onClearLogs={onClear} />,
    );
    const clearBtn = document.querySelector('[data-agent-ui="app-preview-clear"]');
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn!);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("calls onLogFilterChange when filter clicked", () => {
    const onChange = vi.fn();
    render(
      <AppPreview
        previewUrl="http://localhost:5173"
        logs={sampleLogs}
        onLogFilterChange={onChange}
      />,
    );
    const filters = document.querySelectorAll('[data-agent-ui="app-preview-filter"]');
    fireEvent.click(filters[1]);
    expect(onChange).toHaveBeenCalledWith("error");
  });

  it("toggles console panel visibility", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={sampleLogs} />);
    let console = document.querySelector('[data-agent-ui="app-preview-console"]');
    expect(console).not.toBeNull();
    const toggle = document.querySelector('[data-agent-ui="app-preview-console-toggle"]')!;
    fireEvent.click(toggle);
    console = document.querySelector('[data-agent-ui="app-preview-console"]');
    expect(console).toBeNull();
    fireEvent.click(toggle);
    console = document.querySelector('[data-agent-ui="app-preview-console"]');
    expect(console).not.toBeNull();
  });

  it("shows empty state when no logs", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={[]} />);
    const empty = document.querySelector('[data-agent-ui="app-preview-console-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No logs");
  });

  it("sets data-level attribute on log entries", () => {
    render(<AppPreview previewUrl="http://localhost:5173" logs={sampleLogs} />);
    const entries = document.querySelectorAll('[data-agent-ui="app-preview-console-entry"]');
    expect(entries[0].getAttribute("data-level")).toBe("log");
    expect(entries[1].getAttribute("data-level")).toBe("error");
    expect(entries[2].getAttribute("data-level")).toBe("warn");
    expect(entries[3].getAttribute("data-level")).toBe("info");
  });

  it("marks active filter with data-active", () => {
    render(
      <AppPreview
        previewUrl="http://localhost:5173"
        logs={sampleLogs}
        logFilter="error"
        onLogFilterChange={vi.fn()}
      />,
    );
    const filters = document.querySelectorAll('[data-agent-ui="app-preview-filter"]');
    expect(filters[0].getAttribute("data-active")).toBeNull();
    expect(filters[1].getAttribute("data-active")).not.toBeNull();
  });
});
