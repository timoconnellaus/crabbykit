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
  it("shows input section with JSON-formatted args for generic tools", () => {
    render(
      <ToolCallEntry
        toolName="some_tool"
        toolCallId="tc1"
        args={{ cmd: "ls", flag: true }}
        result={{ status: "complete", toolName: "some_tool", content: "out", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    const input = q("tool-entry-input");
    expect(input).not.toBeNull();
    expect(input?.textContent).toContain('"cmd": "ls"');
  });

  it("shows string args as-is for generic tools", () => {
    render(
      <ToolCallEntry
        toolName="some_tool"
        toolCallId="tc1"
        args="raw string"
        result={{ status: "complete", toolName: "some_tool", content: "out", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-input")?.textContent).toBe("raw string");
  });

  it("hides input section when args is null for generic tools", () => {
    render(
      <ToolCallEntry
        toolName="some_tool"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "some_tool", content: "out", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-input")).toBeNull();
  });

  it("shows output section for generic complete result", () => {
    render(
      <ToolCallEntry
        toolName="some_tool"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "some_tool", content: "the output", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("tool-entry-output")?.textContent).toBe("the output");
    expect(q("tool-entry-section-label")?.textContent).toBe("output");
  });

  it("renders exec with $ prompt and output", () => {
    render(
      <ToolCallEntry
        toolName="exec"
        toolCallId="tc1"
        args={{ command: "bun install" }}
        result={{ status: "complete", toolName: "exec", content: "42 packages installed", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("exec-prompt")?.textContent).toBe("$");
    expect(q("exec-command")?.textContent).toBe("bun install");
    expect(q("exec-output")?.textContent).toContain("42 packages");
  });

  it("renders exec streaming content", () => {
    render(
      <ToolCallEntry
        toolName="exec"
        toolCallId="tc1"
        args={{ command: "bun test" }}
        result={{ status: "streaming", toolName: "exec", content: "partial..." }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("exec-output")?.textContent).toBe("partial...");
  });

  it("renders syntax-highlighted code for file_write from args.content", () => {
    const fileContent = "const x = 1;\nconsole.log(x);";
    render(
      <ToolCallEntry
        toolName="file_write"
        toolCallId="tc1"
        args={{ path: "src/app.ts", content: fileContent }}
        result={{ status: "complete", toolName: "file_write", content: "Successfully wrote 30 bytes to src/app.ts", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    // Should render highlighted code with line numbers from args.content
    expect(qAll("code-line").length).toBeGreaterThan(0);
    // Should show file write header with path
    expect(q("file-write-path")?.textContent).toBe("src/app.ts");
  });

  it("renders diff view for file_edit from args old/new strings", () => {
    render(
      <ToolCallEntry
        toolName="file_edit"
        toolCallId="tc1"
        args={{ path: "src/app.ts", old_string: "const x = 1;", new_string: "const x = 2;\nconst y = 3;" }}
        result={{ status: "complete", toolName: "file_edit", content: "Successfully replaced 1 occurrence in src/app.ts", isError: false }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    // Should render diff lines from old_string → new_string
    const diffLines = qAll("diff-line");
    expect(diffLines.length).toBeGreaterThan(0);
  });

  it("renders exec error with data-error attribute", () => {
    render(
      <ToolCallEntry
        toolName="exec"
        toolCallId="tc1"
        args={{ command: "false" }}
        result={{ status: "complete", toolName: "exec", content: "error details", isError: true }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
    expect(q("exec-output")?.getAttribute("data-error")).toBe("true");
  });

  it("shows error for generic tool in output section", () => {
    render(
      <ToolCallEntry
        toolName="some_tool"
        toolCallId="tc1"
        result={{ status: "complete", toolName: "some_tool", content: "error details", isError: true }}
      />,
    );
    fireEvent.click(q("tool-entry")!);
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
