import type { AgentContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { checkElevation } from "../elevation.js";
import { getOwnedProcessIds, getProcessOwner, removeProcessOwner } from "../session-state.js";
import type { SandboxConfig, SandboxProvider } from "../types.js";

export function createProcessTool(
  provider: SandboxProvider,
  _config: Required<SandboxConfig>,
  context: AgentContext,
) {
  return defineTool({
    name: "process",
    description:
      "Manage backgrounded command sessions. Use after exec with background=true. " +
      "Actions: list (show all sessions), poll (check output), log (read log file), " +
      "write (send stdin input), kill (terminate), remove (clean up finished session).",
    guidance:
      "Manage backgrounded command sessions started with exec background=true. Use poll to check for new output, log to read the full log file, write to send stdin input, kill to terminate, and remove to clean up finished sessions. Always poll or check logs before assuming a background command has failed.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("poll"),
          Type.Literal("log"),
          Type.Literal("write"),
          Type.Literal("kill"),
          Type.Literal("remove"),
        ],
        { description: "Action to perform" },
      ),
      sessionId: Type.Optional(
        Type.String({ description: "Session ID (required for all actions except list)" }),
      ),
      input: Type.Optional(
        Type.String({ description: "Input to write to stdin (for write action)" }),
      ),
      tail: Type.Optional(
        Type.Number({ description: "Number of lines to return from log file (for log action)" }),
      ),
    }),
    execute: async (args) => {
      const notElevated = await checkElevation(context.storage, context.sessionId, provider);
      if (notElevated) return notElevated;

      // checkElevation above throws if storage is undefined
      const storage = context.storage as NonNullable<typeof context.storage>;

      switch (args.action) {
        case "list":
          return actionList(provider, storage, context.sessionId);
        case "poll":
          return actionPoll(provider, storage, context.sessionId, requireSessionId(args.sessionId));
        case "log":
          return actionLog(
            provider,
            storage,
            context.sessionId,
            requireSessionId(args.sessionId),
            args.tail,
          );
        case "write":
          return actionWrite(
            provider,
            storage,
            context.sessionId,
            requireSessionId(args.sessionId),
            args.input,
          );
        case "kill":
          return actionKill(provider, storage, context.sessionId, requireSessionId(args.sessionId));
        case "remove":
          return actionRemove(
            provider,
            storage,
            context.sessionId,
            requireSessionId(args.sessionId),
          );
        default:
          return textResult(`Unknown action: ${args.action}`);
      }
    },
  });
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw new Error("sessionId is required for this action");
  return sessionId;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

const NOT_OWNED_RESULT = textResult("Session not found or not owned by this session.", {
  error: "not_owned",
});

async function checkOwnership(
  storage: CapabilityStorage,
  agentSessionId: string,
  containerSessionId: string,
): Promise<boolean> {
  const owner = await getProcessOwner(storage, containerSessionId);
  return owner === agentSessionId;
}

async function actionList(
  provider: SandboxProvider,
  storage: CapabilityStorage,
  agentSessionId: string,
) {
  if (!provider.sessionList) {
    return textResult("Session listing not supported by this sandbox provider.");
  }

  // Get the set of container session IDs owned by this agent session
  const ownedIds = new Set(await getOwnedProcessIds(storage, agentSessionId));

  const sessionsList = await provider.sessionList();
  const owned = sessionsList.filter((s) => ownedIds.has(s.sessionId));

  if (owned.length === 0) {
    return textResult("No active sessions.");
  }

  const lines = owned.map((s) => {
    const status = s.running ? "running" : `exited (code ${s.exitCode ?? "unknown"})`;
    const age = Math.round((Date.now() - s.startedAt) / 1000);
    return `${s.sessionId}: ${status} — ${s.command} (${age}s, ${s.outputBytes} bytes logged to ${s.logFile})`;
  });

  return textResult(lines.join("\n"), { sessions: owned });
}

async function actionPoll(
  provider: SandboxProvider,
  storage: CapabilityStorage,
  agentSessionId: string,
  sessionId: string,
) {
  if (!provider.sessionPoll) {
    return textResult("Session polling not supported by this sandbox provider.");
  }

  if (!(await checkOwnership(storage, agentSessionId, sessionId))) {
    return NOT_OWNED_RESULT;
  }

  const poll = await provider.sessionPoll(sessionId);

  const parts: string[] = [];
  if (poll.pending) {
    parts.push(poll.pending);
  } else {
    parts.push("(no new output)");
  }

  const status = poll.running ? "running" : `exited (code ${poll.exitCode})`;
  parts.push(`[session ${sessionId}: ${status}, ${poll.outputBytes} bytes total]`);
  parts.push(`[log: ${poll.logFile}]`);

  if (poll.running) {
    parts.push(`[retry in ${Math.round(poll.retryAfterMs / 1000)}s]`);
  }

  if (poll.truncated) {
    parts.push("[in-memory output truncated — full output in log file]");
  }

  return textResult(parts.join("\n"), {
    sessionId: poll.sessionId,
    running: poll.running,
    exitCode: poll.exitCode,
    retryAfterMs: poll.retryAfterMs,
    outputBytes: poll.outputBytes,
    logFile: poll.logFile,
  });
}

async function actionLog(
  provider: SandboxProvider,
  storage: CapabilityStorage,
  agentSessionId: string,
  sessionId: string,
  tail?: number,
) {
  if (!provider.sessionLog) {
    return textResult("Session log reading not supported by this sandbox provider.");
  }

  if (!(await checkOwnership(storage, agentSessionId, sessionId))) {
    return NOT_OWNED_RESULT;
  }

  const content = await provider.sessionLog(sessionId, tail);

  if (!content) {
    return textResult("(log file is empty)");
  }

  return textResult(content, { sessionId });
}

async function actionWrite(
  provider: SandboxProvider,
  storage: CapabilityStorage,
  agentSessionId: string,
  sessionId: string,
  input?: string,
) {
  if (!provider.sessionWrite) {
    return textResult("Session writing not supported by this sandbox provider.");
  }

  if (!(await checkOwnership(storage, agentSessionId, sessionId))) {
    return NOT_OWNED_RESULT;
  }

  if (!input) {
    return textResult("No input provided. Use the input parameter to send data to stdin.");
  }

  await provider.sessionWrite(sessionId, input);
  return textResult(`Wrote ${input.length} bytes to session ${sessionId}.`, { sessionId });
}

async function actionKill(
  provider: SandboxProvider,
  storage: CapabilityStorage,
  agentSessionId: string,
  sessionId: string,
) {
  if (!provider.sessionKill) {
    return textResult("Session killing not supported by this sandbox provider.");
  }

  if (!(await checkOwnership(storage, agentSessionId, sessionId))) {
    return NOT_OWNED_RESULT;
  }

  await provider.sessionKill(sessionId);
  return textResult(`Session ${sessionId} kill requested.`, { sessionId });
}

async function actionRemove(
  provider: SandboxProvider,
  storage: CapabilityStorage,
  agentSessionId: string,
  sessionId: string,
) {
  if (!provider.sessionRemove) {
    return textResult("Session removal not supported by this sandbox provider.");
  }

  if (!(await checkOwnership(storage, agentSessionId, sessionId))) {
    return NOT_OWNED_RESULT;
  }

  await provider.sessionRemove(sessionId);
  await removeProcessOwner(storage, sessionId);
  return textResult(`Session ${sessionId} removed (log file deleted).`, { sessionId });
}
