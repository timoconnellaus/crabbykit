import { describe, expect, it, vi } from "vitest";
import {
  A2AEventBus,
  eventQueue,
  StatusUpdateEvent,
  TaskCompleteEvent,
} from "../server/event-bus.js";

describe("A2AEventBus", () => {
  it("emits and receives status updates", () => {
    const bus = new A2AEventBus();
    const callback = vi.fn();
    bus.subscribe("task-1", callback);

    bus.emitStatusUpdate(
      "task-1",
      "ctx-1",
      { state: "working", timestamp: "2025-01-01T00:00:00Z" },
      false,
    );

    expect(callback).toHaveBeenCalledOnce();
    const event = callback.mock.calls[0][0];
    expect(event).toBeInstanceOf(StatusUpdateEvent);
    expect(event.taskId).toBe("task-1");
    expect(event.status.state).toBe("working");
  });

  it("filters events by taskId", () => {
    const bus = new A2AEventBus();
    const callback = vi.fn();
    bus.subscribe("task-1", callback);

    bus.emitStatusUpdate(
      "task-2",
      "ctx-2",
      { state: "working", timestamp: "2025-01-01T00:00:00Z" },
      false,
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it("unsubscribe stops events", () => {
    const bus = new A2AEventBus();
    const callback = vi.fn();
    const unsub = bus.subscribe("task-1", callback);

    bus.emitStatusUpdate(
      "task-1",
      "ctx-1",
      { state: "working", timestamp: "2025-01-01T00:00:00Z" },
      false,
    );
    expect(callback).toHaveBeenCalledOnce();

    unsub();
    bus.emitStatusUpdate(
      "task-1",
      "ctx-1",
      { state: "completed", timestamp: "2025-01-01T00:00:01Z" },
      true,
    );
    expect(callback).toHaveBeenCalledOnce(); // Still just once
  });

  it("emits complete events", () => {
    const bus = new A2AEventBus();
    const callback = vi.fn();
    bus.subscribe("task-1", callback);

    const task = {
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "completed" as const, timestamp: "now" },
    };
    bus.emitComplete("task-1", task);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toBeInstanceOf(TaskCompleteEvent);
  });
});

describe("eventQueue", () => {
  it("yields events and stops on terminal state", async () => {
    const bus = new A2AEventBus();
    const events: unknown[] = [];

    const gen = eventQueue(bus, "task-1");

    // Emit events after a microtask delay
    queueMicrotask(() => {
      bus.emitStatusUpdate("task-1", "ctx-1", { state: "submitted", timestamp: "t1" }, false);
      bus.emitStatusUpdate("task-1", "ctx-1", { state: "working", timestamp: "t2" }, false);
      bus.emitStatusUpdate("task-1", "ctx-1", { state: "completed", timestamp: "t3" }, true);
    });

    for await (const event of gen) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect((events[0] as any).statusUpdate.status.state).toBe("submitted");
    expect((events[1] as any).statusUpdate.status.state).toBe("working");
    expect((events[2] as any).statusUpdate.status.state).toBe("completed");
  });
});
