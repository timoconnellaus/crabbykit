import { nanoid } from "nanoid";
import {
  internalError,
  invalidParamsError,
  methodNotFoundError,
  taskNotCancelableError,
  taskNotFoundError,
  unsupportedOperationError,
} from "../errors.js";
import type {
  CancelTaskParams,
  GetTaskParams,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  ListTasksParams,
  MessageSendParams,
  TaskStatus,
} from "../types.js";
import { isTerminalState } from "../types.js";
import { A2AEventBus, eventQueue } from "./event-bus.js";
import type { AgentExecutor } from "./executor.js";
import type { TaskStore } from "./task-store.js";

// ============================================================================
// A2AHandler — Protocol Orchestrator
// ============================================================================

export interface A2AHandlerOptions {
  executor: AgentExecutor;
  taskStore: TaskStore;
}

/**
 * Routes JSON-RPC method calls to the appropriate A2A operations.
 * Pure protocol logic — no HTTP types. Returns either a JsonRpcResponse
 * or a ReadableStream (for SSE streaming).
 */
export class A2AHandler {
  private executor: AgentExecutor;
  private taskStore: TaskStore;

  constructor(opts: A2AHandlerOptions) {
    this.executor = opts.executor;
    this.taskStore = opts.taskStore;
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | ReadableStream> {
    switch (request.method) {
      case "message/send":
        return this.handleSendMessage(request);
      case "message/stream":
        return this.handleStreamMessage(request);
      case "tasks/get":
        return this.handleGetTask(request);
      case "tasks/cancel":
        return this.handleCancelTask(request);
      case "tasks/list":
        return this.handleListTasks(request);
      default:
        return methodNotFoundError(request.id, request.method);
    }
  }

  // --- message/send ---

  private async handleSendMessage(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as MessageSendParams | undefined;
    const validationError = this.validateMessageParams(request.id, params);
    if (validationError) return validationError;

    const taskId = nanoid();
    const contextId = params!.message.contextId ?? taskId;

    // If the message references an existing task, validate it
    if (params!.message.taskId) {
      const existingTask = this.taskStore.get(params!.message.taskId);
      if (!existingTask) {
        return taskNotFoundError(request.id, params!.message.taskId);
      }
      if (isTerminalState(existingTask.status.state)) {
        return unsupportedOperationError(
          request.id,
          `Task ${params!.message.taskId} is in terminal state: ${existingTask.status.state}`,
        );
      }
    }

    // Resolve session for this context
    const sessionId = this.taskStore.getSessionIdForContext(contextId) ?? contextId;

    // Create task
    this.taskStore.create({
      id: taskId,
      contextId,
      sessionId,
      metadata: params!.message.metadata,
    });

    // Store push notification config if provided
    if (params!.configuration?.pushNotificationConfig) {
      this.taskStore.setPushConfig(taskId, params!.configuration.pushNotificationConfig);
    }

    const eventBus = new A2AEventBus();

    try {
      const result = await this.executor.execute(taskId, params!, eventBus, this.taskStore);

      if (result.message) {
        return this.success(request.id, result.message);
      }

      // Return the task with artifacts attached
      const task = result.task ?? this.taskStore.get(taskId);
      if (task) {
        task.artifacts = this.taskStore.getArtifacts(taskId);
      }
      return this.success(request.id, task);
    } catch (err) {
      return internalError(request.id, err instanceof Error ? err.message : "Execution failed");
    }
  }

  // --- message/stream ---

  private handleStreamMessage(request: JsonRpcRequest): JsonRpcResponse | ReadableStream {
    const params = request.params as MessageSendParams | undefined;
    const validationError = this.validateMessageParams(request.id, params);
    if (validationError) return validationError;

    const taskId = nanoid();
    const contextId = params!.message.contextId ?? taskId;
    const sessionId = this.taskStore.getSessionIdForContext(contextId) ?? contextId;

    this.taskStore.create({
      id: taskId,
      contextId,
      sessionId,
      metadata: params!.message.metadata,
    });

    if (params!.configuration?.pushNotificationConfig) {
      this.taskStore.setPushConfig(taskId, params!.configuration.pushNotificationConfig);
    }

    const eventBus = new A2AEventBus();
    const requestId = request.id;
    const encoder = new TextEncoder();

    return new ReadableStream({
      start: (controller) => {
        const queue = eventQueue(eventBus, taskId);

        // Start execution in the background
        this.executor.execute(taskId, params!, eventBus, this.taskStore).catch((err: unknown) => {
          eventBus.emitError(taskId, err instanceof Error ? err : new Error(String(err)));
        });

        // Pipe events to SSE
        const pipe = async () => {
          try {
            for await (const event of queue) {
              const rpcResponse: JsonRpcSuccessResponse = {
                jsonrpc: "2.0",
                id: requestId,
                result: event,
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(rpcResponse)}\n\n`));
            }
          } catch {
            // Stream consumer disconnected or error
          } finally {
            controller.close();
          }
        };

        pipe();
      },
    });
  }

  // --- tasks/get ---

  private async handleGetTask(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as GetTaskParams | undefined;
    if (!params?.id) {
      return invalidParamsError(request.id, "Missing required field: id");
    }

    const task = this.taskStore.get(params.id);
    if (!task) {
      return taskNotFoundError(request.id, params.id);
    }

    task.artifacts = this.taskStore.getArtifacts(params.id);
    return this.success(request.id, task);
  }

  // --- tasks/cancel ---

  private async handleCancelTask(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as CancelTaskParams | undefined;
    if (!params?.id) {
      return invalidParamsError(request.id, "Missing required field: id");
    }

    const task = this.taskStore.get(params.id);
    if (!task) {
      return taskNotFoundError(request.id, params.id);
    }

    if (isTerminalState(task.status.state)) {
      return taskNotCancelableError(request.id, params.id);
    }

    const cancelled = await this.executor.cancel(params.id, this.taskStore);
    if (!cancelled) {
      return taskNotCancelableError(request.id, params.id);
    }

    const cancelledStatus: TaskStatus = {
      state: "canceled",
      timestamp: new Date().toISOString(),
    };
    this.taskStore.updateStatus(params.id, cancelledStatus);

    const updated = this.taskStore.get(params.id)!;
    return this.success(request.id, updated);
  }

  // --- tasks/list ---

  private async handleListTasks(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as ListTasksParams | undefined;
    const tasks = this.taskStore.list({
      contextId: params?.contextId,
      limit: params?.limit,
      offset: params?.offset,
    });
    return this.success(request.id, tasks);
  }

  // --- Helpers ---

  private validateMessageParams(
    requestId: string | number,
    params: MessageSendParams | undefined,
  ): JsonRpcResponse | null {
    if (!params?.message) {
      return invalidParamsError(requestId, "Missing required field: message");
    }
    if (!params.message.parts || params.message.parts.length === 0) {
      return invalidParamsError(requestId, "Message must contain at least one part");
    }
    if (!params.message.role) {
      return invalidParamsError(requestId, "Message must have a role");
    }
    if (!params.message.messageId) {
      return invalidParamsError(requestId, "Message must have a messageId");
    }
    return null;
  }

  private success(requestId: string | number, result: unknown): JsonRpcSuccessResponse {
    return { jsonrpc: "2.0", id: requestId, result };
  }
}
