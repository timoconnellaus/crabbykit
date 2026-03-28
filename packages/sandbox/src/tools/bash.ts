import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { checkElevation } from "../elevation.js";
import { resetDeElevationTimer } from "../timer.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

const INSTALL_PATTERNS = [
  /\b(npm|npx)\s+(i|install|ci)\b/,
  /\bbun\s+(i|install|add)\b/,
  /\bpnpm\s+(i|install|add)\b/,
  /\bpip\s+install\b/,
  /\bcargo\s+(build|install)\b/,
  /\bgo\s+(get|install)\b/,
  /\bgem\s+install\b/,
];

function isInstallCommand(command: string): boolean {
  return INSTALL_PATTERNS.some((p) => p.test(command));
}

export function createBashTool(
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "bash",
    description: "Execute a shell command in the sandbox. Requires elevation.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds",
          minimum: 1000,
        }),
      ),
    }),
    execute: async (args) => {
      // Check elevation
      const notElevated = await checkElevation(context.storage);
      if (notElevated) return notElevated;

      const timeout = args.timeout ?? config.defaultExecTimeout;
      const result = await provider.exec(args.command, {
        timeout,
        cwd: config.defaultCwd,
      });

      // Reset de-elevation timer on activity
      // Use activeTimeout if processes are running
      let hasActiveProcesses = false;
      if (provider.processList) {
        try {
          const processes = await provider.processList();
          hasActiveProcesses = processes.some((p) => p.running);
        } catch {
          // Ignore — process listing is best-effort
        }
      }
      const timeoutSeconds = hasActiveProcesses ? config.activeTimeout : config.idleTimeout;
      await resetDeElevationTimer(provider, config, context, timeoutSeconds);

      // Broadcast updated timeout
      context.broadcast("sandbox_timeout", {
        expiresAt: Date.now() + timeoutSeconds * 1000,
        timeoutSeconds,
      });

      // Trigger persist sync on install commands (dev mode)
      if (result.exitCode === 0 && isInstallCommand(args.command) && provider.triggerSync) {
        provider.triggerSync().catch(() => {});
      }

      // Format output
      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
      if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);

      const text = parts.length > 0 ? parts.join("\n") : "(no output)";

      return {
        content: [{ type: "text" as const, text }],
        details: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    },
  });
}
