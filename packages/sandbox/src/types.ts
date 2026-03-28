/** Result of executing a command in the sandbox. */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Information about a managed long-running process. */
export interface ProcessInfo {
  name: string;
  pid?: number;
  running: boolean;
  command: string;
  exitCode?: number;
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
  exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<SandboxExecResult>;

  // --- Optional process management ---

  /** Start a named long-running process. */
  processStart?(name: string, command: string, cwd?: string): Promise<{ pid?: number }>;
  /** Stop a named process. */
  processStop?(name: string): Promise<void>;
  /** List managed processes and their status. */
  processList?(): Promise<ProcessInfo[]>;

  /** Trigger a persist volume backup (dev mode). */
  triggerSync?(): Promise<void>;
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
