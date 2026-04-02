import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskBreadcrumb } from "./task-breadcrumb";
import type { TaskNode } from "./task-tree-panel";

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
        status: "in_progress",
        type: "task",
        priority: 2,
        depth: 1,
        children: [
          {
            id: "sub-1",
            title: "OAuth Flow",
            status: "in_progress",
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

describe("TaskBreadcrumb", () => {
  it("renders nothing when tree is null", () => {
    render(<TaskBreadcrumb tree={null} activeTaskId="task-1" />);
    expect(q("task-breadcrumb")).toBeNull();
  });

  it("renders nothing when no active task", () => {
    render(<TaskBreadcrumb tree={makeTree()} />);
    expect(q("task-breadcrumb")).toBeNull();
  });

  it("renders nothing when active task not found", () => {
    render(<TaskBreadcrumb tree={makeTree()} activeTaskId="nonexistent" />);
    expect(q("task-breadcrumb")).toBeNull();
  });

  it("shows path for root task", () => {
    render(<TaskBreadcrumb tree={makeTree()} activeTaskId="epic-1" />);

    const labels = qAll("task-breadcrumb-label");
    expect(labels.length).toBe(1);
    expect(labels[0].textContent).toBe("Build Auth");
  });

  it("shows path for leaf task", () => {
    render(<TaskBreadcrumb tree={makeTree()} activeTaskId="sub-1" />);

    const labels = qAll("task-breadcrumb-label");
    expect(labels.length).toBe(3);
    expect(labels[0].textContent).toBe("Build Auth");
    expect(labels[1].textContent).toBe("Design Schema");
    expect(labels[2].textContent).toBe("OAuth Flow");
  });

  it("shows separators between segments", () => {
    render(<TaskBreadcrumb tree={makeTree()} activeTaskId="sub-1" />);

    const separators = qAll("task-breadcrumb-separator");
    expect(separators.length).toBe(2); // 3 segments, 2 separators
  });

  it("marks the active task label", () => {
    render(<TaskBreadcrumb tree={makeTree()} activeTaskId="sub-1" />);

    const labels = qAll("task-breadcrumb-label");
    const activeLabel = Array.from(labels).find((l) => l.getAttribute("data-active") !== null);
    expect(activeLabel).toBeDefined();
    expect(activeLabel!.textContent).toBe("OAuth Flow");
  });

  it("shows path for middle task", () => {
    render(<TaskBreadcrumb tree={makeTree()} activeTaskId="task-1" />);

    const labels = qAll("task-breadcrumb-label");
    expect(labels.length).toBe(2);
    expect(labels[0].textContent).toBe("Build Auth");
    expect(labels[1].textContent).toBe("Design Schema");
  });
});
