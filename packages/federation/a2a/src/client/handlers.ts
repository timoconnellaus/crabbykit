import type {
  CapabilityHttpContext,
  CapabilityStorage,
  HttpHandler,
} from "@crabbykit/agent-runtime";
import type { TaskStatusUpdateEvent } from "../types.js";
import { isTerminalState, isTextPart } from "../types.js";
import { PendingTaskStore } from "./pending-tasks.js";

/**
 * Create the push notification webhook handler.
 * Receives task completion callbacks from A2A servers.
 */
export function createCallbackHandler(getStorage: () => CapabilityStorage): HttpHandler {
  return {
    method: "POST" as const,
    path: "/a2a-callback",
    handler: async (request: Request, ctx: CapabilityHttpContext): Promise<Response> => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Extract task status update from the push notification
      const update = body as TaskStatusUpdateEvent;
      if (!update?.taskId || !update?.status) {
        return new Response(JSON.stringify({ error: "Missing taskId or status" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const storage = getStorage();
      const taskStore = new PendingTaskStore(storage);
      const pending = await taskStore.get(update.taskId);

      if (!pending) {
        return new Response(JSON.stringify({ error: "Unknown task" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Verify webhook token
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== `Bearer ${pending.webhookToken}`) {
        return new Response(JSON.stringify({ error: "Invalid webhook token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Update stored task state
      await taskStore.updateState(update.taskId, update.status.state);

      // If terminal state, inject result into the originating session
      if (isTerminalState(update.status.state)) {
        const resultText = formatTaskResult(update, pending);

        try {
          await ctx.sendPrompt({
            text: resultText,
            sessionId: pending.originSessionId,
            source: "a2a-callback",
          });
        } catch {
          // Session may be busy — result is persisted in task store regardless
        }

        // Clean up
        await taskStore.delete(update.taskId);
      }

      // Broadcast status update to connected WebSocket clients
      ctx.broadcastToAll("a2a_task_update", {
        taskId: pending.taskId,
        targetAgent: pending.targetAgent,
        targetAgentName: pending.targetAgentName,
        state: update.status.state,
        originalRequest: pending.originalRequest,
      });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function formatTaskResult(
  update: TaskStatusUpdateEvent,
  pending: { targetAgentName: string; originalRequest: string },
): string {
  const statusMessage = update.status.message?.parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join("\n");

  if (update.status.state === "completed") {
    return (
      `[A2A Task Complete] Agent "${pending.targetAgentName}" finished the task.\n` +
      `Original request: ${pending.originalRequest}\n` +
      `Result: ${statusMessage ?? "No response text"}`
    );
  }

  if (update.status.state === "failed") {
    return (
      `[A2A Task Failed] Agent "${pending.targetAgentName}" failed.\n` +
      `Original request: ${pending.originalRequest}\n` +
      `Error: ${statusMessage ?? "Unknown error"}`
    );
  }

  return (
    `[A2A Task ${update.status.state}] Agent "${pending.targetAgentName}"\n` +
    `Original request: ${pending.originalRequest}\n` +
    (statusMessage ? `Details: ${statusMessage}` : "")
  );
}
