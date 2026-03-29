import type { Artifact, StreamEvent, Task, TaskStatus } from "../types.js";
import { isInterruptedState, isTerminalState } from "../types.js";

// ============================================================================
// Event Types
// ============================================================================

export type A2AEventType =
  | "a2a:status-update"
  | "a2a:artifact-update"
  | "a2a:complete"
  | "a2a:error";

export class StatusUpdateEvent extends Event {
  constructor(
    public readonly taskId: string,
    public readonly contextId: string,
    public readonly status: TaskStatus,
    public readonly final: boolean,
  ) {
    super("a2a:status-update");
  }
}

export class ArtifactUpdateEvent extends Event {
  constructor(
    public readonly taskId: string,
    public readonly contextId: string,
    public readonly artifact: Artifact,
    public readonly append: boolean = false,
    public readonly lastChunk: boolean = false,
  ) {
    super("a2a:artifact-update");
  }
}

export class TaskCompleteEvent extends Event {
  constructor(
    public readonly taskId: string,
    public readonly task: Task,
  ) {
    super("a2a:complete");
  }
}

export class TaskErrorEvent extends Event {
  constructor(
    public readonly taskId: string,
    public readonly error: Error,
  ) {
    super("a2a:error");
  }
}

// ============================================================================
// Event Bus
// ============================================================================

/**
 * EventTarget-based bus connecting the executor (producing events)
 * to the handler (consuming them for SSE streams or blocking responses).
 *
 * Uses the standard EventTarget API available in Workers runtime.
 */
export class A2AEventBus extends EventTarget {
  emitStatusUpdate(taskId: string, contextId: string, status: TaskStatus, final: boolean): void {
    this.dispatchEvent(new StatusUpdateEvent(taskId, contextId, status, final));
  }

  emitArtifactUpdate(
    taskId: string,
    contextId: string,
    artifact: Artifact,
    opts?: { append?: boolean; lastChunk?: boolean },
  ): void {
    this.dispatchEvent(
      new ArtifactUpdateEvent(
        taskId,
        contextId,
        artifact,
        opts?.append ?? false,
        opts?.lastChunk ?? false,
      ),
    );
  }

  emitComplete(taskId: string, task: Task): void {
    this.dispatchEvent(new TaskCompleteEvent(taskId, task));
  }

  emitError(taskId: string, error: Error): void {
    this.dispatchEvent(new TaskErrorEvent(taskId, error));
  }

  /**
   * Subscribe to all events for a specific task.
   * Returns a cleanup function that removes all listeners.
   */
  subscribe(
    taskId: string,
    callback: (
      event: StatusUpdateEvent | ArtifactUpdateEvent | TaskCompleteEvent | TaskErrorEvent,
    ) => void,
  ): () => void {
    const filter =
      (
        handler: (
          event: StatusUpdateEvent | ArtifactUpdateEvent | TaskCompleteEvent | TaskErrorEvent,
        ) => void,
      ) =>
      (event: Event) => {
        const typed = event as
          | StatusUpdateEvent
          | ArtifactUpdateEvent
          | TaskCompleteEvent
          | TaskErrorEvent;
        if (typed.taskId === taskId) {
          handler(typed);
        }
      };

    const filteredCallback = filter(callback);

    const types: A2AEventType[] = [
      "a2a:status-update",
      "a2a:artifact-update",
      "a2a:complete",
      "a2a:error",
    ];

    for (const type of types) {
      this.addEventListener(type, filteredCallback);
    }

    return () => {
      for (const type of types) {
        this.removeEventListener(type, filteredCallback);
      }
    };
  }
}

// ============================================================================
// Event Queue (async generator over event bus)
// ============================================================================

/**
 * Wraps an A2AEventBus subscription as an async generator.
 * Yields StreamEvent objects until a terminal or interrupted state is reached.
 */
export async function* eventQueue(bus: A2AEventBus, taskId: string): AsyncGenerator<StreamEvent> {
  const buffer: StreamEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const unsubscribe = bus.subscribe(taskId, (event) => {
    if (event instanceof StatusUpdateEvent) {
      const streamEvent: StreamEvent = {
        statusUpdate: {
          taskId: event.taskId,
          contextId: event.contextId,
          status: event.status,
          final: event.final,
        },
      };
      buffer.push(streamEvent);
      if (
        event.final ||
        isTerminalState(event.status.state) ||
        isInterruptedState(event.status.state)
      ) {
        done = true;
      }
    } else if (event instanceof ArtifactUpdateEvent) {
      buffer.push({
        artifactUpdate: {
          taskId: event.taskId,
          contextId: event.contextId,
          artifact: event.artifact,
          append: event.append,
          lastChunk: event.lastChunk,
        },
      });
    } else if (event instanceof TaskCompleteEvent) {
      buffer.push({ task: event.task });
      done = true;
    } else if (event instanceof TaskErrorEvent) {
      done = true;
    }

    // Wake the generator if it's waiting
    if (resolve) {
      resolve();
      resolve = null;
    }
  });

  try {
    while (true) {
      // Yield all buffered events
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }

      if (done) break;

      // Wait for next event
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
  } finally {
    unsubscribe();
  }
}
