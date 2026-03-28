/**
 * Sandbox HTTP server — runs inside the container on port 8080.
 * Provides command execution, process management, and health endpoints
 * that CloudflareSandboxProvider proxies to.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// --- Constants ---

const PORT = 8080;
const DEFAULT_EXEC_TIMEOUT = 60_000;
const MAX_BUFFER = 10_000;
const PROCESS_GC_DELAY = 60_000;
const IDLE_TIMEOUT_NORMAL = 10 * 60_000;
const IDLE_TIMEOUT_DEV = 30 * 60_000;
const IDLE_CHECK_INTERVAL = 60_000;
const SYNC_DEBOUNCE_MS = 30_000;
const SYNC_SOCKET = "/var/run/sync.sock";

const SENSITIVE_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "ENCRYPTION_KEY",
];

// --- State ---

let workspacePath = process.env.AGENT_ID ? "/mnt/r2" : "";
let injectedEnv: Record<string, string> = {};
let lastActivityAt = Date.now();
let containerMode = process.env.CONTAINER_MODE ?? "normal";
let lastSyncAt = 0;
const cleanupPrefixes: string[] = [];

interface BufferEntry {
  seq: number;
  type: "stdout" | "stderr";
  data: string;
}

interface ManagedProcess {
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

const processes = new Map<string, ManagedProcess>();

// --- Helpers ---

function touchActivity() {
  lastActivityAt = Date.now();
}

function buildSanitizedEnv(): Record<string, string> {
  const env = { ...process.env, ...injectedEnv } as Record<string, string>;
  for (const key of SENSITIVE_KEYS) {
    delete env[key];
  }
  return env;
}

function isUnderWorkspace(targetPath: string): boolean {
  if (!workspacePath) return false;
  const resolved = path.resolve(targetPath);
  try {
    const real = fs.realpathSync(resolved);
    return real === workspacePath || real.startsWith(workspacePath + "/");
  } catch {
    return resolved === workspacePath || resolved.startsWith(workspacePath + "/");
  }
}

function isUnderPersist(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved === "/opt/gia/persist" || resolved.startsWith("/opt/gia/persist/");
}

function isAllowedPath(targetPath: string): boolean {
  return isUnderWorkspace(targetPath) || isUnderPersist(targetPath);
}

function execCommand(
  command: string,
  timeout: number,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const effectiveCwd = cwd && isAllowedPath(cwd) ? cwd : workspacePath || "/tmp";

    const proc = spawn("/bin/sh", ["-c", command], {
      cwd: effectiveCwd,
      env: buildSanitizedEnv(),
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, timeout);

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        stderr += `\nProcess exceeded ${timeout}ms timeout and was killed.`;
      }
      resolve({ stdout, stderr, exitCode: code ?? (killed ? 137 : 1) });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

// --- Request handling ---

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  touchActivity();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";

  // --- Health ---
  if (url.pathname === "/health" && method === "GET") {
    const prefixes = cleanupPrefixes.splice(0);
    json(res, {
      ready: true,
      workspace: workspacePath,
      processes: processes.size,
      ...(prefixes.length > 0 ? { cleanupPrefixes: prefixes } : {}),
    });
    return;
  }

  // --- Init ---
  if (url.pathname === "/init" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    if (body.workspace) {
      workspacePath = body.workspace;
      fs.mkdirSync(workspacePath, { recursive: true });
    }
    if (body.envVars) {
      injectedEnv = { ...injectedEnv, ...body.envVars };
    }
    json(res, { ok: true, workspace: workspacePath });
    return;
  }

  // --- Exec ---
  if (url.pathname === "/exec" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const command = body.command as string;
    if (!command) {
      error(res, "Missing command");
      return;
    }
    const timeout = (body.timeout as number) ?? DEFAULT_EXEC_TIMEOUT;
    const cwd = body.cwd as string | undefined;

    const result = await execCommand(command, timeout, cwd);
    json(res, result);
    return;
  }

  // --- Stop ---
  if (url.pathname === "/stop" && method === "POST") {
    // Stop all managed processes
    for (const [, managed] of processes) {
      if (managed.running) {
        managed.proc.kill("SIGTERM");
      }
    }
    json(res, { ok: true });
    // Graceful exit after response
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // --- Process Start ---
  if (url.pathname === "/process-start" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const name = body.name as string;
    const command = body.command as string;
    const cwd = body.cwd as string | undefined;

    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      error(res, "Invalid process name");
      return;
    }
    if (!command) {
      error(res, "Missing command");
      return;
    }

    const existing = processes.get(name);
    if (existing?.running) {
      error(res, `Process "${name}" is already running`, 409);
      return;
    }

    const effectiveCwd = cwd && isAllowedPath(cwd) ? cwd : workspacePath || "/tmp";
    const proc = spawn("/bin/sh", ["-c", command], {
      cwd: effectiveCwd,
      env: buildSanitizedEnv(),
    });

    const managed: ManagedProcess = {
      pid: proc.pid ?? 0,
      command,
      name,
      startedAt: Date.now(),
      exitCode: null,
      running: true,
      buffer: [],
      bufferSeq: 0,
      proc,
    };

    // Clear GC timer from previous dead process
    if (existing?.gcTimer) clearTimeout(existing.gcTimer);

    processes.set(name, managed);

    proc.stdout?.on("data", (data: Buffer) => {
      const entry: BufferEntry = {
        seq: ++managed.bufferSeq,
        type: "stdout",
        data: data.toString(),
      };
      managed.buffer.push(entry);
      if (managed.buffer.length > MAX_BUFFER) managed.buffer.shift();
      // Notify SSE subscribers
      for (const sub of (managed as any).subscribers ?? []) sub.onData(entry);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const entry: BufferEntry = {
        seq: ++managed.bufferSeq,
        type: "stderr",
        data: data.toString(),
      };
      managed.buffer.push(entry);
      if (managed.buffer.length > MAX_BUFFER) managed.buffer.shift();
      for (const sub of (managed as any).subscribers ?? []) sub.onData(entry);
    });

    proc.on("close", (code) => {
      managed.running = false;
      managed.exitCode = code ?? 1;
      // Notify SSE subscribers of exit
      for (const sub of (managed as any).subscribers ?? []) sub.onExit(code);
      (managed as any).subscribers = [];
      managed.gcTimer = setTimeout(() => {
        if (processes.get(name) === managed) processes.delete(name);
      }, PROCESS_GC_DELAY);
    });

    json(res, { pid: managed.pid, name });
    return;
  }

  // --- Process Stop ---
  if (url.pathname === "/process-stop" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const name = body.name as string;

    const managed = processes.get(name);
    if (!managed) {
      error(res, `Process "${name}" not found`, 404);
      return;
    }
    if (!managed.running) {
      json(res, { ok: true, alreadyStopped: true });
      return;
    }

    managed.proc.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (managed.running) managed.proc.kill("SIGKILL");
    }, 5000);

    managed.proc.on("close", () => clearTimeout(killTimer));
    json(res, { ok: true });
    return;
  }

  // --- Process List ---
  if (url.pathname === "/process-list" && method === "GET") {
    const list = Array.from(processes.values()).map((p) => ({
      name: p.name,
      command: p.command,
      pid: p.pid,
      running: p.running,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
    }));
    json(res, list);
    return;
  }

  // --- Process Stream (SSE) ---
  if (url.pathname.startsWith("/process-stream/") && method === "GET") {
    const name = url.pathname.slice("/process-stream/".length);
    const afterSeq = Number.parseInt(url.searchParams.get("afterSeq") ?? "0", 10);
    const managed = processes.get(name);

    if (!managed) {
      error(res, `Process "${name}" not found`, 404);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // Backfill from ring buffer
    for (const entry of managed.buffer) {
      if (entry.seq > afterSeq) {
        res.write(`data: ${JSON.stringify({ type: entry.type, data: entry.data, seq: entry.seq })}\n\n`);
      }
    }

    // If already exited, send exit event and close
    if (!managed.running) {
      res.write(`data: ${JSON.stringify({ type: "exit", code: managed.exitCode })}\n\n`);
      res.end();
      return;
    }

    // Subscribe to live events
    const onData = (entry: BufferEntry) => {
      try {
        res.write(`data: ${JSON.stringify({ type: entry.type, data: entry.data, seq: entry.seq })}\n\n`);
      } catch {
        cleanup();
      }
    };

    const onExit = (code: number | null) => {
      try {
        res.write(`data: ${JSON.stringify({ type: "exit", code })}\n\n`);
        res.end();
      } catch {
        // Already closed
      }
    };

    // Add subscriber callbacks to the managed process
    if (!managed.subscribers) {
      (managed as any).subscribers = [];
    }
    (managed as any).subscribers.push({ onData, onExit });

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`);
      } catch {
        cleanup();
      }
    }, 5000);

    const cleanup = () => {
      clearInterval(heartbeat);
      const subs = (managed as any).subscribers;
      if (subs) {
        const idx = subs.findIndex((s: any) => s.onData === onData);
        if (idx >= 0) subs.splice(idx, 1);
      }
    };

    req.on("close", cleanup);
    return;
  }

  // --- nm-guard cleanup notification ---
  if (url.pathname === "/internal/cleanup-r2" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    if (body.prefix) {
      cleanupPrefixes.push(body.prefix);
    }
    json(res, { ok: true });
    return;
  }

  // --- Dev mode: trigger persist sync (debounced) ---
  if (url.pathname === "/trigger-sync" && method === "POST") {
    if (containerMode !== "dev") {
      error(res, "Not in dev mode", 400);
      return;
    }
    const now = Date.now();
    if (now - lastSyncAt < SYNC_DEBOUNCE_MS) {
      json(res, { ok: true, debounced: true });
      return;
    }
    lastSyncAt = now;
    // Fire-and-forget backup via sync daemon
    triggerResticBackup().catch(() => {});
    json(res, { ok: true });
    return;
  }

  // --- Mode switch ---
  if (url.pathname === "/mode" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    if (body.mode === "dev" || body.mode === "normal") {
      containerMode = body.mode;
      json(res, { ok: true, mode: containerMode });
    } else {
      error(res, "Invalid mode — must be 'dev' or 'normal'");
    }
    return;
  }

  // --- Not found ---
  error(res, "Not found", 404);
}

// --- Server ---

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[sandbox] Unhandled error:", err);
    if (!res.headersSent) {
      error(res, "Internal server error", 500);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[sandbox] Server listening on port ${PORT}`);
  if (workspacePath) console.log(`[sandbox] Workspace: ${workspacePath}`);
});

// --- Restic sync helper ---

async function triggerResticBackup(): Promise<void> {
  const { execSync } = await import("node:child_process");
  try {
    execSync(
      `curl -s --unix-socket ${SYNC_SOCKET} http://localhost/backup -X POST`,
      { timeout: 120_000 },
    );
  } catch (err) {
    console.error("[sandbox] Restic backup failed:", err);
  }
}

async function gracefulShutdown(): Promise<void> {
  // Stop all managed processes
  for (const [, managed] of processes) {
    if (managed.running) managed.proc.kill("SIGTERM");
  }

  // Final backup in dev mode
  if (containerMode === "dev") {
    console.log("[sandbox] Dev mode — running final backup before shutdown");
    await triggerResticBackup().catch(() => {});
  }

  clearInterval(idleCheck);
  server.close(() => process.exit(0));
}

// --- Idle timeout ---

const idleTimeout = containerMode === "dev" ? IDLE_TIMEOUT_DEV : IDLE_TIMEOUT_NORMAL;

const idleCheck = setInterval(() => {
  const hasRunning = Array.from(processes.values()).some((p) => p.running);
  if (hasRunning) {
    lastActivityAt = Date.now();
    return;
  }

  const timeout = containerMode === "dev" ? IDLE_TIMEOUT_DEV : IDLE_TIMEOUT_NORMAL;
  if (Date.now() - lastActivityAt > timeout) {
    console.log("[sandbox] Idle timeout reached, shutting down");
    gracefulShutdown();
  }
}, IDLE_CHECK_INTERVAL);

// --- Graceful shutdown ---

process.on("SIGTERM", () => {
  console.log("[sandbox] SIGTERM received, shutting down");
  gracefulShutdown();
});
