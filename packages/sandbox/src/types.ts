/** Result of executing a command in the sandbox. */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A single event from a streaming exec. */
export type ExecStreamEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number };

/** Information about a managed long-running process. */
export interface ProcessInfo {
  name: string;
  pid?: number;
  running: boolean;
  command: string;
  exitCode?: number;
}

/** Summary of a session-tracked command execution. */
export interface SessionInfo {
  sessionId: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  pid: number;
  startedAt: number;
  logFile: string;
  outputBytes: number;
}

/** Result of polling a session for output. */
export interface SessionPollResult {
  sessionId: string;
  running: boolean;
  exitCode: number | null;
  pending: string;
  tail: string;
  logFile: string;
  retryAfterMs: number;
  outputBytes: number;
  truncated: boolean;
}

/**
 * Abstraction over a sandbox execution environment.
 * Consumers implement this to connect to their compute backend
 * (Cloudflare Containers, Docker, SSH, Lambda, etc.).
 */
export interface SandboxProvider {
  /** Start the sandbox environment. Called by the `elevate` tool. */
  start(options?: { envVars?: Record<string, string> }): Promise<void>;
  /** Stop the sandbox environment. Called by `de_elevate` and auto-de-elevation. */
  stop(): Promise<void>;
  /** Check if the sandbox is ready. */
  health(): Promise<{ ready: boolean; [key: string]: unknown }>;
  /** Execute a shell command and return the result. */
  exec(
    command: string,
    options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult>;

  // --- Optional process management ---

  /** Start a named long-running process. */
  processStart?(name: string, command: string, cwd?: string): Promise<{ pid?: number }>;
  /** Stop a named process. */
  processStop?(name: string): Promise<void>;
  /** List managed processes and their status. */
  processList?(): Promise<ProcessInfo[]>;

  /** Execute a command and stream stdout/stderr chunks as they arrive. */
  execStream?(
    command: string,
    options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
  ): AsyncIterable<ExecStreamEvent>;

  /** Trigger a persist volume backup (dev mode). */
  triggerSync?(): Promise<void>;

  // --- Optional session-based execution ---

  /** Execute a command with session tracking, streaming output as SSE. First event contains sessionId. */
  sessionExecStream?(
    command: string,
    options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
  ): AsyncIterable<ExecStreamEvent & { sessionId?: string; logFile?: string }>;
  /** Start a backgrounded command with session tracking. */
  sessionStart?(
    command: string,
    options?: { timeout?: number; cwd?: string },
  ): Promise<{ sessionId: string; pid: number; logFile: string }>;
  /** Poll a session for pending output and status. */
  sessionPoll?(sessionId: string): Promise<SessionPollResult>;
  /** Write input to a running session's stdin. */
  sessionWrite?(sessionId: string, input: string): Promise<void>;
  /** Kill a running session. */
  sessionKill?(sessionId: string): Promise<void>;
  /** Remove a finished session and its log file. */
  sessionRemove?(sessionId: string): Promise<void>;
  /** List all sessions. */
  sessionList?(): Promise<SessionInfo[]>;
  /** Read session log file contents. */
  sessionLog?(sessionId: string, tail?: number): Promise<string>;

  // --- Optional dev server management ---

  /** Set the port of a dev server to proxy traffic to. basePath is the preview URL prefix for path rewriting. */
  setDevPort?(port: number, basePath?: string): Promise<void>;
  /** Clear the dev server port (stop proxying). */
  clearDevPort?(): Promise<void>;
}

/** Configuration for the sandbox capability. */
export interface SandboxConfig {
  /** Seconds before auto-de-elevation when idle (default 180). */
  idleTimeout?: number;
  /** Seconds before auto-de-elevation with active processes (default 900). */
  activeTimeout?: number;
  /** Default working directory for exec (default "/mnt/r2"). */
  defaultCwd?: string;
  /** Default exec timeout in milliseconds (default 60000). */
  defaultExecTimeout?: number;
}

/** Internal elevation state persisted in capability storage. */
export interface SandboxState {
  elevated: boolean;
  elevationReason?: string;
  elevatedAt?: string;
}
