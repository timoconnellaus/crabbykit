import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { TIMER_ID } from "./timer.js";
import { createBashTool } from "./tools/bash.js";
import {
  createDeleteFileCredentialTool,
  createListFileCredentialsTool,
  createSaveFileCredentialTool,
} from "./tools/credentials.js";
import { createDeElevateTool } from "./tools/de-elevate.js";
import { createElevateTool } from "./tools/elevate.js";
import {
  createGetProcessStatusTool,
  createStartProcessTool,
  createStopProcessTool,
} from "./tools/process.js";
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
 * - `bash` — Execute shell commands (requires elevation)
 * - `start_process` — Start a long-running process (if provider supports it)
 * - `stop_process` — Stop a process (if provider supports it)
 * - `get_process_status` — List process status (if provider supports it)
 */
export function sandboxCapability(options: SandboxCapabilityOptions): Capability {
  const resolvedConfig: Required<SandboxConfig> = {
    idleTimeout: options.config?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
    activeTimeout: options.config?.activeTimeout ?? DEFAULT_ACTIVE_TIMEOUT,
    defaultCwd: options.config?.defaultCwd ?? DEFAULT_CWD,
    defaultExecTimeout: options.config?.defaultExecTimeout ?? DEFAULT_EXEC_TIMEOUT,
  };

  /** Clear all elevation state from storage. */
  async function clearElevationState(storage: {
    put: (k: string, v: unknown) => Promise<void>;
    delete: (k: string) => Promise<boolean>;
  }): Promise<void> {
    await storage.put("elevated", false);
    await storage.delete("elevationReason");
    await storage.delete("elevatedAt");
  }

  return {
    id: "sandbox",
    name: "Sandbox",
    description: "Provides elevated sandbox execution environment with shell access.",

    tools: (context: AgentContext) => {
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createElevateTool(options.provider, resolvedConfig, context),
        createDeElevateTool(options.provider, resolvedConfig, context),
        createBashTool(options.provider, resolvedConfig, context),
      ];

      if (options.provider.processStart) {
        tools.push(createStartProcessTool(options.provider, resolvedConfig, context));
      }
      if (options.provider.processStop) {
        tools.push(createStopProcessTool(options.provider, resolvedConfig, context));
      }
      if (options.provider.processList) {
        tools.push(createGetProcessStatusTool(options.provider, resolvedConfig, context));
      }

      // File credential tools (always available — reads/writes files in the container)
      tools.push(createSaveFileCredentialTool(options.provider, resolvedConfig, context));
      tools.push(createListFileCredentialsTool(options.provider, resolvedConfig, context));
      tools.push(createDeleteFileCredentialTool(options.provider, resolvedConfig, context));

      return tools;
    },

    promptSections: () => [
      "You have access to a sandbox environment for shell access. Use the `elevate` tool to activate it when you need to run shell commands, install packages, or start servers. The sandbox will auto-deactivate after a period of inactivity to conserve resources. Use the `bash` tool for one-off commands and `start_process` for long-running tasks like dev servers.",
    ],

    hooks: {
      beforeInference: async (messages, ctx) => {
        const elevated = await ctx.storage.get<boolean>("elevated");

        if (elevated) {
          const reason = await ctx.storage.get<string>("elevationReason");
          const guidance = [
            `[Sandbox Status: ACTIVE${reason ? ` — ${reason}` : ""}]`,
            "You have an active Linux sandbox. Use the bash tool freely for shell commands.",
            "For long-running processes (servers, watchers), use start_process instead of bash.",
            "Packages installed globally (npm -g, pip) persist via environment configuration.",
          ].join("\n");

          return [{ role: "user" as const, content: guidance, timestamp: 0 }, ...messages];
        }

        return messages;
      },

      onConnect: async (ctx) => {
        const elevated = await ctx.storage.get<boolean>("elevated");

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
          // Container is dead — clear stale elevation state
          console.warn("[sandbox] Stale elevation detected on connect — clearing");
          await clearElevationState(ctx.storage);
          ctx.broadcast?.("sandbox_elevation", { elevated: false });
          // Timer will self-clean when it fires and finds elevated=false
          return;
        }

        // Container is alive — broadcast current state to reconnecting client
        const reason = await ctx.storage.get<string>("elevationReason");
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

            const elevated = await storage.get<boolean>("elevated");
            if (!elevated) return;

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

            // Clear elevation state
            await clearElevationState(storage);

            // Broadcast to ALL sessions (not just one)
            context.broadcastToAll("sandbox_elevation", { elevated: false });

            // Inject de-elevation notice into sessions so the LLM
            // knows it lost shell access on the next turn
            try {
              const sessions = scheduleCtx.sessionStore.list();
              for (const session of sessions) {
                scheduleCtx.sessionStore.appendEntry(session.id, {
                  type: "message",
                  data: {
                    role: "assistant",
                    content: [{ type: "text", text: DE_ELEVATION_NOTICE }],
                    timestamp: Date.now(),
                  },
                });
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
