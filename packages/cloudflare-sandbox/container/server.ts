/**
 * Sandbox HTTP server — runs inside the container on port 8080.
 * Provides command execution, process management, and health endpoints
 * that CloudflareSandboxProvider proxies to.
 */
import http from "node:http";
import {
  IDLE_CHECK_INTERVAL,
  IDLE_TIMEOUT_DEV,
  IDLE_TIMEOUT_NORMAL,
  PORT,
  SYNC_SOCKET,
} from "./constants.ts";
import { error } from "./helpers.ts";
import { handleRequest, setTriggerResticBackup } from "./routes.ts";
import {
  containerMode,
  devServerPort,
  lastActivityAt,
  processes,
  sessions,
  touchActivity,
  workspacePath,
} from "./state.ts";

// --- Restic sync helper ---

async function triggerResticBackup(): Promise<void> {
  const { execSync } = await import("node:child_process");
  try {
    execSync(`curl -s --unix-socket ${SYNC_SOCKET} http://localhost/backup -X POST`, {
      timeout: 120_000,
    });
  } catch (err) {
    console.error("[sandbox] Restic backup failed:", err);
  }
}

// Wire up the restic backup function for routes to use
setTriggerResticBackup(triggerResticBackup);

// --- Graceful shutdown ---

async function gracefulShutdown(): Promise<void> {
  // Stop all managed processes
  for (const [, managed] of processes) {
    if (managed.running) managed.proc.kill("SIGTERM");
  }

  // Kill all running sessions
  for (const [, session] of sessions) {
    if (session.running) session.proc.kill();
  }

  // Final backup in dev mode
  if (containerMode === "dev") {
    console.log("[sandbox] Dev mode — running final backup before shutdown");
    await triggerResticBackup().catch(() => {});
  }

  clearInterval(idleCheck);
  server.close(() => process.exit(0));
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

// --- WebSocket upgrade bridging (HMR) ---

server.on("upgrade", (req, socket, head) => {
  if (!devServerPort) {
    socket.destroy();
    return;
  }

  const { createConnection } = require("node:net") as typeof import("node:net");
  const upstream = createConnection({ port: devServerPort, host: "127.0.0.1" }, () => {
    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries(req.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    upstream.write(`${reqLine}${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`[sandbox] Server listening on port ${PORT}`);
  if (workspacePath) console.log(`[sandbox] Workspace: ${workspacePath}`);
});

// --- Idle timeout ---

const idleCheck = setInterval(() => {
  const hasRunning =
    Array.from(processes.values()).some((p) => p.running) ||
    Array.from(sessions.values()).some((s) => s.running);
  if (hasRunning) {
    touchActivity();
    return;
  }

  const timeout = containerMode === "dev" ? IDLE_TIMEOUT_DEV : IDLE_TIMEOUT_NORMAL;
  if (Date.now() - lastActivityAt > timeout) {
    console.log("[sandbox] Idle timeout reached, shutting down");
    gracefulShutdown();
  }
}, IDLE_CHECK_INTERVAL);

// --- SIGTERM handler ---

process.on("SIGTERM", () => {
  console.log("[sandbox] SIGTERM received, shutting down");
  gracefulShutdown();
});
