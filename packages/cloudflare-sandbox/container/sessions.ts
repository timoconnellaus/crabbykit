/**
 * Session lifecycle: create, cleanup, output management, exec.
 */
import fs from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import { LOG_DIR, MAX_OUTPUT_CHARS, POLL_BACKOFF_SCHEDULE, SESSION_GC_DELAY } from "./constants.ts";
import { buildSanitizedEnv, stripAnsi } from "./helpers.ts";
import { logDirCreated, sessions, setLogDirCreated } from "./state.ts";
import type { Session } from "./types.ts";

function ensureLogDir(): void {
  if (!logDirCreated) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    setLogDirCreated(true);
  }
}

function generateSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getBackoffMs(consecutiveEmptyPolls: number): number {
  const idx = Math.min(consecutiveEmptyPolls, POLL_BACKOFF_SCHEDULE.length - 1);
  return POLL_BACKOFF_SCHEDULE[idx] ?? 60_000;
}

export function appendSessionOutput(session: Session, data: string): void {
  session.pendingBuffer += data;
  session.output += data;
  session.outputBytes += data.length;

  // Cap in-memory output at MAX_OUTPUT_CHARS — drop first half when exceeded
  if (session.output.length > MAX_OUTPUT_CHARS) {
    session.output = session.output.slice(session.output.length - Math.floor(MAX_OUTPUT_CHARS / 2));
    session.truncated = true;
  }

  // Write to log file (unbounded on disk)
  session.logStream.write(data);
}

export function markSessionExited(session: Session, exitCode: number | null): void {
  session.running = false;
  session.exitCode = exitCode;

  // Close log stream
  session.logStream.end();

  // GC after SESSION_GC_DELAY if not polled
  session.gcTimer = setTimeout(() => {
    cleanupSession(session.id);
  }, SESSION_GC_DELAY);
}

export function cleanupSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.gcTimer) clearTimeout(session.gcTimer);

  // Delete log file
  try {
    fs.unlinkSync(session.logFile);
  } catch {
    // Best-effort
  }

  sessions.delete(sessionId);
}

export function createSession(command: string, cwd: string): Session {
  ensureLogDir();
  const id = generateSessionId();
  const logFile = path.join(LOG_DIR, `${id}.log`);

  const proc = pty.spawn("/bin/sh", ["-c", command], {
    cwd,
    env: buildSanitizedEnv(),
    cols: 120,
    rows: 40,
  });

  const session: Session = {
    id,
    command,
    cwd,
    startedAt: Date.now(),
    pid: proc.pid,
    running: true,
    exitCode: null,
    output: "",
    pendingBuffer: "",
    outputBytes: 0,
    truncated: false,
    logFile,
    logStream: fs.createWriteStream(logFile, { flags: "a" }),
    lastPollAt: 0,
    consecutiveEmptyPolls: 0,
    proc,
  };

  sessions.set(id, session);

  // Capture output
  proc.onData((data) => {
    const cleaned = stripAnsi(data);
    appendSessionOutput(session, cleaned);
  });

  proc.onExit(({ exitCode }) => {
    markSessionExited(session, exitCode ?? 1);
  });

  return session;
}

export function sessionTail(session: Session, chars = 2000): string {
  if (session.output.length <= chars) return session.output;
  return session.output.slice(-chars);
}

export function execCommand(
  command: string,
  timeout: number,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = pty.spawn("/bin/sh", ["-c", command], {
      cwd,
      env: buildSanitizedEnv(),
      cols: 120,
      rows: 40,
    });

    let output = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, timeout);

    proc.onData((data) => {
      output += data;
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      const cleaned = stripAnsi(output);
      if (killed) {
        resolve({
          stdout: cleaned,
          stderr: `\nProcess exceeded ${timeout}ms timeout and was killed.`,
          exitCode: exitCode ?? 137,
        });
      } else {
        // PTY merges stdout/stderr — return all output as stdout
        resolve({ stdout: cleaned, stderr: "", exitCode: exitCode ?? 1 });
      }
    });
  });
}
