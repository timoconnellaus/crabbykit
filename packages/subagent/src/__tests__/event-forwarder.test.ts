import { describe, expect, it, vi } from "vitest";
import type { SubagentEventMeta } from "../event-forwarder.js";
import { createEventForwarder, wrapSubagentEvent } from "../event-forwarder.js";

const META: SubagentEventMeta = {
  subagentId: "sub-1",
  profileId: "explorer",
  childSessionId: "child-session-1",
  taskId: "task-42",
};

const PARENT_SESSION = "parent-session";

describe("wrapSubagentEvent", () => {
  it("wraps an agent_start event", () => {
    const wrapped = wrapSubagentEvent(PARENT_SESSION, META, { type: "agent_start" });

    expect(wrapped.type).toBe("subagent_event");
    expect(wrapped.sessionId).toBe(PARENT_SESSION);
    expect(wrapped.subagentId).toBe("sub-1");
    expect(wrapped.profileId).toBe("explorer");
    expect(wrapped.childSessionId).toBe("child-session-1");
    expect(wrapped.taskId).toBe("task-42");
    expect(wrapped.event).toEqual({ type: "agent_start" });
  });

  it("wraps a message_update event", () => {
    const event = {
      type: "message_update" as const,
      message: { role: "assistant" as const, content: "Found stuff" },
      assistantMessageEvent: { type: "text-delta" as const, textDelta: "Found" },
    };
    const wrapped = wrapSubagentEvent(PARENT_SESSION, META, event);

    expect(wrapped.event.type).toBe("message_update");
  });

  it("wraps agent_end event", () => {
    const event = {
      type: "agent_end" as const,
      messages: [{ role: "assistant" as const, content: "Done" }],
    };
    const wrapped = wrapSubagentEvent(PARENT_SESSION, META, event);

    expect(wrapped.event.type).toBe("agent_end");
  });

  it("omits taskId when not provided", () => {
    const metaNoTask = { ...META, taskId: undefined };
    const wrapped = wrapSubagentEvent(PARENT_SESSION, metaNoTask, { type: "agent_start" });

    expect(wrapped.taskId).toBeUndefined();
  });
});

describe("createEventForwarder", () => {
  it("broadcasts wrapped events", () => {
    const broadcast = vi.fn();
    const handler = createEventForwarder(META, PARENT_SESSION, broadcast);

    handler({ type: "agent_start" });

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "subagent_event",
        sessionId: PARENT_SESSION,
        subagentId: "sub-1",
        event: { type: "agent_start" },
      }),
    );
  });

  it("forwards multiple events in order", () => {
    const broadcast = vi.fn();
    const handler = createEventForwarder(META, PARENT_SESSION, broadcast);

    handler({ type: "agent_start" });
    handler({
      type: "turn_start",
    });
    handler({
      type: "agent_end",
      messages: [],
    });

    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast.mock.calls[0][0].event.type).toBe("agent_start");
    expect(broadcast.mock.calls[1][0].event.type).toBe("turn_start");
    expect(broadcast.mock.calls[2][0].event.type).toBe("agent_end");
  });

  it("includes all metadata in each forwarded event", () => {
    const broadcast = vi.fn();
    const handler = createEventForwarder(META, PARENT_SESSION, broadcast);

    handler({ type: "agent_start" });

    const msg = broadcast.mock.calls[0][0];
    expect(msg.profileId).toBe("explorer");
    expect(msg.childSessionId).toBe("child-session-1");
    expect(msg.taskId).toBe("task-42");
  });
});
