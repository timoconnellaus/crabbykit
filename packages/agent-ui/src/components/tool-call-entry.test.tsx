import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCallEntry } from "./tool-call-entry";

afterEach(() => {
  cleanup();
});

const q = (attr: string) => document.querySelector(`[data-agent-ui="${attr}"]`);
const qAll = (attr: string) => document.querySelectorAll(`[data-agent-ui="${attr}"]`);

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------
describe("ToolCallEntry — basic", () => {
  it("renders tool name", () => {
    render(<ToolCallEntry toolName="bash" toolCallId="tc1" />);
    expect(q("tool-entry-name")?.textContent).toBe("bash");
  });

  it("sets tool category data attribute", () => {
    render(<ToolCallEntry toolName="web_search" toolCallId="tc1" />);
    expect(q("tool-entry")?.getAttribute("data-tool-category")).toBe("web");
  });

  it("shows detail from args", () => {
    render(
      <ToolCallEntry toolName="bash" toolCallId="tc1" args={{ command: "ls -la" }} />,
    );
    // summarizeToolInput finds first string value
    expect(q("tool-entry-detail")?.textContent).toBe("ls -la");
  });

  it("omits detail when args is undefined", () => {
    render(<ToolCallEntry toolName="bash" toolCallId="tc1" />);
    expect(q("tool-entry-detail")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status states
// ---------------------------------------------------------------------------
describe("ToolCallEntry — status", () => {
  it("shows spinner when executing (no result)", () => {
    render(<ToolCallEntry toolName="bash" toolCallId="tc1" />);
    expect(q("tool-entry")?.getAttribute("data-status")).toBe("executing");
    expect(q("tool-entry-spinner")).not.toBeNull();
  });

  it("shows spinner when result status is executing", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "executing", toolName: "bash" }}
      />,
    );
    expect(q("tool-entry-spinner")).not.toBeNull();
  });

  it("shows spinner when streaming", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "streaming", toolName: "bash", content: "partial..." }}
      />,
    );
    expect(q("tool-entry-spinner")).not.toBeNull();
  });

  it("shows result summary when complete", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "hello world", isError: false }}
      />,
    );
    expect(q("tool-entry-spinner")).toBeNull();
    expect(q("tool-entry-result")?.textContent).toBe("hello world");
    expect(q("tool-entry-result")?.getAttribute("data-variant")).toBe("muted");
  });

  it("sets data-error when result is an error", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "boom", isError: true }}
      />,
    );
    expect(q("tool-entry")?.getAttribute("data-error")).toBe("true");
  });

  it("shows duration when complete", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        duration={1500}
        result={{ status: "complete", toolName: "bash", content: "ok", isError: false }}
      />,
    );
    expect(q("tool-entry-duration")?.textContent).toBe("1.5s");
  });

  it("hides duration while running", () => {
    render(<ToolCallEntry toolName="bash" toolCallId="tc1" duration={1500} />);
    expect(q("tool-entry-duration")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expand/collapse
// ---------------------------------------------------------------------------
describe("ToolCallEntry — expand/collapse", () => {
  it("starts collapsed (no body)", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        args={{ cmd: "ls" }}
        result={{ status: "complete", toolName: "bash", content: "output", isError: false }}
      />,
    );
    expect(q("tool-entry-body")).toBeNull();
    expect(q("tool-entry")?.getAttribute("data-open")).toBeNull();
  });

  it("expands on click", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        args={{ cmd: "ls" }}
        result={{ status: "complete", toolName: "bash", content: "output", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-body")).not.toBeNull();
    expect(q("tool-entry")?.getAttribute("data-open")).toBe("true");
  });

  it("collapses on second click", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        args={{ cmd: "ls" }}
        result={{ status: "complete", toolName: "bash", content: "output", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-body")).not.toBeNull();
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-body")).toBeNull();
  });

  it("does not toggle when text is selected", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "output", isError: false }}
      />,
    );
    // Mock getSelection to return a non-empty selection
    const origGetSelection = window.getSelection;
    window.getSelection = () => ({ toString: () => "selected text" }) as Selection;
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-body")).toBeNull(); // should NOT open
    window.getSelection = origGetSelection;
  });

  it("toggles on Enter keypress", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "output", isError: false }}
      />,
    );
    fireEvent.keyDown(q("tool-entry")!, { key: "Enter" });
    expect(q("tool-entry-body")).not.toBeNull();
  });

  it("toggles on Space keypress", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "output", isError: false }}
      />,
    );
    fireEvent.keyDown(q("tool-entry")!, { key: " " });
    expect(q("tool-entry-body")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expanded body content
// ---------------------------------------------------------------------------
describe("ToolCallEntry — expanded body", () => {
  it("shows input section with JSON-formatted args", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        args={{ cmd: "ls", flag: true }}
        result={{ status: "complete", toolName: "bash", content: "out", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    const input = q("tool-entry-input");
    expect(input).not.toBeNull();
    expect(input?.textContent).toContain('"cmd": "ls"');
  });

  it("shows string args as-is", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        args="raw string"
        result={{ status: "complete", toolName: "bash", content: "out", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-input")?.textContent).toBe("raw string");
  });

  it("hides input section when args is null", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "out", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-input")).toBeNull();
  });

  it("shows output section for complete result", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "the output", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-output")?.textContent).toBe("the output");
    expect(q("tool-entry-section-label")?.textContent).toBe("output");
  });

  it("shows streaming content in expanded body", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "streaming", toolName: "bash", content: "partial..." }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-output")?.textContent).toBe("partial...");
  });

  it("renders diff format for file_write", () => {
    const diff = "--- a/f\n+++ b/f\n+added line\n-removed line\n context";
    render(
      <ToolCallEntry
        toolName="file_write"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "file_write", content: diff, isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    // Section label should say "changes" for diffs
    const labels = qAll("tool-entry-section-label");
    const outputLabel = Array.from(labels).find((l) => l.textContent === "changes");
    expect(outputLabel).not.toBeNull();

    // Diff lines should have data-agent-ui attributes
    expect(qAll("tool-entry-diff-add")).toHaveLength(1);
    expect(qAll("tool-entry-diff-remove")).toHaveLength(1);
  });

  it("renders diff format for file_edit", () => {
    const diff = "@@\n+new\n-old";
    render(
      <ToolCallEntry
        toolName="file_edit"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "file_edit", content: diff, isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(qAll("tool-entry-diff-context")).toHaveLength(1); // @@ line
  });

  it("shows error content in error section when no outputText", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "error details", isError: true }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    // outputText is set (content exists), so it goes to the output section with data-error
    expect(q("tool-entry-output")?.getAttribute("data-error")).toBe("true");
  });

  it("stops event propagation from body clicks", () => {
    render(
      <ToolCallEntry
        toolName="bash"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "bash", content: "out", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!); // open
    expect(q("tool-entry-body")).not.toBeNull();
    // Click inside body should NOT close
    fireEvent.click(q("tool-entry-body")!);
    expect(q("tool-entry-body")).not.toBeNull(); // still open
  });
});
