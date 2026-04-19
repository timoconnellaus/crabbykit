import type { AgentContext, ToolExecuteContext } from "@crabbykit/agent-runtime";
import { defineTool, Type } from "@crabbykit/agent-runtime";
import { checkElevation } from "../elevation.js";
import { setProcessOwner } from "../session-state.js";
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

const INITIAL_POLL_DELAY = 500;

export function createExecTool(
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "exec",
    description:
      "Execute a shell command in the sandbox. All output is logged to a file in the container. " +
      "Set background=true for long-running commands — use the process tool to poll, write, or kill them.",
    guidance:
      "Execute a shell command in the sandbox. All output is logged to a file in the container for later inspection. For long-running commands (dev servers, watchers, builds), set background=true to get a session ID, then use the process tool to manage it. Never use exec for interactive programs like vim or less.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      background: Type.Optional(
        Type.Boolean({
          description: "Run in background and return immediately with a session ID (default false)",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (foreground only)",
          minimum: 1000,
        }),
      ),
    }),
    execute: async (args, execCtx) => {
      const notElevated = await checkElevation(context.storage, context.sessionId, provider);
      if (notElevated) return notElevated;

      if (args.background) {
        return executeBackground(args.command, provider, config, context);
      }
      return executeForeground(args.command, args.timeout, provider, config, context, execCtx);
    },
  });
}

async function executeForeground(
  command: string,
  timeout: number | undefined,
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
  execCtx?: ToolExecuteContext,
) {
  const effectiveTimeout = timeout ?? config.defaultExecTimeout;
  const execOpts = { timeout: effectiveTimeout, cwd: config.defaultCwd, signal: execCtx?.signal };

  let result: { stdout: string; stderr: string; exitCode: number };
  let sessionId: string | undefined;
  let logFile: string | undefined;

  // Prefer session-based streaming (tracks output in log files)
  if (provider.sessionExecStream && execCtx?.onUpdate) {
    let stdout = "";
    let stderr = "";
    let exitCode = 1;

    for await (const event of provider.sessionExecStream(command, execOpts)) {
      if ("sessionId" in event && event.sessionId) {
        sessionId = event.sessionId;
        logFile = event.logFile;
        continue;
      }
      if (event.type === "stdout") {
        stdout += event.data;
        execCtx.onUpdate({
          content: [
            {
              type: "text" as const,
              text: stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout,
            },
          ],
          details: { exitCode: null, stdout, stderr, sessionId, logFile },
        });
      } else if (event.type === "stderr") {
        stderr += event.data;
        execCtx.onUpdate({
          content: [{ type: "text" as const, text: `${stdout || ""}\n[stderr]\n${stderr}` }],
          details: { exitCode: null, stdout, stderr, sessionId, logFile },
        });
      } else if (event.type === "exit") {
        exitCode = event.code;
      }
    }

    result = { stdout, stderr, exitCode };
  } else if (provider.execStream && execCtx?.onUpdate) {
    // Fallback: non-session streaming
    let stdout = "";
    let stderr = "";
    let exitCode = 1;

    for await (const event of provider.execStream(command, execOpts)) {
      if (event.type === "stdout") {
        stdout += event.data;
        execCtx.onUpdate({
          content: [
            {
              type: "text" as const,
              text: stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout,
            },
          ],
          details: { exitCode: null, stdout, stderr },
        });
      } else if (event.type === "stderr") {
        stderr += event.data;
        execCtx.onUpdate({
          content: [{ type: "text" as const, text: `${stdout || ""}\n[stderr]\n${stderr}` }],
          details: { exitCode: null, stdout, stderr },
        });
      } else if (event.type === "exit") {
        exitCode = event.code;
      }
    }

    result = { stdout, stderr, exitCode };
  } else {
    result = await provider.exec(command, execOpts);
  }

  // Reset de-elevation timer
  await resetTimer(provider, config, context);

  // Trigger persist sync on install commands (dev mode)
  if (result.exitCode === 0 && isInstallCommand(command) && provider.triggerSync) {
    provider.triggerSync().catch(() => {});
  }

  // Format output
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
  if (logFile) parts.push(`[output logged to ${logFile}]`);

  const text = parts.length > 0 ? parts.join("\n") : "(no output)";

  return {
    content: [{ type: "text" as const, text }],
    details: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      sessionId,
      logFile,
    },
  };
}

async function executeBackground(
  command: string,
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
) {
  if (!provider.sessionStart) {
    return "Background execution not supported by this sandbox provider.";
  }

  const { sessionId, pid, logFile } = await provider.sessionStart(command, {
    cwd: config.defaultCwd,
  });

  // Record which agent session owns this container process
  if (context.storage) {
    await setProcessOwner(context.storage, sessionId, context.sessionId);
  }

  // Brief delay to capture initial output
  await new Promise((resolve) => setTimeout(resolve, INITIAL_POLL_DELAY));

  let tail = "";
  if (provider.sessionPoll) {
    try {
      const poll = await provider.sessionPoll(sessionId);
      tail = poll.pending || poll.tail;
    } catch {
      // Best-effort initial poll
    }
  }

  // Use active timeout since we have a running process
  await resetTimer(provider, config, context, config.activeTimeout);

  const parts = [
    `Command backgrounded as session ${sessionId} (PID ${pid}).`,
    ...(tail ? [tail] : []),
    `[logging to ${logFile}]`,
    "Use the process tool to poll, write, or kill this session.",
  ];

  return {
    content: [{ type: "text" as const, text: parts.join("\n") }],
    details: { sessionId, pid, logFile, tail },
  };
}

async function resetTimer(
  provider: SandboxProvider,
  config: Required<SandboxConfig>,
  context: AgentContext,
  forceTimeout?: number,
): Promise<void> {
  let timeoutSeconds = forceTimeout ?? config.idleTimeout;

  if (!forceTimeout) {
    // Check for active processes/sessions
    let hasActive = false;
    if (provider.sessionList) {
      try {
        const sessionsList = await provider.sessionList();
        hasActive = sessionsList.some((s) => s.running);
      } catch {
        // Best-effort
      }
    }
    if (!hasActive && provider.processList) {
      try {
        const processes = await provider.processList();
        hasActive = processes.some((p) => p.running);
      } catch {
        // Best-effort
      }
    }
    if (hasActive) {
      timeoutSeconds = config.activeTimeout;
    }
  }

  await resetDeElevationTimer(config, context, timeoutSeconds);

  context.broadcast("sandbox_timeout", {
    expiresAt: Date.now() + timeoutSeconds * 1000,
    timeoutSeconds,
  });
}
