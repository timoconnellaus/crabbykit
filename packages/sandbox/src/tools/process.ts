import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { checkElevation } from "../elevation.js";
import { resetDeElevationTimer } from "../timer.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

const PROCESS_NAME_PATTERN = "^[a-zA-Z0-9_-]+$";

export function createStartProcessTool(
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "start_process",
    description:
      "Start a named long-running process (dev server, watcher, etc.). Use this instead of bash for processes that run indefinitely.",
    parameters: Type.Object({
      name: Type.String({
        description: "Unique name for the process",
        pattern: PROCESS_NAME_PATTERN,
      }),
      command: Type.String({ description: "Command to run" }),
    }),
    execute: async (args) => {
      const notElevated = await checkElevation(context.storage);
      if (notElevated) return notElevated;

      const result = await provider.processStart!(args.name, args.command, config.defaultCwd);

      // Reset timer with active process timeout
      await resetDeElevationTimer(provider, config, context, config.activeTimeout);
      context.broadcast("sandbox_timeout", {
        expiresAt: Date.now() + config.activeTimeout * 1000,
        timeoutSeconds: config.activeTimeout,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Process "${args.name}" started.${result.pid ? ` PID: ${result.pid}` : ""}`,
          },
        ],
        details: { name: args.name, command: args.command, pid: result.pid },
      };
    },
  });
}

export function createStopProcessTool(
  provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "stop_process",
    description: "Stop a named long-running process.",
    parameters: Type.Object({
      name: Type.String({
        description: "Name of the process to stop",
        pattern: PROCESS_NAME_PATTERN,
      }),
    }),
    execute: async (args) => {
      const notElevated = await checkElevation(context.storage);
      if (notElevated) return notElevated;

      await provider.processStop!(args.name);

      return {
        content: [{ type: "text" as const, text: `Process "${args.name}" stopped.` }],
        details: { name: args.name },
      };
    },
  });
}

export function createGetProcessStatusTool(
  provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "get_process_status",
    description: "List all managed processes and their status.",
    parameters: Type.Object({}),
    execute: async () => {
      const notElevated = await checkElevation(context.storage);
      if (notElevated) return notElevated;

      const processes = await provider.processList!();

      if (processes.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No managed processes." }],
          details: { processes: [] },
        };
      }

      const lines = processes.map((p) => {
        const status = p.running ? "running" : `stopped (exit ${p.exitCode ?? "unknown"})`;
        return `${p.name}: ${status} — ${p.command}${p.pid ? ` (PID ${p.pid})` : ""}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { processes },
      };
    },
  });
}
