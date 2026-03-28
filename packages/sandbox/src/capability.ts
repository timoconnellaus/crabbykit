import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { TIMER_ID } from "./timer.js";
import { createBashTool } from "./tools/bash.js";
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
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   return [
 *     sandboxCapability({
 *       provider: new CloudflareSandboxProvider({
 *         getStub: () => this.env.SANDBOX.get(this.env.SANDBOX.idFromName(this.agentId)),
 *       }),
 *       config: { idleTimeout: 300 },
 *     }),
 *   ];
 * }
 * ```
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

      return tools;
    },

    promptSections: () => [
      "You have access to a sandbox environment for shell access. Use the `elevate` tool to activate it when you need to run shell commands, install packages, or start servers. The sandbox will auto-deactivate after a period of inactivity to conserve resources. Use the `bash` tool for one-off commands and `start_process` for long-running tasks like dev servers.",
    ],

    hooks: {
      beforeInference: async (messages, ctx) => {
        // Inject dynamic elevation state into the conversation context
        const elevated = await ctx.storage.get<boolean>("elevated");

        if (elevated) {
          const reason = await ctx.storage.get<string>("elevationReason");
          const guidance = [
            `[Sandbox Status: ACTIVE${reason ? ` — ${reason}` : ""}]`,
            "You have an active Linux sandbox. Use the bash tool freely for shell commands.",
            "For long-running processes (servers, watchers), use start_process instead of bash.",
            "Packages installed globally (npm -g, pip) persist via environment configuration.",
          ].join("\n");

          // Prepend as a system-style user message
          return [{ role: "user" as const, content: guidance, timestamp: 0 }, ...messages];
        }

        return messages;
      },
    },

    schedules: (context: AgentContext) => {
      // Re-register timer callback for hibernation resilience.
      // If a timer schedule exists in the DB, this ensures the callback
      // gets re-registered after DO wake-up.
      return [
        {
          id: TIMER_ID,
          name: "sandbox-de-elevate",
          delaySeconds: resolvedConfig.idleTimeout,
          callback: async () => {
            const storage = context.storage;
            if (!storage) return;

            const elevated = await storage.get<boolean>("elevated");
            if (!elevated) return;

            try {
              await options.provider.stop();
            } catch {
              // Best-effort
            }

            await storage.put("elevated", false);
            await storage.delete("elevationReason");
            await storage.delete("elevatedAt");

            context.broadcast("sandbox_elevation", { elevated: false });
          },
        },
      ];
    },
  };
}
