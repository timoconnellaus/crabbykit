/**
 * Shared types for the sandbox container server.
 */
import type { ChildProcess } from "node:child_process";
import type fs from "node:fs";
import type * as pty from "node-pty";

export interface BufferEntry {
  seq: number;
  type: "stdout" | "stderr";
  data: string;
}

export interface ManagedProcess {
  pid: number;
  command: string;
  name: string;
  startedAt: number;
  exitCode: number | null;
  running: boolean;
  buffer: BufferEntry[];
  bufferSeq: number;
  proc: ChildProcess;
  gcTimer?: ReturnType<typeof setTimeout>;
}

export interface Session {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number;
  running: boolean;
  exitCode: number | null;
  // Output management
  output: string;
  pendingBuffer: string;
  outputBytes: number;
  truncated: boolean;
  // File logging
  logFile: string;
  logStream: fs.WriteStream;
  // Poll backoff
  lastPollAt: number;
  consecutiveEmptyPolls: number;
  // Process handle
  proc: pty.IPty;
  gcTimer?: ReturnType<typeof setTimeout>;
}
