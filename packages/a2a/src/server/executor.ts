import type { AgentCard, Message, MessageSendParams, Task } from "../types.js";
import type { A2AEventBus } from "./event-bus.js";
import type { TaskStore } from "./task-store.js";

/**
 * Result of executing an A2A message.
 * Either a task (stateful, tracked work) or a direct message response.
 */
export interface ExecuteResult {
  task?: Task;
  message?: Message;
}

/**
 * The abstraction boundary between the A2A protocol layer and the
 * execution backend. Everything above (handler, transport) is protocol.
 * Everything below (ClawExecutor) is execution.
 *
 * Implementors MUST:
 * 1. Create or reuse a session for the contextId
 * 2. Emit events to the eventBus as execution progresses
 * 3. Update the taskStore with status transitions
 * 4. Resolve with the final task or message
 */
export interface AgentExecutor {
  /**
   * Execute a message and produce a result.
   *
   * The executor receives a pre-created taskId and must use the eventBus
   * to communicate progress. The handler decides whether to block on the
   * result or stream events.
   */
  execute(
    taskId: string,
    params: MessageSendParams,
    eventBus: A2AEventBus,
    taskStore: TaskStore,
  ): Promise<ExecuteResult>;

  /**
   * Cancel a running task.
   * Returns true if cancellation was initiated successfully.
   */
  cancel(taskId: string, taskStore: TaskStore): Promise<boolean>;

  /** Build the agent card for this agent. */
  getAgentCard(): AgentCard;
}
