import { describe, expect, it, vi } from "vitest";
import type { SubagentEventMeta } from "../event-forwarder.js";
import { createEventForwarder } from "../event-forwarder.js";

const META: SubagentEventMeta = {
  subagentId: "sub-1",
  profileId: "explorer",
  childSessionId: "child-session-1",
  taskId: "task-42",
};

describe("createEventForwarder", () => {
  it("broadcasts via broadcastState with event data", () => {
    const broadcastState = vi.fn();
    const handler = createEventForwarder(META, broadcastState);

    handler({ type: "agent_start" });

    expect(broadcastState).toHaveBeenCalledTimes(1);
    expect(broadcastState).toHaveBeenCalledWith("event", {
      subagentId: "sub-1",
      profileId: "explorer",
      childSessionId: "child-session-1",
      taskId: "task-42",
      event: { type: "agent_start" },
    });
  });

  it("forwards multiple events in order", () => {
    const broadcastState = vi.fn();
    const handler = createEventForwarder(META, broadcastState);

    handler({ type: "agent_start" });
    handler({ type: "turn_start" });
    handler({ type: "agent_end", messages: [] });

    expect(broadcastState).toHaveBeenCalledTimes(3);
    expect(broadcastState.mock.calls[0][1].event.type).toBe("agent_start");
    expect(broadcastState.mock.calls[1][1].event.type).toBe("turn_start");
    expect(broadcastState.mock.calls[2][1].event.type).toBe("agent_end");
  });

  it("includes all metadata in each forwarded event", () => {
    const broadcastState = vi.fn();
    const handler = createEventForwarder(META, broadcastState);

    handler({ type: "agent_start" });

    const data = broadcastState.mock.calls[0][1];
    expect(data.subagentId).toBe("sub-1");
    expect(data.profileId).toBe("explorer");
    expect(data.childSessionId).toBe("child-session-1");
    expect(data.taskId).toBe("task-42");
  });

  it("includes taskId as undefined when not provided", () => {
    const metaNoTask = { ...META, taskId: undefined };
    const broadcastState = vi.fn();
    const handler = createEventForwarder(metaNoTask, broadcastState);

    handler({ type: "agent_start" });

    expect(broadcastState.mock.calls[0][1].taskId).toBeUndefined();
  });
});
