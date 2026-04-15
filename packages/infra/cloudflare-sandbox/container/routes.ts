/**
 * HTTP request handler — all route logic for the sandbox container server.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import * as pty from "node-pty";
import {
  DEFAULT_EXEC_TIMEOUT,
  MAX_BUFFER,
  PORT,
  PROCESS_GC_DELAY,
  SESSION_GC_DELAY,
  SYNC_DEBOUNCE_MS,
} from "./constants.ts";
import { buildSanitizedEnv, error, json, readBody, resolveExecCwd, stripAnsi } from "./helpers.ts";
import {
  cleanupSession,
  createSession,
  execCommand,
  getBackoffMs,
  sessionTail,
} from "./sessions.ts";
import {
  cleanupPrefixes,
  containerMode,
  devServerBasePath,
  devServerPort,
  injectedEnv,
  lastSyncAt,
  processes,
  sessions,
  setContainerMode,
  setDevServerBasePath,
  setDevServerPort,
  setInjectedEnv,
  setLastSyncAt,
  setWorkspacePath,
  touchActivity,
  workspacePath,
} from "./state.ts";
import type { BufferEntry, ManagedProcess } from "./types.ts";

/** Trigger restic backup — imported lazily to avoid circular deps with server.ts */
let _triggerResticBackup: (() => Promise<void>) | null = null;

export function setTriggerResticBackup(fn: () => Promise<void>) {
  _triggerResticBackup = fn;
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
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
      setWorkspacePath(body.workspace);
      fs.mkdirSync(body.workspace, { recursive: true });
    }
    if (body.envVars) {
      setInjectedEnv({ ...injectedEnv, ...body.envVars });
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
    const resolved = resolveExecCwd(cwd);
    if (!resolved.ok) {
      error(res, resolved.error);
      return;
    }

    const result = await execCommand(command, timeout, resolved.path);
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

    const resolved = resolveExecCwd(cwd);
    if (!resolved.ok) {
      error(res, resolved.error);
      return;
    }
    const proc = spawn("/bin/sh", ["-c", command], {
      cwd: resolved.path,
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
        res.write(
          `data: ${JSON.stringify({ type: entry.type, data: entry.data, seq: entry.seq })}\n\n`,
        );
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
        res.write(
          `data: ${JSON.stringify({ type: entry.type, data: entry.data, seq: entry.seq })}\n\n`,
        );
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
    setLastSyncAt(now);
    // Fire-and-forget backup via sync daemon
    if (_triggerResticBackup) {
      _triggerResticBackup().catch(() => {});
    }
    json(res, { ok: true });
    return;
  }

  // --- Mode switch ---
  if (url.pathname === "/mode" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    if (body.mode === "dev" || body.mode === "normal") {
      setContainerMode(body.mode);
      json(res, { ok: true, mode: body.mode });
    } else {
      error(res, "Invalid mode — must be 'dev' or 'normal'");
    }
    return;
  }

  // --- Set dev port ---
  if (url.pathname === "/set-dev-port" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const port = body.port as number;
    if (!port || typeof port !== "number" || port < 1 || port > 65535) {
      error(res, "Invalid port");
      return;
    }
    setDevServerPort(port);
    setDevServerBasePath(body.basePath ?? null);
    json(res, { ok: true, port: devServerPort, basePath: devServerBasePath });
    return;
  }

  // --- Clear dev port ---
  if (url.pathname === "/clear-dev-port" && method === "POST") {
    setDevServerPort(null);
    setDevServerBasePath(null);
    json(res, { ok: true });
    return;
  }

  // --- Session Exec (SSE with session tracking) ---
  if (url.pathname === "/session-exec" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const command = body.command as string;
    if (!command) {
      error(res, "Missing command");
      return;
    }
    const timeout = (body.timeout as number) ?? DEFAULT_EXEC_TIMEOUT;
    const cwd = body.cwd as string | undefined;
    const resolved = resolveExecCwd(cwd);
    if (!resolved.ok) {
      error(res, resolved.error);
      return;
    }

    const session = createSession(command, resolved.path);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // First event: session metadata
    const sendEvent = (data: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Connection closed
      }
    };

    sendEvent({ type: "session", sessionId: session.id, logFile: session.logFile });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      session.proc.kill();
    }, timeout);

    let seq = 0;

    // Stream output events
    session.proc.onData((data) => {
      sendEvent({ type: "stdout", data: stripAnsi(data), seq: ++seq });
    });

    const heartbeat = setInterval(() => {
      sendEvent({ type: "heartbeat" });
    }, 5000);

    session.proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (killed) {
        sendEvent({
          type: "stderr",
          data: `\nProcess exceeded ${timeout}ms timeout and was killed.`,
          seq: ++seq,
        });
      }
      sendEvent({ type: "exit", code: exitCode ?? (killed ? 137 : 1) });
      res.end();
    });

    req.on("close", () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      // Don't kill process on disconnect — it keeps running with session tracking
    });

    return;
  }

  // --- Session Start (background) ---
  if (url.pathname === "/session-start" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const command = body.command as string;
    if (!command) {
      error(res, "Missing command");
      return;
    }
    const timeout = body.timeout as number | undefined;
    const cwd = body.cwd as string | undefined;
    const resolved = resolveExecCwd(cwd);
    if (!resolved.ok) {
      error(res, resolved.error);
      return;
    }

    const session = createSession(command, resolved.path);

    // Optional timeout for background processes
    if (timeout) {
      setTimeout(() => {
        if (session.running) {
          session.proc.kill();
        }
      }, timeout);
    }

    json(res, { sessionId: session.id, pid: session.pid, logFile: session.logFile });
    return;
  }

  // --- Session Poll ---
  if (url.pathname === "/session-poll" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const sessionId = body.sessionId as string;

    const session = sessions.get(sessionId);
    if (!session) {
      error(res, `Session "${sessionId}" not found`, 404);
      return;
    }

    // Reset GC timer on poll (session is still being observed)
    if (session.gcTimer) {
      clearTimeout(session.gcTimer);
      session.gcTimer = undefined;
    }
    if (!session.running) {
      // Re-arm GC since session is finished
      session.gcTimer = setTimeout(() => cleanupSession(session.id), SESSION_GC_DELAY);
    }

    // Drain pending buffer
    const pending = session.pendingBuffer;
    const hadOutput = pending.length > 0;
    session.pendingBuffer = "";

    // Backoff tracking
    if (hadOutput) {
      session.consecutiveEmptyPolls = 0;
    } else {
      session.consecutiveEmptyPolls++;
    }
    session.lastPollAt = Date.now();

    json(res, {
      sessionId: session.id,
      running: session.running,
      exitCode: session.exitCode,
      pending,
      tail: sessionTail(session),
      logFile: session.logFile,
      retryAfterMs: getBackoffMs(session.consecutiveEmptyPolls),
      outputBytes: session.outputBytes,
      truncated: session.truncated,
    });
    return;
  }

  // --- Session Write ---
  if (url.pathname === "/session-write" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const sessionId = body.sessionId as string;
    const input = body.input as string;

    const session = sessions.get(sessionId);
    if (!session) {
      error(res, `Session "${sessionId}" not found`, 404);
      return;
    }
    if (!session.running) {
      error(res, "Session has exited", 400);
      return;
    }

    session.proc.write(input);
    json(res, { ok: true, bytes: input.length });
    return;
  }

  // --- Session Kill ---
  if (url.pathname === "/session-kill" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const sessionId = body.sessionId as string;

    const session = sessions.get(sessionId);
    if (!session) {
      error(res, `Session "${sessionId}" not found`, 404);
      return;
    }
    if (!session.running) {
      json(res, { ok: true, alreadyExited: true });
      return;
    }

    session.proc.kill();
    // Force kill after 5s if still running
    const killTimer = setTimeout(() => {
      if (session.running) {
        session.proc.kill(9);
      }
    }, 5000);

    session.proc.onExit(() => clearTimeout(killTimer));
    json(res, { ok: true });
    return;
  }

  // --- Session Remove ---
  if (url.pathname === "/session-remove" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const sessionId = body.sessionId as string;

    const session = sessions.get(sessionId);
    if (!session) {
      error(res, `Session "${sessionId}" not found`, 404);
      return;
    }
    if (session.running) {
      error(res, "Cannot remove a running session — kill it first", 400);
      return;
    }

    cleanupSession(sessionId);
    json(res, { ok: true });
    return;
  }

  // --- Session List ---
  if (url.pathname === "/session-list" && method === "GET") {
    const list = Array.from(sessions.values()).map((s) => ({
      sessionId: s.id,
      command: s.command,
      running: s.running,
      exitCode: s.exitCode,
      pid: s.pid,
      startedAt: s.startedAt,
      logFile: s.logFile,
      outputBytes: s.outputBytes,
    }));
    json(res, list);
    return;
  }

  // --- Session Log ---
  if (url.pathname.startsWith("/session-log/") && method === "GET") {
    const sessionId = url.pathname.slice("/session-log/".length);
    const tailLines = url.searchParams.get("tail");

    const session = sessions.get(sessionId);
    if (!session) {
      error(res, `Session "${sessionId}" not found`, 404);
      return;
    }

    try {
      let content = fs.readFileSync(session.logFile, "utf-8");
      if (tailLines) {
        const n = Number.parseInt(tailLines, 10);
        if (n > 0) {
          const lines = content.split("\n");
          content = lines.slice(-n).join("\n");
        }
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(content);
    } catch {
      error(res, "Failed to read log file", 500);
    }
    return;
  }

  // --- Exec Stream (SSE) ---
  if (url.pathname === "/exec-stream" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const command = body.command as string;
    if (!command) {
      error(res, "Missing command");
      return;
    }
    const timeout = (body.timeout as number) ?? DEFAULT_EXEC_TIMEOUT;
    const cwd = body.cwd as string | undefined;
    const resolved = resolveExecCwd(cwd);
    if (!resolved.ok) {
      error(res, resolved.error);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const proc = pty.spawn("/bin/sh", ["-c", command], {
      cwd: resolved.path,
      env: buildSanitizedEnv(),
      cols: 120,
      rows: 40,
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, timeout);

    let seq = 0;

    const sendEvent = (data: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Connection closed
      }
    };

    // PTY merges stdout/stderr into a single stream — send all as stdout
    proc.onData((data) => {
      sendEvent({ type: "stdout", data: stripAnsi(data), seq: ++seq });
    });

    const heartbeat = setInterval(() => {
      sendEvent({ type: "heartbeat" });
    }, 5000);

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (killed) {
        sendEvent({
          type: "stderr",
          data: `\nProcess exceeded ${timeout}ms timeout and was killed.`,
          seq: ++seq,
        });
      }
      sendEvent({ type: "exit", code: exitCode ?? (killed ? 137 : 1) });
      res.end();
    });

    req.on("close", () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      proc.kill();
    });

    return;
  }

  // --- Dev server proxy fallback ---
  // Must be after all container endpoints so sandbox operations aren't swallowed.
  // Strip the preview base path (e.g. /preview/{agentId}/) before forwarding
  // so the dev server sees clean paths (/ , /api/items, etc.).
  if (devServerPort) {
    try {
      let proxyPath = url.pathname;
      if (devServerBasePath && proxyPath.startsWith(devServerBasePath)) {
        proxyPath = proxyPath.slice(devServerBasePath.length - 1) || "/";
      }
      const proxyUrl = `http://127.0.0.1:${devServerPort}${proxyPath}${url.search}`;
      const proxyRes = await fetch(proxyUrl, {
        method,
        headers: Object.fromEntries(
          Object.entries(req.headers)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v!]),
        ),
        body: method !== "GET" && method !== "HEAD" ? await readBody(req) : undefined,
      });

      const headers: Record<string, string> = {};
      proxyRes.headers.forEach((v, k) => {
        headers[k] = v;
      });
      res.writeHead(proxyRes.status, headers);
      const arrayBuf = await proxyRes.arrayBuffer();
      res.end(Buffer.from(arrayBuf));
      return;
    } catch {
      // Dev server not ready — return a loading page that auto-retries
      const retryHtml = `<!DOCTYPE html>
<html><head><title>Starting...</title><style>
body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
font-family:system-ui,sans-serif;background:#1a1a2e;color:#94a3b8}
.spinner{width:24px;height:24px;border:3px solid #334155;border-top-color:#818cf8;
border-radius:50%;animation:spin 0.8s linear infinite;margin-right:12px}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="spinner"></div>
<span>Dev server starting on port ${devServerPort}...</span>
<script>setTimeout(()=>location.reload(),1500)</script>
</body></html>`;
      res.writeHead(503, { "content-type": "text/html" });
      res.end(retryHtml);
      return;
    }
  }

  // --- Not found ---
  error(res, "Not found", 404);
}
