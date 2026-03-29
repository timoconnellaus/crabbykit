import type { AgentTool, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { PushNotificationConfig } from "../types.js";
import { isTextPart } from "../types.js";
import { getAgentCard } from "./discovery.js";
import { A2AClientError, A2AHttpClient } from "./http-client.js";
import { PendingTaskStore } from "./pending-tasks.js";

// ============================================================================
// Options (passed from capability)
// ============================================================================

export interface A2AToolOptions {
  agentId: string;
  agentName?: string;
  getAgentStub: (id: string) => {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
  callbackBaseUrl: string;
  maxDepth: number;
  authHeaders?: (targetAgent: string) => Record<string, string> | Promise<Record<string, string>>;
}

// ============================================================================
// Depth Tracking
// ============================================================================

const DEPTH_KEY = "a2a:depth";

async function checkDepth(storage: CapabilityStorage, maxDepth: number): Promise<number> {
  const depth = (await storage.get<number>(DEPTH_KEY)) ?? 0;
  if (depth >= maxDepth) {
    throw new Error(
      `Agent chain depth limit reached (${depth}/${maxDepth}). Cannot delegate further.`,
    );
  }
  return depth;
}

// ============================================================================
// Resolve Client
// ============================================================================

function resolveClient(targetAgent: string, options: A2AToolOptions): A2AHttpClient {
  // If it looks like a URL, use global fetch
  if (targetAgent.startsWith("http://") || targetAgent.startsWith("https://")) {
    return new A2AHttpClient(
      targetAgent,
      fetch,
      options.authHeaders ? () => options.authHeaders!(targetAgent) : undefined,
    );
  }

  // Same-platform agent — use DO stub
  const stub = options.getAgentStub(targetAgent);
  return new A2AHttpClient(
    "https://agent",
    stub.fetch.bind(stub) as typeof fetch,
    options.authHeaders ? () => options.authHeaders!(targetAgent) : undefined,
  );
}

// ============================================================================
// Tools
// ============================================================================

/**
 * Blocking delegation tool — calls another A2A agent and waits for the result.
 * Used for quick sub-tasks within an inference turn.
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createCallAgentTool(
  options: A2AToolOptions,
  getStorage: () => CapabilityStorage,
  getSessionId: () => string,
): AgentTool<any> {
  return defineTool({
    name: "call_agent",
    description:
      "Call another agent via the A2A protocol and wait for its response. " +
      "Use this for quick tasks that need an immediate answer.",
    parameters: Type.Object({
      targetAgent: Type.String({
        description: "Agent URL (https://...) or same-platform agent ID to call.",
      }),
      message: Type.String({
        description: "The task or question to send to the target agent.",
      }),
      contextId: Type.Optional(
        Type.String({
          description: "Context ID for grouping related tasks. Omit to start a new context.",
        }),
      ),
    }),
    execute: async (args) => {
      const storage = getStorage();

      try {
        const depth = await checkDepth(storage, options.maxDepth);
        const client = resolveClient(args.targetAgent, options);

        const task = await client.sendMessage({
          message: {
            messageId: crypto.randomUUID(),
            role: "user",
            parts: [{ text: args.message }],
            ...(args.contextId ? { contextId: args.contextId } : {}),
            metadata: { "claw:depth": depth + 1 },
          },
          configuration: { blocking: true },
        });

        // Extract response text
        const responseText =
          task.status.message?.parts
            .filter(isTextPart)
            .map((p) => p.text)
            .join("\n") ?? "No response";

        return {
          content: [{ type: "text" as const, text: responseText }],
          details: {
            taskId: task.id,
            contextId: task.contextId,
            state: task.status.state,
            targetAgent: args.targetAgent,
          },
        };
      } catch (err) {
        const message =
          err instanceof A2AClientError
            ? `A2A error (${err.code}): ${err.message}`
            : err instanceof Error
              ? err.message
              : "Unknown error";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { error: true, targetAgent: args.targetAgent },
        };
      }
    },
  });
}

/**
 * Non-blocking delegation tool — starts a task on another agent and returns immediately.
 * The result arrives later via push notification.
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createStartTaskTool(
  options: A2AToolOptions,
  getStorage: () => CapabilityStorage,
  getSessionId: () => string,
): AgentTool<any> {
  return defineTool({
    name: "start_task",
    description:
      "Start a long-running task on another agent. Returns immediately with a task ID. " +
      "The result will arrive asynchronously via push notification — no need to poll.",
    parameters: Type.Object({
      targetAgent: Type.String({
        description: "Agent URL (https://...) or same-platform agent ID to delegate to.",
      }),
      message: Type.String({
        description: "The task description to send to the target agent.",
      }),
      contextId: Type.Optional(
        Type.String({
          description: "Context ID for grouping related tasks. Omit to start a new context.",
        }),
      ),
    }),
    execute: async (args) => {
      const storage = getStorage();

      try {
        const depth = await checkDepth(storage, options.maxDepth);

        // Generate webhook token for push notification verification
        const webhookToken = crypto.randomUUID();
        const pushConfig: PushNotificationConfig = {
          url: `${options.callbackBaseUrl}/a2a-callback`,
          token: webhookToken,
        };

        const client = resolveClient(args.targetAgent, options);

        // Discover target agent name
        let targetAgentName = args.targetAgent;
        try {
          const card = await getAgentCard(args.targetAgent, fetch, storage);
          targetAgentName = card.name;
        } catch {
          // Use raw identifier if card fetch fails
        }

        const task = await client.sendMessage({
          message: {
            messageId: crypto.randomUUID(),
            role: "user",
            parts: [{ text: args.message }],
            ...(args.contextId ? { contextId: args.contextId } : {}),
            metadata: { "claw:depth": depth + 1 },
          },
          configuration: {
            blocking: false,
            pushNotificationConfig: pushConfig,
          },
        });

        // Store pending task (survives hibernation)
        const taskStore = new PendingTaskStore(storage);
        await taskStore.save({
          taskId: task.id,
          contextId: task.contextId,
          targetAgent: args.targetAgent,
          targetAgentName,
          originalRequest: args.message,
          state: task.status.state,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          originSessionId: getSessionId(),
          webhookToken,
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Task started on "${targetAgentName}" (task ID: ${task.id}). ` +
                `Current state: ${task.status.state}. ` +
                "The result will arrive via push notification — no need to poll.",
            },
          ],
          details: {
            taskId: task.id,
            contextId: task.contextId,
            state: task.status.state,
            targetAgent: args.targetAgent,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { error: true, targetAgent: args.targetAgent },
        };
      }
    },
  });
}

/**
 * Check the status of a previously started task.
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createCheckTaskTool(
  options: A2AToolOptions,
  getStorage: () => CapabilityStorage,
): AgentTool<any> {
  return defineTool({
    name: "check_task",
    description: "Check the status of an A2A task that was started with start_task.",
    parameters: Type.Object({
      taskId: Type.String({
        description: "The A2A task ID (returned by start_task).",
      }),
    }),
    execute: async (args) => {
      const storage = getStorage();
      const taskStore = new PendingTaskStore(storage);
      const pending = await taskStore.get(args.taskId);

      if (!pending) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No pending task found with ID: ${args.taskId}`,
            },
          ],
          details: { error: true },
        };
      }

      try {
        const client = resolveClient(pending.targetAgent, options);
        const task = await client.getTask(args.taskId);
        await taskStore.updateState(args.taskId, task.status.state);

        const statusText =
          task.status.message?.parts
            .filter(isTextPart)
            .map((p) => p.text)
            .join("\n") ?? "";

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Task ${args.taskId} on "${pending.targetAgentName}": ${task.status.state}` +
                (statusText ? `\n${statusText}` : ""),
            },
          ],
          details: {
            taskId: task.id,
            state: task.status.state,
            targetAgent: pending.targetAgent,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { error: true },
        };
      }
    },
  });
}

/**
 * Cancel an in-flight A2A task.
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function createCancelTaskTool(
  options: A2AToolOptions,
  getStorage: () => CapabilityStorage,
): AgentTool<any> {
  return defineTool({
    name: "cancel_task",
    description: "Cancel an in-flight A2A task.",
    parameters: Type.Object({
      taskId: Type.String({
        description: "The A2A task ID to cancel.",
      }),
    }),
    execute: async (args) => {
      const storage = getStorage();
      const taskStore = new PendingTaskStore(storage);
      const pending = await taskStore.get(args.taskId);

      if (!pending) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No pending task found with ID: ${args.taskId}`,
            },
          ],
          details: { error: true },
        };
      }

      try {
        const client = resolveClient(pending.targetAgent, options);
        const task = await client.cancelTask(args.taskId);
        await taskStore.updateState(args.taskId, "canceled");
        await taskStore.delete(args.taskId);

        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${args.taskId} on "${pending.targetAgentName}" has been canceled.`,
            },
          ],
          details: {
            taskId: task.id,
            state: task.status.state,
            targetAgent: pending.targetAgent,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { error: true },
        };
      }
    },
  });
}
