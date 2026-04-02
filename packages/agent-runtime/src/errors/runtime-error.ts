import type { ErrorCode } from "../transport/error-codes.js";
import { ErrorCodes } from "../transport/error-codes.js";

/**
 * Discriminated union of all typed runtime error variants.
 */
export type RuntimeErrorType =
  | "session_not_found"
  | "tool_not_found"
  | "tool_execution_failed"
  | "tool_timeout"
  | "agent_busy"
  | "compaction_overflow"
  | "doom_loop_detected";

/**
 * Map from RuntimeErrorType to transport ErrorCode.
 */
const ERROR_TYPE_TO_CODE: Record<RuntimeErrorType, ErrorCode> = {
  session_not_found: ErrorCodes.SESSION_NOT_FOUND,
  tool_not_found: ErrorCodes.TOOL_ERROR,
  tool_execution_failed: ErrorCodes.TOOL_ERROR,
  tool_timeout: ErrorCodes.TOOL_ERROR,
  agent_busy: ErrorCodes.AGENT_BUSY,
  compaction_overflow: ErrorCodes.INTERNAL_ERROR,
  doom_loop_detected: ErrorCodes.TOOL_ERROR,
};

/**
 * Typed runtime error with a discriminant `type` field.
 *
 * Extends Error so it works with existing catch blocks,
 * but provides a `type` discriminant for exhaustive switch handling.
 *
 * @example
 * ```ts
 * try {
 *   await agent.prompt("hello");
 * } catch (e) {
 *   if (isRuntimeError(e)) {
 *     switch (e.type) {
 *       case "agent_busy": // handle...
 *       case "session_not_found": // handle...
 *     }
 *   }
 * }
 * ```
 */
export class RuntimeError extends Error {
  readonly type: RuntimeErrorType;
  readonly errorCode: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    type: RuntimeErrorType,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RuntimeError";
    this.type = type;
    this.errorCode = ERROR_TYPE_TO_CODE[type];
    this.details = details;
  }
}

/**
 * Type guard for RuntimeError instances.
 */
export function isRuntimeError(value: unknown): value is RuntimeError {
  return value instanceof RuntimeError;
}

// --- Factory functions for each error variant ---

export function sessionNotFound(sessionId: string): RuntimeError {
  return new RuntimeError("session_not_found", `Session not found: ${sessionId}`, { sessionId });
}

export function toolNotFound(toolName: string, available: string[]): RuntimeError {
  return new RuntimeError("tool_not_found", `Tool '${toolName}' not found`, {
    toolName,
    available,
  });
}

export function toolExecutionFailed(toolName: string, cause: unknown): RuntimeError {
  return new RuntimeError(
    "tool_execution_failed",
    `Tool '${toolName}' execution failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    { toolName, cause: cause instanceof Error ? cause.message : String(cause) },
  );
}

export function toolTimeout(toolName: string, timeoutMs: number): RuntimeError {
  return new RuntimeError("tool_timeout", `Tool '${toolName}' timed out after ${timeoutMs}ms`, {
    toolName,
    timeoutMs,
  });
}

export function agentBusy(sessionId: string): RuntimeError {
  return new RuntimeError("agent_busy", "Agent is busy — message will be injected as a steer", {
    sessionId,
  });
}

export function compactionOverflow(sessionId: string): RuntimeError {
  return new RuntimeError("compaction_overflow", `Compaction overflow in session ${sessionId}`, {
    sessionId,
  });
}

export function doomLoopDetected(toolName: string, count: number): RuntimeError {
  return new RuntimeError(
    "doom_loop_detected",
    `Doom loop detected: '${toolName}' called ${count} times with identical arguments`,
    { toolName, count },
  );
}
