import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskNode } from "./task-tree-panel";
import { TaskTreePanel } from "./task-tree-panel";

afterEach(() => {
  cleanup();
});

const q = (attr: string) => document.querySelector(`[data-agent-ui="${attr}"]`);
const qAll = (attr: string) => document.querySelectorAll(`[data-agent-ui="${attr}"]`);

function makeTree(): TaskNode {
  return {
    id: "epic-1",
    title: "Build Auth",
    status: "in_progress",
    type: "epic",
    priority: 1,
    depth: 0,
    children: [
      {
        id: "task-1",
        title: "Design Schema",
        status: "closed",
        type: "task",
        priority: 2,
        depth: 1,
        children: [],
      },
      {
        id: "task-2",
        title: "Implement Login",
        status: "open",
        type: "task",
        priority: 2,
        depth: 1,
        children: [
          {
            id: "sub-1",
            title: "OAuth Flow",
            status: "open",
            type: "task",
            priority: 3,
            depth: 2,
            children: [],
          },
        ],
      },
    ],
  };
}

describe("TaskTreePanel", () => {
  it("renders nothing when tree is null", () => {
    render(<TaskTreePanel tree={null} />);
    expect(q("task-tree-panel")).toBeNull();
  });

  it("renders tree hierarchy", () => {
    render(<TaskTreePanel tree={makeTree()} />);

    expect(q("task-tree-panel")).not.toBeNull();
    const rows = qAll("task-tree-row");
    expect(rows.length).toBe(4); // epic + 2 tasks + 1 subtask
  });

  it("shows task titles", () => {
    render(<TaskTreePanel tree={makeTree()} />);

    const titles = qAll("task-tree-title");
    const texts = Array.from(titles).map((t) => t.textContent);
    expect(texts).toContain("Build Auth");
    expect(texts).toContain("Design Schema");
    expect(texts).toContain("Implement Login");
    expect(texts).toContain("OAuth Flow");
  });

  it("shows status indicators", () => {
    render(<TaskTreePanel tree={makeTree()} />);

    const statuses = qAll("task-tree-status");
    const icons = Array.from(statuses).map((s) => s.textContent);
    expect(icons).toContain("✓"); // closed
    expect(icons).toContain("○"); // open
    expect(icons).toContain("▶"); // in_progress
  });

  it("highlights active task", () => {
    render(<TaskTreePanel tree={makeTree()} activeTaskId="task-2" />);

    const rows = qAll("task-tree-row");
    const activeRow = Array.from(rows).find((r) => r.getAttribute("data-active") !== null);
    expect(activeRow).toBeDefined();
  });

  it("calls onTaskClick when task is clicked", () => {
    const onClick = vi.fn();
    render(<TaskTreePanel tree={makeTree()} onTaskClick={onClick} />);

    const rows = qAll("task-tree-row");
    fireEvent.click(rows[1]); // Click "Design Schema"

    expect(onClick).toHaveBeenCalledWith("task-1");
  });

  it("collapses and expands children", () => {
    render(<TaskTreePanel tree={makeTree()} />);

    // Initially 4 rows visible
    expect(qAll("task-tree-row").length).toBe(4);

    // Click toggle on root (first toggle button)
    const toggles = qAll("task-tree-toggle");
    fireEvent.click(toggles[0]);

    // After collapsing root, only root row should be visible
    expect(qAll("task-tree-row").length).toBe(1);

    // Expand again
    fireEvent.click(qAll("task-tree-toggle")[0]);
    expect(qAll("task-tree-row").length).toBe(4);
  });

  it("shows task type", () => {
    render(<TaskTreePanel tree={makeTree()} />);

    const types = qAll("task-tree-type");
    const texts = Array.from(types).map((t) => t.textContent);
    expect(texts).toContain("epic");
    expect(texts).toContain("task");
  });
});
