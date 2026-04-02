import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentInfo } from "./subagent-card";
import { SubagentCard, SubagentList } from "./subagent-card";

afterEach(() => {
  cleanup();
});

const q = (attr: string) => document.querySelector(`[data-agent-ui="${attr}"]`);
const qAll = (attr: string) => document.querySelectorAll(`[data-agent-ui="${attr}"]`);

function makeSub(overrides?: Partial<SubagentInfo>): SubagentInfo {
  return {
    subagentId: "sub-1",
    profileId: "explorer",
    childSessionId: "child-1",
    state: "running",
    prompt: "Find auth modules",
    ...overrides,
  };
}

describe("SubagentCard", () => {
  it("renders profile and state", () => {
    render(<SubagentCard subagent={makeSub()} />);

    expect(q("subagent-card-profile")?.textContent).toBe("explorer");
    expect(q("subagent-card-state")?.textContent).toBe("Running");
  });

  it("shows running indicator", () => {
    render(<SubagentCard subagent={makeSub({ state: "running" })} />);
    expect(q("subagent-card-indicator")?.textContent).toBe("⟳");
  });

  it("shows completed indicator", () => {
    render(<SubagentCard subagent={makeSub({ state: "completed" })} />);
    expect(q("subagent-card-indicator")?.textContent).toBe("✓");
  });

  it("shows failed indicator", () => {
    render(<SubagentCard subagent={makeSub({ state: "failed" })} />);
    expect(q("subagent-card-indicator")?.textContent).toBe("✗");
  });

  it("shows breadcrumb when provided", () => {
    render(<SubagentCard subagent={makeSub({ breadcrumb: ["Epic", "Task", "Subtask"] })} />);

    expect(q("subagent-card-breadcrumb")?.textContent).toBe("Epic › Task › Subtask");
  });

  it("hides breadcrumb when not provided", () => {
    render(<SubagentCard subagent={makeSub()} />);
    expect(q("subagent-card-breadcrumb")).toBeNull();
  });

  it("shows streaming text when running", () => {
    render(<SubagentCard subagent={makeSub({ state: "running", latestText: "Searching..." })} />);

    expect(q("subagent-card-stream")?.textContent).toBe("Searching...");
  });

  it("shows result text when completed", () => {
    render(
      <SubagentCard
        subagent={makeSub({
          state: "completed",
          latestText: "Found 5 auth modules",
        })}
      />,
    );

    expect(q("subagent-card-result")?.textContent).toBe("Found 5 auth modules");
  });

  it("truncates long result text", () => {
    const longText = "x".repeat(300);
    render(<SubagentCard subagent={makeSub({ state: "completed", latestText: longText })} />);

    const result = q("subagent-card-result")?.textContent ?? "";
    expect(result.length).toBeLessThan(210); // 200 + "…"
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<SubagentCard subagent={makeSub()} onClick={onClick} />);

    fireEvent.click(q("subagent-card")!);
    expect(onClick).toHaveBeenCalledWith("sub-1");
  });

  it("sets data-state attribute", () => {
    render(<SubagentCard subagent={makeSub({ state: "failed" })} />);
    expect(q("subagent-card")?.getAttribute("data-state")).toBe("failed");
  });
});

describe("SubagentList", () => {
  it("renders nothing when empty", () => {
    render(<SubagentList subagents={[]} />);
    expect(q("subagent-list")).toBeNull();
  });

  it("renders multiple cards", () => {
    render(
      <SubagentList
        subagents={[
          makeSub({ subagentId: "sub-1" }),
          makeSub({ subagentId: "sub-2", profileId: "planner" }),
        ]}
      />,
    );

    const cards = qAll("subagent-card");
    expect(cards.length).toBe(2);
  });

  it("passes onClick to cards", () => {
    const onClick = vi.fn();
    render(<SubagentList subagents={[makeSub({ subagentId: "sub-1" })]} onClick={onClick} />);

    fireEvent.click(q("subagent-card")!);
    expect(onClick).toHaveBeenCalledWith("sub-1");
  });
});
