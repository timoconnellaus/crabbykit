import type { SessionStore } from "@claw-for-cloudflare/agent-runtime";
import type {
  AgentCard,
  AgentSkill,
  Message,
  MessageSendParams,
  SecurityScheme,
  TaskStatus,
} from "../types.js";
import { isTextPart } from "../types.js";
import type { A2AEventBus } from "./event-bus.js";
import type { AgentExecutor, ExecuteResult } from "./executor.js";
import { firePushNotificationsForTask } from "./push-notifications.js";
import type { TaskStore } from "./task-store.js";

// ============================================================================
// Configuration
// ============================================================================

export interface AgentCardConfig {
  name: string;
  description?: string;
  url: string;
  version?: string;
  skills?: AgentSkill[];
  provider?: { organization: string; url?: string };
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Array<Record<string, string[]>>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/** Callback type matching CapabilityHttpContext.sendPrompt. */
export type SendPromptFn = (opts: {
  text: string;
  sessionId?: string;
  sessionName?: string;
  source?: string;
}) => Promise<{ sessionId: string; response: string }>;

export interface ClawExecutorOptions {
  agentCardConfig: AgentCardConfig;
  getSessionAgentHandle?: (sessionId: string) => { abort: () => void; isStreaming: boolean } | null;
}

/**
 * Runtime context provided to the executor per-request.
 * Resolved lazily from CapabilityHttpContext.
 */
export interface ClawExecutorContext {
  sendPrompt: SendPromptFn;
  sessionStore: SessionStore;
}

// ============================================================================
// CLAW Executor
// ============================================================================

/**
 * Bridges the A2A protocol to CLAW's execution machinery.
 * Uses sendPrompt() (from CapabilityHttpContext) to trigger inference.
 */
export class ClawExecutor implements AgentExecutor {
  private ctx: ClawExecutorContext | null = null;

  constructor(private opts: ClawExecutorOptions) {}

  /** Set the runtime context. Called per-request by the capability wrapper. */
  setContext(ctx: ClawExecutorContext): void {
    this.ctx = ctx;
  }

  private requireContext(): ClawExecutorContext {
    if (!this.ctx) throw new Error("ClawExecutor context not set");
    return this.ctx;
  }

  async execute(
    taskId: string,
    params: MessageSendParams,
    eventBus: A2AEventBus,
    taskStore: TaskStore,
  ): Promise<ExecuteResult> {
    console.log(`[a2a] execute: taskId=${taskId}, blocking=${params.configuration?.blocking !== false}`);

    const text = this.extractText(params.message);
    if (!text) {
      const failedStatus: TaskStatus = {
        state: "failed",
        timestamp: new Date().toISOString(),
        message: {
          messageId: `${taskId}-error`,
          role: "agent",
          parts: [{ text: "Message contained no text content" }],
        },
      };
      taskStore.updateStatus(taskId, failedStatus);
      eventBus.emitStatusUpdate(taskId, taskId, failedStatus, true);
      return { task: taskStore.get(taskId)! };
    }

    // Resolve context → session mapping
    const contextId = params.message.contextId ?? taskId;
    const ctx = this.requireContext();

    // Look up if there's an existing session for this context
    let sessionId = taskStore.getSessionIdForContext(contextId);

    // Verify the session actually exists (the stored ID might be stale or a placeholder).
    // SessionStore.get() uses .one() which throws on missing rows, so we catch that.
    if (sessionId) {
      try {
        const existingSession = ctx.sessionStore.get(sessionId);
        if (!existingSession) {
          sessionId = null;
        }
      } catch {
        sessionId = null; // Session doesn't exist, need to create one
      }
    }

    if (!sessionId) {
      // Create a new session
      const sessionName = `A2A: ${text.slice(0, 50)}`;
      console.log(`[a2a] creating session: name="${sessionName}"`);
      const session = ctx.sessionStore.create({
        name: sessionName,
        source: "a2a",
      });
      sessionId = session.id;
      console.log(`[a2a] session created: id=${sessionId}`);
    } else {
      console.log(`[a2a] reusing session: id=${sessionId}`);
    }

    // At this point sessionId is guaranteed to be set
    const resolvedSessionId = sessionId as string;

    // Emit status transitions
    const submittedStatus: TaskStatus = {
      state: "submitted",
      timestamp: new Date().toISOString(),
    };
    eventBus.emitStatusUpdate(taskId, contextId, submittedStatus, false);

    const workingStatus: TaskStatus = {
      state: "working",
      timestamp: new Date().toISOString(),
    };
    taskStore.updateStatus(taskId, workingStatus);
    eventBus.emitStatusUpdate(taskId, contextId, workingStatus, false);

    const blocking = params.configuration?.blocking !== false;

    if (blocking) {
      return this.executeBlocking(taskId, contextId, resolvedSessionId, text, eventBus, taskStore);
    }
    return this.executeNonBlocking(taskId, contextId, resolvedSessionId, text, eventBus, taskStore);
  }

  async cancel(taskId: string, taskStore: TaskStore): Promise<boolean> {
    if (!this.opts.getSessionAgentHandle) return false;

    const sessionId = taskStore.getSessionId(taskId);
    if (!sessionId) return false;

    const handle = this.opts.getSessionAgentHandle(sessionId);
    if (!handle?.isStreaming) return false;

    handle.abort();
    return true;
  }

  getAgentCard(): AgentCard {
    const cfg = this.opts.agentCardConfig;
    return {
      name: cfg.name,
      description: cfg.description ?? cfg.name,
      url: cfg.url,
      version: cfg.version ?? "1.0.0",
      protocolVersion: "1.0",
      capabilities: {
        streaming: true,
        pushNotifications: true,
        stateTransitionHistory: true,
      },
      ...(cfg.provider ? { provider: cfg.provider } : {}),
      ...(cfg.securitySchemes ? { securitySchemes: cfg.securitySchemes } : {}),
      ...(cfg.security ? { security: cfg.security } : {}),
      skills: cfg.skills ?? [],
      defaultInputModes: cfg.defaultInputModes ?? ["text/plain"],
      defaultOutputModes: cfg.defaultOutputModes ?? ["text/plain"],
    };
  }

  // --- Private ---

  private async executeBlocking(
    taskId: string,
    contextId: string,
    sessionId: string,
    text: string,
    eventBus: A2AEventBus,
    taskStore: TaskStore,
  ): Promise<ExecuteResult> {
    try {
      console.log(`[a2a] sendPrompt: sessionId=${sessionId}, text="${text.slice(0, 80)}"`);
      const { response } = await this.requireContext().sendPrompt({
        text,
        sessionId,
        source: "a2a",
      });
      console.log(`[a2a] sendPrompt complete: response="${response.slice(0, 80)}"`);

      const completedStatus: TaskStatus = {
        state: "completed",
        timestamp: new Date().toISOString(),
        message: {
          messageId: `${taskId}-response`,
          role: "agent",
          parts: [{ text: response }],
        },
      };
      taskStore.updateStatus(taskId, completedStatus);
      eventBus.emitStatusUpdate(taskId, contextId, completedStatus, true);

      const task = taskStore.get(taskId)!;
      task.artifacts = taskStore.getArtifacts(taskId);
      eventBus.emitComplete(taskId, task);
      return { task };
    } catch (err) {
      console.error(`[a2a] sendPrompt failed:`, err instanceof Error ? err.message : err);
      const failedStatus: TaskStatus = {
        state: "failed",
        timestamp: new Date().toISOString(),
        message: {
          messageId: `${taskId}-error`,
          role: "agent",
          parts: [
            {
              text: err instanceof Error ? err.message : "Execution failed",
            },
          ],
        },
      };
      taskStore.updateStatus(taskId, failedStatus);
      eventBus.emitStatusUpdate(taskId, contextId, failedStatus, true);

      const task = taskStore.get(taskId)!;
      eventBus.emitComplete(taskId, task);
      return { task };
    }
  }

  private executeNonBlocking(
    taskId: string,
    contextId: string,
    sessionId: string,
    text: string,
    eventBus: A2AEventBus,
    taskStore: TaskStore,
  ): Promise<ExecuteResult> {
    // Fire and forget — run inference in the background
    const ctx = this.requireContext();
    ctx
      .sendPrompt({ text, sessionId, source: "a2a" })
      .then(({ response }: { response: string }) => {
        const completedStatus: TaskStatus = {
          state: "completed",
          timestamp: new Date().toISOString(),
          message: {
            messageId: `${taskId}-response`,
            role: "agent",
            parts: [{ text: response }],
          },
        };
        taskStore.updateStatus(taskId, completedStatus);
        eventBus.emitStatusUpdate(taskId, contextId, completedStatus, true);

        // Fire push notification if configured
        firePushNotificationsForTask(taskStore, taskId, {
          taskId,
          contextId,
          status: completedStatus,
          final: true,
        });
      })
      .catch((err: unknown) => {
        const failedStatus: TaskStatus = {
          state: "failed",
          timestamp: new Date().toISOString(),
          message: {
            messageId: `${taskId}-error`,
            role: "agent",
            parts: [
              {
                text: err instanceof Error ? err.message : "Execution failed",
              },
            ],
          },
        };
        taskStore.updateStatus(taskId, failedStatus);

        firePushNotificationsForTask(taskStore, taskId, {
          taskId,
          contextId,
          status: failedStatus,
          final: true,
        });
      });

    // Return immediately with working state
    const task = taskStore.get(taskId)!;
    return Promise.resolve({ task });
  }

  private extractText(message: Message): string | null {
    const texts = message.parts.filter(isTextPart).map((p) => p.text);
    if (texts.length === 0) return null;
    return texts.join("\n");
  }
}
