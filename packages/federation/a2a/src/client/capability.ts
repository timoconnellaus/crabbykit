import type { Capability, CapabilityStorage } from "@crabbykit/agent-runtime";
import { createCallbackHandler } from "./handlers.js";
import { PendingTaskStore } from "./pending-tasks.js";
import type { A2AToolOptions } from "./tools.js";
import {
  createCallAgentTool,
  createCancelTaskTool,
  createCheckTaskTool,
  createStartTaskTool,
} from "./tools.js";

// ============================================================================
// Options
// ============================================================================

export interface A2AClientOptions {
  /** This agent's DO ID. */
  agentId: string;
  /** This agent's human-readable name. */
  agentName?: string;
  /** Get a DO stub for a same-platform agent by ID. */
  getAgentStub: (id: string) => {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
  /**
   * Base URL for push notification webhooks.
   * For same-platform DO-to-DO calls: "https://agent" (stub URL convention).
   * For cross-platform calls: a real HTTPS URL.
   */
  callbackBaseUrl: string;
  /** Max agent chain depth. Default: 5. */
  maxDepth?: number;
  /** Build auth headers for outbound A2A calls. */
  authHeaders?: (targetAgent: string) => Record<string, string> | Promise<Record<string, string>>;
}

const DEFAULT_MAX_DEPTH = 5;

// ============================================================================
// Capability Factory
// ============================================================================

/**
 * Create the A2A client capability.
 *
 * Provides tools for calling other A2A agents:
 *   call_agent  — blocking delegation (quick sub-tasks)
 *   start_task  — non-blocking delegation (long-running, supports hibernation)
 *   check_task  — check status of a running task
 *   cancel_task — cancel an in-flight task
 *
 * Registers HTTP handler:
 *   POST /a2a-callback — receives push notification webhooks
 */
export function a2aClient(options: A2AClientOptions): Capability {
  let _storage: CapabilityStorage | undefined;

  const getStorage = (): CapabilityStorage => {
    if (!_storage) {
      throw new Error("A2A client not initialized — capability must be registered");
    }
    return _storage;
  };

  const toolOptions: A2AToolOptions = {
    agentId: options.agentId,
    agentName: options.agentName,
    getAgentStub: options.getAgentStub,
    callbackBaseUrl: options.callbackBaseUrl,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    authHeaders: options.authHeaders,
  };

  return {
    id: "a2a-client",
    name: "A2A Client",
    description: "Discover and call other agents via the A2A protocol.",

    tools: (context) => {
      _storage = context.storage;
      const getSessionId = () => context.sessionId;
      return [
        createCallAgentTool(toolOptions, getStorage, getSessionId),
        createStartTaskTool(toolOptions, getStorage, getSessionId),
        createCheckTaskTool(toolOptions, getStorage),
        createCancelTaskTool(toolOptions, getStorage),
      ];
    },

    httpHandlers: (context) => {
      _storage = context.storage;
      return [createCallbackHandler(getStorage)];
    },

    hooks: {
      onConnect: async (ctx) => {
        const taskStore = new PendingTaskStore(ctx.storage);
        const active = await taskStore.listActive();
        if (active.length > 0 && ctx.broadcast) {
          ctx.broadcast("a2a_active_tasks", {
            tasks: active.map((t) => ({
              taskId: t.taskId,
              targetAgent: t.targetAgent,
              targetAgentName: t.targetAgentName,
              state: t.state,
              originalRequest: t.originalRequest,
              createdAt: t.createdAt,
            })),
          });
        }
      },
    },
  };
}
