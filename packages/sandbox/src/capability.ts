import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import {
  clearAllElevation,
  clearAllProcessOwners,
  getElevatedSessionIds,
  getSessionReason,
  isSessionElevated,
} from "./session-state.js";
import { TIMER_ID } from "./timer.js";
import {
  createDeleteFileCredentialTool,
  createListFileCredentialsTool,
  createSaveFileCredentialTool,
} from "./tools/credentials.js";
import { createDeElevateTool } from "./tools/de-elevate.js";
import { createElevateTool } from "./tools/elevate.js";
import { createExecTool } from "./tools/exec.js";
import { createProcessTool } from "./tools/process.js";
import type { SandboxConfig, SandboxProvider } from "./types.js";

const DEFAULT_IDLE_TIMEOUT = 180;
const DEFAULT_ACTIVE_TIMEOUT = 900;
const DEFAULT_CWD = "/mnt/r2";
const DEFAULT_EXEC_TIMEOUT = 60_000;

const DE_ELEVATION_NOTICE =
  "[System: The sandbox has been automatically deactivated due to inactivity. " +
  "Bash and shell commands are no longer available. Use the elevate tool if sandbox access is needed again.]";

export interface SandboxCapabilityOptions {
  /** The sandbox execution provider. */
  provider: SandboxProvider;
  /** Configuration overrides. */
  config?: SandboxConfig;
}

/**
 * Create a sandbox capability that provides shell access via an elevation model.
 *
 * Tools provided:
 * - `elevate` — Activate the sandbox
 * - `de_elevate` — Deactivate the sandbox
 * - `exec` — Execute shell commands with session tracking (requires elevation)
 * - `process` — Manage backgrounded sessions (poll, log, write, kill, list, remove)
 */
export function sandboxCapability(options: SandboxCapabilityOptions): Capability {
  const resolvedConfig: Required<SandboxConfig> = {
    idleTimeout: options.config?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
    activeTimeout: options.config?.activeTimeout ?? DEFAULT_ACTIVE_TIMEOUT,
    defaultCwd: options.config?.defaultCwd ?? DEFAULT_CWD,
    defaultExecTimeout: options.config?.defaultExecTimeout ?? DEFAULT_EXEC_TIMEOUT,
  };

  return {
    id: "sandbox",
    name: "Sandbox",
    description: "Provides elevated sandbox execution environment with shell access.",

    tools: (context: AgentContext) => {
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createElevateTool(options.provider, resolvedConfig, context),
        createDeElevateTool(options.provider, resolvedConfig, context),
        createExecTool(options.provider, resolvedConfig, context),
        createProcessTool(options.provider, resolvedConfig, context),
      ];

      // File credential tools (always available — reads/writes files in the container)
      tools.push(createSaveFileCredentialTool(options.provider, resolvedConfig, context));
      tools.push(createListFileCredentialsTool(options.provider, resolvedConfig, context));
      tools.push(createDeleteFileCredentialTool(options.provider, resolvedConfig, context));

      return tools;
    },

    promptSections: () => [
      "You have access to a sandbox environment for shell access. Use the `elevate` tool to activate it when you need to run shell commands, install packages, or start servers. The sandbox will auto-deactivate after a period of inactivity to conserve resources.\n\nUse `exec` to run commands. All output is logged to a file in the container. For long-running commands (dev servers, watchers, builds), set `background=true` to get a session ID, then use the `process` tool to poll output, send input, or kill the session.",
    ],

    hooks: {
      beforeInference: async (messages, ctx) => {
        const elevated = await isSessionElevated(ctx.storage, ctx.sessionId);

        if (elevated) {
          const reason = await getSessionReason(ctx.storage, ctx.sessionId);
          const guidance = [
            `[Sandbox Status: ACTIVE${reason ? ` — ${reason}` : ""}]`,
            "You have an active Linux sandbox. Use the exec tool for shell commands.",
            "For long-running processes (servers, watchers), use exec with background=true.",
            "Use the process tool (poll/log/write/kill) to manage backgrounded sessions.",
            "All command output is logged to files in the container for later inspection.",
          ].join("\n");

          return [{ role: "user" as const, content: guidance, timestamp: 0 }, ...messages];
        }

        return messages;
      },

      onConnect: async (ctx) => {
        const elevated = await isSessionElevated(ctx.storage, ctx.sessionId);

        if (!elevated) {
          // Broadcast not-elevated so reconnecting clients clear stale UI state
          ctx.broadcast?.("sandbox_elevation", { elevated: false });
          return;
        }

        // Verify the container is actually running
        try {
          const health = await options.provider.health();
          if (!health.ready) {
            throw new Error("Container not ready");
          }
        } catch {
          // Container is dead — clear ALL stale elevation state
          console.warn("[sandbox] Stale elevation detected on connect — clearing");
          await clearAllElevation(ctx.storage);
          await clearAllProcessOwners(ctx.storage);
          ctx.broadcast?.("sandbox_elevation", { elevated: false });
          return;
        }

        // Container is alive — broadcast current state to reconnecting client
        const reason = await getSessionReason(ctx.storage, ctx.sessionId);
        ctx.broadcast?.("sandbox_elevation", {
          elevated: true,
          reason: reason ?? "",
        });
      },
    },

    schedules: (context: AgentContext) => {
      return [
        {
          id: TIMER_ID,
          name: "sandbox-de-elevate",
          delaySeconds: resolvedConfig.idleTimeout,
          callback: async (scheduleCtx) => {
            const storage = context.storage;
            if (!storage) return;

            // Get the set of elevated sessions before clearing
            const elevatedIds = await getElevatedSessionIds(storage);
            if (elevatedIds.length === 0) return;

            // Abort all running agent sessions so in-flight tool calls
            // (e.g., bash awaiting a response from the container) don't hang
            // after the container is stopped.
            scheduleCtx.abortAllSessions();

            // Stop running processes before de-elevating
            if (options.provider.processList && options.provider.processStop) {
              try {
                const processes = await options.provider.processList();
                for (const p of processes) {
                  if (p.running) {
                    await options.provider.processStop(p.name).catch(() => {});
                  }
                }
              } catch {
                // Best-effort process cleanup
              }
            }

            // Stop the container
            try {
              await options.provider.stop();
            } catch {
              // Best-effort
            }

            // Clear all elevation and process ownership state
            await clearAllElevation(storage);
            await clearAllProcessOwners(storage);

            // Broadcast to ALL sessions (not just one)
            context.broadcastToAll("sandbox_elevation", { elevated: false });

            // Inject de-elevation notice ONLY into sessions that were elevated
            const elevatedSet = new Set(elevatedIds);
            try {
              const sessions = scheduleCtx.sessionStore.list();
              for (const session of sessions) {
                if (elevatedSet.has(session.id)) {
                  scheduleCtx.sessionStore.appendEntry(session.id, {
                    type: "message",
                    data: {
                      role: "assistant",
                      content: [{ type: "text", text: DE_ELEVATION_NOTICE }],
                      timestamp: Date.now(),
                      metadata: { hidden: true },
                    },
                  });
                }
              }
            } catch {
              // Best-effort notice injection
            }
          },
        },
      ];
    },
  };
}
