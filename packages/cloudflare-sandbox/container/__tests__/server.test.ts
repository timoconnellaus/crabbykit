/**
 * Integration tests for the sandbox container HTTP server.
 *
 * Spawns the real server.ts on a random port, then exercises every
 * HTTP endpoint.  Requires `node-pty` (available via bun).
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SERVER_PATH = path.resolve(__dirname, "..", "server.ts");

let serverProc: ChildProcess;
let Base: string;
let port: number;
/**
 * True when the server's PTY layer (node-pty) can reliably spawn AND exit a
 * subprocess on this host. node-pty has a known bug under Bun on macOS where
 * `onExit` callbacks fail to fire reliably (the prebuilt spawn-helper exits
 * but the parent never observes it). When this is false, all PTY-dependent
 * tests are skipped — they're integration tests for the actual container
 * runtime, which is a Linux Docker image where node-pty works correctly.
 */
let ptyExecWorks = false;

/**
 * Use as `beforeEach(skipIfNoPty)` in any describe block whose tests rely on
 * PTY processes exiting cleanly. The probe in beforeAll sets ptyExecWorks.
 */
function skipIfNoPty(ctx: { skip: () => void }) {
  if (!ptyExecWorks) ctx.skip();
}

/** Find an available port by briefly listening on 0. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Could not determine port")));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

/** POST JSON helper */
async function post(endpoint: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${Base}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

/** GET helper */
async function get(endpoint: string): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${Base}${endpoint}`);
  const data = await res.json();
  return { status: res.status, data };
}

/** GET text helper */
async function getText(endpoint: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${Base}${endpoint}`);
  const text = await res.text();
  return { status: res.status, text };
}

/** POST and read SSE events until the stream closes. */
async function postSSE(
  endpoint: string,
  body: unknown,
  opts?: { maxEvents?: number; timeoutMs?: number },
): Promise<{ events: unknown[] }> {
  const maxEvents = opts?.maxEvents ?? 100;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const res = await fetch(`${Base}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buf = "";

  const deadline = Date.now() + timeoutMs;
  while (events.length < maxEvents && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          // skip non-JSON
        }
      }
    }
  }
  reader.cancel().catch(() => {});
  return { events };
}

beforeAll(async () => {
  port = await getFreePort();
  Base = `http://127.0.0.1:${port}`;

  serverProc = spawn("bun", ["run", SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      // Don't use AGENT_ID so workspace defaults to ""
      AGENT_ID: "",
      CONTAINER_MODE: "normal",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Log stderr for debugging startup failures
  serverProc.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[server stderr] ${msg}`);
  });

  // Wait for the server to be ready (poll /health)
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < 10_000) {
    try {
      const res = await fetch(`${Base}/health`);
      if (res.ok) {
        lastError = null;
        break;
      }
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (lastError) {
    throw new Error(`Server failed to start on port ${port} within 10s: ${lastError}`);
  }

  // Probe PTY exec: try a trivial echo with a short timeout. If onExit doesn't
  // fire (the host's node-pty is broken), all PTY-dependent tests will skip.
  try {
    const probe = await Promise.race([
      fetch(`${Base}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "echo probe" }),
      }).then((r) => r.json()),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pty probe timeout")), 5_000)),
    ]);
    ptyExecWorks =
      typeof probe === "object" &&
      probe !== null &&
      typeof (probe as { stdout?: string }).stdout === "string" &&
      (probe as { stdout: string }).stdout.includes("probe");
  } catch {
    ptyExecWorks = false;
  }
  if (!ptyExecWorks) {
    console.warn(
      "[server.test] PTY exec probe failed — skipping all PTY-dependent tests. " +
        "This is expected on macOS+Bun (node-pty onExit bug); CI runs on Linux where it works.",
    );
  }
}, 25_000);

afterAll(() => {
  if (serverProc) {
    serverProc.kill("SIGTERM");
  }
});

// ──────────────────────────────────────────
// Health
// ──────────────────────────────────────────

describe("/health", () => {
  it("returns ready with workspace and process count", async () => {
    const { status, data } = await get("/health");
    expect(status).toBe(200);
    expect(data).toMatchObject({ ready: true, processes: expect.any(Number) });
  });

  it("drains cleanupPrefixes on read", async () => {
    // Push a prefix first
    await post("/internal/cleanup-r2", { prefix: "test-prefix/" });
    const { data: d1 } = await get("/health");
    expect((d1 as any).cleanupPrefixes).toContain("test-prefix/");

    // Second read should have empty prefixes (drained)
    const { data: d2 } = await get("/health");
    expect((d2 as any).cleanupPrefixes).toBeUndefined();
  });
});

// ──────────────────────────────────────────
// Init
// ──────────────────────────────────────────

describe("/init", () => {
  it("sets workspace and env vars", async () => {
    const { status, data } = await post("/init", {
      workspace: "/tmp/sandbox-test-ws",
      envVars: { MY_VAR: "hello" },
    });
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, workspace: "/tmp/sandbox-test-ws" });
  });
});

// ──────────────────────────────────────────
// Exec
// ──────────────────────────────────────────

describe("/exec", () => {
  beforeEach(skipIfNoPty);
  it("executes a command and returns output", async () => {
    const { status, data } = await post("/exec", {
      command: "echo hello-world",
    });
    expect(status).toBe(200);
    const d = data as any;
    expect(d.stdout).toContain("hello-world");
    expect(d.exitCode).toBe(0);
  });

  it("returns error for missing command", async () => {
    const { status, data } = await post("/exec", {});
    expect(status).toBe(400);
    expect((data as any).error).toBe("Missing command");
  });

  it("respects timeout and kills process", async () => {
    const { status, data } = await post("/exec", {
      command: "sleep 60",
      timeout: 500,
    });
    expect(status).toBe(200);
    const d = data as any;
    expect(d.stderr).toContain("timeout");
  });

  it("uses injected env vars from /init", async () => {
    await post("/init", { envVars: { TEST_EXEC_VAR: "from-init" } });
    const { data } = await post("/exec", {
      command: "echo $TEST_EXEC_VAR",
    });
    expect((data as any).stdout).toContain("from-init");
  });

  it("respects cwd parameter", async () => {
    const { data } = await post("/exec", {
      command: "pwd",
      cwd: "/tmp/sandbox-test-ws",
    });
    expect((data as any).stdout).toContain("/tmp/sandbox-test-ws");
  });
});

// ──────────────────────────────────────────
// Process management
// ──────────────────────────────────────────

describe("process management", () => {
  it("starts, lists, and stops a managed process", async () => {
    // Start
    const { status: startStatus, data: startData } = await post("/process-start", {
      name: "test-proc",
      command: "sleep 30",
    });
    expect(startStatus).toBe(200);
    expect((startData as any).name).toBe("test-proc");
    expect((startData as any).pid).toBeGreaterThan(0);

    // List
    const { data: listData } = await get("/process-list");
    const list = listData as any[];
    const found = list.find((p) => p.name === "test-proc");
    expect(found).toBeTruthy();
    expect(found.running).toBe(true);

    // Stop
    const { status: stopStatus, data: stopData } = await post("/process-stop", {
      name: "test-proc",
    });
    expect(stopStatus).toBe(200);
    expect((stopData as any).ok).toBe(true);
  });

  it("rejects invalid process name", async () => {
    const { status, data } = await post("/process-start", {
      name: "bad name!",
      command: "echo hi",
    });
    expect(status).toBe(400);
    expect((data as any).error).toBe("Invalid process name");
  });

  it("rejects missing command", async () => {
    const { status, data } = await post("/process-start", {
      name: "no-cmd",
    });
    expect(status).toBe(400);
    expect((data as any).error).toBe("Missing command");
  });

  it("returns 409 for duplicate running process", async () => {
    await post("/process-start", {
      name: "dup-proc",
      command: "sleep 30",
    });
    const { status, data } = await post("/process-start", {
      name: "dup-proc",
      command: "sleep 30",
    });
    expect(status).toBe(409);
    expect((data as any).error).toContain("already running");

    // Cleanup
    await post("/process-stop", { name: "dup-proc" });
  });

  it("returns 404 for stopping non-existent process", async () => {
    const { status } = await post("/process-stop", {
      name: "nonexistent-proc",
    });
    expect(status).toBe(404);
  });

  it("returns alreadyStopped for dead process", async () => {
    await post("/process-start", {
      name: "quick-die",
      command: "echo done",
    });
    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await post("/process-stop", { name: "quick-die" });
    expect((data as any).alreadyStopped).toBe(true);
  });
});

// ──────────────────────────────────────────
// Process stream (SSE)
// ──────────────────────────────────────────

describe("/process-stream", () => {
  it("returns 404 for unknown process", async () => {
    const res = await fetch(`${Base}/process-stream/ghost`);
    expect(res.status).toBe(404);
  });

  it("streams output and exit event", async () => {
    await post("/process-start", {
      name: "stream-me",
      command: 'echo "sse-output" && sleep 0.2',
    });
    // Give the process a moment to start producing output
    await new Promise((r) => setTimeout(r, 300));

    const res = await fetch(`${Base}/process-stream/stream-me?afterSeq=0`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: unknown[] = [];

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* skip */
          }
        }
      }
      // Break once we get an exit event
      if (events.some((e: any) => e.type === "exit")) break;
    }
    reader.cancel().catch(() => {});

    const hasOutput = events.some((e: any) => e.type === "stdout" || e.type === "stderr");
    const hasExit = events.some((e: any) => e.type === "exit");
    expect(hasOutput || hasExit).toBe(true);
  });
});

// ──────────────────────────────────────────
// Session lifecycle
// ──────────────────────────────────────────

describe("session lifecycle", () => {
  beforeEach(skipIfNoPty);
  let sessionId: string;

  it("starts a background session", async () => {
    const { status, data } = await post("/session-start", {
      command: "sleep 10",
    });
    expect(status).toBe(200);
    const d = data as any;
    expect(d.sessionId).toBeTruthy();
    expect(d.pid).toBeGreaterThan(0);
    sessionId = d.sessionId;
  });

  it("lists sessions", async () => {
    const { data } = await get("/session-list");
    const list = data as any[];
    expect(list.some((s) => s.sessionId === sessionId)).toBe(true);
  });

  it("polls session for output", async () => {
    const { status, data } = await post("/session-poll", { sessionId });
    expect(status).toBe(200);
    const d = data as any;
    expect(d.sessionId).toBe(sessionId);
    expect(d.running).toBe(true);
    expect(d.retryAfterMs).toBeGreaterThan(0);
  });

  it("writes input to session", async () => {
    // Start an interactive session
    const { data: startData } = await post("/session-start", {
      command: "cat",
    });
    const catSessionId = (startData as any).sessionId;

    const { status, data } = await post("/session-write", {
      sessionId: catSessionId,
      input: "hello\n",
    });
    expect(status).toBe(200);
    expect((data as any).ok).toBe(true);
    expect((data as any).bytes).toBe(6);

    // Kill the cat session
    await post("/session-kill", { sessionId: catSessionId });
  });

  it("returns 404 for write to unknown session", async () => {
    const { status } = await post("/session-write", {
      sessionId: "nonexistent",
      input: "hello",
    });
    expect(status).toBe(404);
  });

  it("returns error for write to exited session", async () => {
    const { data: startData } = await post("/session-start", {
      command: "echo done",
    });
    const sid = (startData as any).sessionId;
    await new Promise((r) => setTimeout(r, 500));

    const { status, data } = await post("/session-write", {
      sessionId: sid,
      input: "nope",
    });
    expect(status).toBe(400);
    expect((data as any).error).toContain("exited");
  });

  it("kills a running session", async () => {
    const { status, data } = await post("/session-kill", { sessionId });
    expect(status).toBe(200);
    expect((data as any).ok).toBe(true);
  });

  it("returns alreadyExited for dead session", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { data } = await post("/session-kill", { sessionId });
    expect((data as any).alreadyExited).toBe(true);
  });

  it("returns 404 for kill of unknown session", async () => {
    const { status } = await post("/session-kill", {
      sessionId: "nonexistent",
    });
    expect(status).toBe(404);
  });

  it("removes a dead session", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const { status, data } = await post("/session-remove", { sessionId });
    expect(status).toBe(200);
    expect((data as any).ok).toBe(true);

    // Verify it's gone
    const { status: s2 } = await post("/session-poll", { sessionId });
    expect(s2).toBe(404);
  });

  it("cannot remove a running session", async () => {
    const { data: startData } = await post("/session-start", {
      command: "sleep 30",
    });
    const sid = (startData as any).sessionId;

    const { status, data } = await post("/session-remove", {
      sessionId: sid,
    });
    expect(status).toBe(400);
    expect((data as any).error).toContain("kill it first");

    await post("/session-kill", { sessionId: sid });
  });

  it("returns 404 for remove of unknown session", async () => {
    const { status } = await post("/session-remove", {
      sessionId: "nonexistent",
    });
    expect(status).toBe(404);
  });
});

// ──────────────────────────────────────────
// Session poll backoff
// ──────────────────────────────────────────

describe("session poll backoff", () => {
  it("increases retryAfterMs on consecutive empty polls", async () => {
    const { data: startData } = await post("/session-start", {
      command: "sleep 10",
    });
    const sid = (startData as any).sessionId;

    // First poll — should return 5000 (first entry in schedule)
    const { data: poll1 } = await post("/session-poll", { sessionId: sid });
    // Second poll — empty again, consecutive count goes up
    const { data: poll2 } = await post("/session-poll", { sessionId: sid });
    const { data: poll3 } = await post("/session-poll", { sessionId: sid });

    // retryAfterMs should be non-decreasing
    expect((poll2 as any).retryAfterMs).toBeGreaterThanOrEqual((poll1 as any).retryAfterMs);
    expect((poll3 as any).retryAfterMs).toBeGreaterThanOrEqual((poll2 as any).retryAfterMs);

    await post("/session-kill", { sessionId: sid });
  });
});

// ──────────────────────────────────────────
// Session log
// ──────────────────────────────────────────

describe("/session-log", () => {
  beforeEach(skipIfNoPty);
  it("reads log file for a session", async () => {
    const { data: startData } = await post("/session-start", {
      command: 'echo "log-test-output"',
    });
    const sid = (startData as any).sessionId;
    // Wait for output to be written
    await new Promise((r) => setTimeout(r, 500));

    const { status, text } = await getText(`/session-log/${sid}`);
    expect(status).toBe(200);
    expect(text).toContain("log-test-output");
  });

  it("supports tail parameter", async () => {
    const { data: startData } = await post("/session-start", {
      command: 'for i in 1 2 3 4 5; do echo "line-$i"; done',
    });
    const sid = (startData as any).sessionId;
    await new Promise((r) => setTimeout(r, 500));

    const { status, text } = await getText(`/session-log/${sid}?tail=2`);
    expect(status).toBe(200);
    // Should only have the last 2 lines
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(3); // tail=2 plus possible trailing newline
  });

  it("returns 404 for unknown session", async () => {
    const res = await fetch(`${Base}/session-log/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────
// Session exec (SSE)
// ──────────────────────────────────────────

describe("/session-exec", () => {
  beforeEach(skipIfNoPty);
  it("streams session output and exit via SSE", async () => {
    const { events } = await postSSE("/session-exec", {
      command: 'echo "sse-session-test"',
    });

    const sessionEvent = events.find((e: any) => e.type === "session");
    expect(sessionEvent).toBeTruthy();
    expect((sessionEvent as any).sessionId).toBeTruthy();

    const exitEvent = events.find((e: any) => e.type === "exit");
    expect(exitEvent).toBeTruthy();
    expect((exitEvent as any).code).toBe(0);
  });

  it("returns error for missing command", async () => {
    const { status, data } = await post("/session-exec", {});
    expect(status).toBe(400);
    expect((data as any).error).toBe("Missing command");
  });

  it("kills process on timeout", async () => {
    const { events } = await postSSE(
      "/session-exec",
      { command: "sleep 60", timeout: 500 },
      { timeoutMs: 5000 },
    );

    const stderrEvent = events.find((e: any) => e.type === "stderr");
    expect(stderrEvent).toBeTruthy();
    expect((stderrEvent as any).data).toContain("timeout");
  });
});

// ──────────────────────────────────────────
// Exec stream (SSE)
// ──────────────────────────────────────────

describe("/exec-stream", () => {
  beforeEach(skipIfNoPty);
  it("streams command output via SSE", async () => {
    const { events } = await postSSE("/exec-stream", {
      command: 'echo "stream-test"',
    });

    const hasOutput = events.some(
      (e: any) => e.type === "stdout" && e.data.includes("stream-test"),
    );
    expect(hasOutput).toBe(true);

    const exitEvent = events.find((e: any) => e.type === "exit");
    expect(exitEvent).toBeTruthy();
    expect((exitEvent as any).code).toBe(0);
  });

  it("returns error for missing command", async () => {
    const { status } = await post("/exec-stream", {});
    expect(status).toBe(400);
  });

  it("kills on timeout", async () => {
    const { events } = await postSSE(
      "/exec-stream",
      { command: "sleep 60", timeout: 500 },
      { timeoutMs: 5000 },
    );

    const stderrEvent = events.find((e: any) => e.type === "stderr");
    expect(stderrEvent).toBeTruthy();
    expect((stderrEvent as any).data).toContain("timeout");
  });
});

// ──────────────────────────────────────────
// Mode switch
// ──────────────────────────────────────────

describe("/mode", () => {
  it("switches to dev mode", async () => {
    const { status, data } = await post("/mode", { mode: "dev" });
    expect(status).toBe(200);
    expect((data as any).mode).toBe("dev");
  });

  it("switches back to normal mode", async () => {
    const { status, data } = await post("/mode", { mode: "normal" });
    expect(status).toBe(200);
    expect((data as any).mode).toBe("normal");
  });

  it("rejects invalid mode", async () => {
    const { status, data } = await post("/mode", { mode: "turbo" });
    expect(status).toBe(400);
    expect((data as any).error).toContain("Invalid mode");
  });
});

// ──────────────────────────────────────────
// Dev port management
// ──────────────────────────────────────────

describe("dev port management", () => {
  it("sets dev port", async () => {
    const { status, data } = await post("/set-dev-port", { port: 3000 });
    expect(status).toBe(200);
    expect((data as any).port).toBe(3000);
  });

  it("sets dev port with basePath", async () => {
    const { data } = await post("/set-dev-port", {
      port: 3000,
      basePath: "/preview/agent-1/",
    });
    expect((data as any).basePath).toBe("/preview/agent-1/");
  });

  it("rejects invalid port", async () => {
    const { status } = await post("/set-dev-port", { port: 0 });
    expect(status).toBe(400);
  });

  it("rejects port > 65535", async () => {
    const { status } = await post("/set-dev-port", { port: 70000 });
    expect(status).toBe(400);
  });

  it("rejects non-numeric port", async () => {
    const { status } = await post("/set-dev-port", { port: "abc" });
    expect(status).toBe(400);
  });

  it("clears dev port", async () => {
    const { status, data } = await post("/clear-dev-port", {});
    expect(status).toBe(200);
    expect((data as any).ok).toBe(true);
  });
});

// ──────────────────────────────────────────
// Trigger sync
// ──────────────────────────────────────────

describe("/trigger-sync", () => {
  it("rejects in normal mode", async () => {
    await post("/mode", { mode: "normal" });
    const { status, data } = await post("/trigger-sync", {});
    expect(status).toBe(400);
    expect((data as any).error).toContain("Not in dev mode");
  });

  it("triggers sync in dev mode", async () => {
    await post("/mode", { mode: "dev" });
    const { status, data } = await post("/trigger-sync", {});
    expect(status).toBe(200);
    expect((data as any).ok).toBe(true);
  });

  it("debounces rapid syncs", async () => {
    await post("/mode", { mode: "dev" });
    // First sync should succeed
    await post("/trigger-sync", {});
    // Immediate second sync should be debounced
    const { data } = await post("/trigger-sync", {});
    expect((data as any).debounced).toBe(true);

    // Reset to normal
    await post("/mode", { mode: "normal" });
  });
});

// ──────────────────────────────────────────
// Cleanup R2 notification
// ──────────────────────────────────────────

describe("/internal/cleanup-r2", () => {
  it("accepts cleanup prefix", async () => {
    const { status, data } = await post("/internal/cleanup-r2", {
      prefix: "agents/old-agent/",
    });
    expect(status).toBe(200);
    expect((data as any).ok).toBe(true);
  });
});

// ──────────────────────────────────────────
// Dev server proxy fallback
// ──────────────────────────────────────────

describe("dev server proxy", () => {
  it("returns 503 loading page when dev server is not ready", async () => {
    // Set a dev port that nothing is listening on
    const badPort = await getFreePort();
    await post("/set-dev-port", { port: badPort });

    const res = await fetch(`${Base}/some-random-path`);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Dev server starting");

    // Clean up
    await post("/clear-dev-port", {});
  });

  it("strips basePath before forwarding to dev server", async () => {
    // We can't test a real proxy without a dev server, but we can verify
    // the 503 fallback path works with basePath set
    const badPort = await getFreePort();
    await post("/set-dev-port", {
      port: badPort,
      basePath: "/preview/agent-1/",
    });

    const res = await fetch(`${Base}/preview/agent-1/index.html`);
    expect(res.status).toBe(503);

    await post("/clear-dev-port", {});
  });
});

// ──────────────────────────────────────────
// 404
// ──────────────────────────────────────────

describe("404 fallback", () => {
  it("returns 404 for unknown routes (no dev port)", async () => {
    // Ensure no dev port is set
    await post("/clear-dev-port", {});

    const { status, data } = await get("/nonexistent-endpoint");
    expect(status).toBe(404);
    expect((data as any).error).toBe("Not found");
  });
});

// ──────────────────────────────────────────
// Session start with timeout
// ──────────────────────────────────────────

describe("session-start with timeout", () => {
  beforeEach(skipIfNoPty);
  it("auto-kills session after timeout", async () => {
    const { data } = await post("/session-start", {
      command: "sleep 60",
      timeout: 500,
    });
    const sid = (data as any).sessionId;

    // Wait for timeout + grace
    await new Promise((r) => setTimeout(r, 1000));

    const { data: pollData } = await post("/session-poll", {
      sessionId: sid,
    });
    expect((pollData as any).running).toBe(false);
  });
});

// ──────────────────────────────────────────
// Session start edge cases
// ──────────────────────────────────────────

describe("session-start edge cases", () => {
  beforeEach(skipIfNoPty);
  it("returns 400 for missing command", async () => {
    const { status, data } = await post("/session-start", {});
    expect(status).toBe(400);
    expect((data as any).error).toBe("Missing command");
  });

  it("respects cwd parameter", async () => {
    const { data: startData } = await post("/session-start", {
      command: "pwd",
      cwd: "/tmp/sandbox-test-ws",
    });
    const sid = (startData as any).sessionId;
    // Wait for output
    await new Promise((r) => setTimeout(r, 500));

    const { data: pollData } = await post("/session-poll", {
      sessionId: sid,
    });
    expect((pollData as any).tail).toContain("/tmp/sandbox-test-ws");
  });

  it("returns logFile in response", async () => {
    const { data } = await post("/session-start", {
      command: "echo hello",
    });
    expect((data as any).logFile).toBeTruthy();
    expect((data as any).logFile).toContain("/tmp/sandbox-logs/");
  });
});

// ──────────────────────────────────────────
// Session poll edge cases
// ──────────────────────────────────────────

describe("session-poll edge cases", () => {
  beforeEach(skipIfNoPty);
  it("returns 404 for unknown session", async () => {
    const { status, data } = await post("/session-poll", {
      sessionId: "nonexistent",
    });
    expect(status).toBe(404);
    expect((data as any).error).toContain("not found");
  });

  it("returns outputBytes and truncated fields", async () => {
    const { data: startData } = await post("/session-start", {
      command: "echo measurement-test",
    });
    const sid = (startData as any).sessionId;
    await new Promise((r) => setTimeout(r, 500));

    const { data: pollData } = await post("/session-poll", {
      sessionId: sid,
    });
    expect((pollData as any).outputBytes).toBeGreaterThan(0);
    expect((pollData as any).truncated).toBe(false);
  });

  it("resets backoff when output is available", async () => {
    const { data: startData } = await post("/session-start", {
      command: 'sleep 0.3 && echo "delayed-output" && sleep 10',
    });
    const sid = (startData as any).sessionId;

    // First poll: no output yet → empty, consecutiveEmptyPolls increases
    const { data: poll1 } = await post("/session-poll", {
      sessionId: sid,
    });
    const retry1 = (poll1 as any).retryAfterMs;

    // Second empty poll → retryAfterMs should stay same or increase
    const { data: poll2 } = await post("/session-poll", {
      sessionId: sid,
    });
    expect((poll2 as any).retryAfterMs).toBeGreaterThanOrEqual(retry1);

    // Wait for output to arrive
    await new Promise((r) => setTimeout(r, 500));

    // Third poll: has output → consecutiveEmptyPolls resets to 0
    const { data: poll3 } = await post("/session-poll", {
      sessionId: sid,
    });
    expect((poll3 as any).pending).toContain("delayed-output");
    // After reset, retryAfterMs should be the first backoff value (5000)
    expect((poll3 as any).retryAfterMs).toBe(5000);

    await post("/session-kill", { sessionId: sid });
  });
});

// ──────────────────────────────────────────
// Session exec edge cases
// ──────────────────────────────────────────

describe("session-exec edge cases", () => {
  beforeEach(skipIfNoPty);
  it("respects cwd parameter", async () => {
    const { events } = await postSSE("/session-exec", {
      command: "pwd",
      cwd: "/tmp/sandbox-test-ws",
    });
    const stdoutEvents = events.filter((e: any) => e.type === "stdout");
    const output = stdoutEvents.map((e: any) => e.data).join("");
    expect(output).toContain("/tmp/sandbox-test-ws");
  });

  it("returns sequential seq numbers in events", async () => {
    const { events } = await postSSE("/session-exec", {
      command: "echo line1 && echo line2",
    });
    const seqEvents = events.filter((e: any) => e.seq !== undefined);
    for (let i = 1; i < seqEvents.length; i++) {
      expect((seqEvents[i] as any).seq).toBeGreaterThan((seqEvents[i - 1] as any).seq);
    }
  });

  it("includes session metadata as first event", async () => {
    const { events } = await postSSE("/session-exec", {
      command: "echo hi",
    });
    const sessionEvent = events.find((e: any) => e.type === "session");
    expect(sessionEvent).toBeTruthy();
    expect((sessionEvent as any).sessionId).toBeTruthy();
    expect((sessionEvent as any).logFile).toBeTruthy();
  });
});

// ──────────────────────────────────────────
// Exec stream edge cases
// ──────────────────────────────────────────

describe("exec-stream edge cases", () => {
  beforeEach(skipIfNoPty);
  it("respects cwd parameter", async () => {
    const { events } = await postSSE("/exec-stream", {
      command: "pwd",
      cwd: "/tmp/sandbox-test-ws",
    });
    const stdoutEvents = events.filter((e: any) => e.type === "stdout");
    const output = stdoutEvents.map((e: any) => e.data).join("");
    expect(output).toContain("/tmp/sandbox-test-ws");
  });

  it("returns sequential seq numbers", async () => {
    const { events } = await postSSE("/exec-stream", {
      command: "echo a && echo b",
    });
    const seqEvents = events.filter((e: any) => e.seq !== undefined);
    for (let i = 1; i < seqEvents.length; i++) {
      expect((seqEvents[i] as any).seq).toBeGreaterThan((seqEvents[i - 1] as any).seq);
    }
  });
});

// ──────────────────────────────────────────
// Process name reuse after exit
// ──────────────────────────────────────────

describe("process name reuse", () => {
  it("allows restarting a process with the same name after it exits", async () => {
    // Start and let it exit
    await post("/process-start", {
      name: "reuse-me",
      command: "echo done",
    });
    await new Promise((r) => setTimeout(r, 500));

    // Should be able to start again with the same name
    const { status, data } = await post("/process-start", {
      name: "reuse-me",
      command: "echo restarted",
    });
    expect(status).toBe(200);
    expect((data as any).name).toBe("reuse-me");
    expect((data as any).pid).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 300));
  });
});

// ──────────────────────────────────────────
// Process stream edge cases
// ──────────────────────────────────────────

describe("process-stream edge cases", () => {
  it("backfills from ring buffer with afterSeq filter", async () => {
    await post("/process-start", {
      name: "backfill-test",
      command: "echo line1 && echo line2 && sleep 0.5",
    });
    await new Promise((r) => setTimeout(r, 300));

    // Request with afterSeq=0 should get all buffered output
    const res = await fetch(`${Base}/process-stream/backfill-test?afterSeq=0`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: any[] = [];

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* skip */
          }
        }
      }
      if (events.some((e) => e.type === "exit")) break;
    }
    reader.cancel().catch(() => {});

    // Should have stdout events with seq numbers
    const stdoutEvents = events.filter((e) => e.type === "stdout" || e.type === "stderr");
    expect(stdoutEvents.length).toBeGreaterThan(0);
    for (const e of stdoutEvents) {
      expect(e.seq).toBeGreaterThan(0);
    }
  });

  it("sends exit event immediately for already-exited process", async () => {
    await post("/process-start", {
      name: "already-done",
      command: "echo quick",
    });
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${Base}/process-stream/already-done?afterSeq=0`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: any[] = [];

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* skip */
          }
        }
      }
      if (events.some((e) => e.type === "exit")) break;
    }
    reader.cancel().catch(() => {});

    const exitEvent = events.find((e) => e.type === "exit");
    expect(exitEvent).toBeTruthy();
    expect(exitEvent.code).toBe(0);
  });
});

// ──────────────────────────────────────────
// Env sanitization
// ──────────────────────────────────────────

describe("env sanitization", () => {
  beforeEach(skipIfNoPty);
  it("filters out sensitive env vars from exec", async () => {
    // Inject a sensitive key via init
    await post("/init", {
      envVars: {
        AWS_SECRET_ACCESS_KEY: "supersecret",
        SAFE_VAR: "visible",
      },
    });

    const { data } = await post("/exec", {
      command: "echo AWS=$AWS_SECRET_ACCESS_KEY SAFE=$SAFE_VAR",
    });
    const stdout = (data as any).stdout;
    // Sensitive key should be stripped
    expect(stdout).not.toContain("supersecret");
    // Safe key should be present
    expect(stdout).toContain("visible");
  });

  it("filters all SENSITIVE_KEYS", async () => {
    await post("/init", {
      envVars: {
        AWS_ACCESS_KEY_ID: "akid",
        AWS_SECRET_ACCESS_KEY: "asak",
        R2_ACCOUNT_ID: "r2id",
        R2_BUCKET_NAME: "r2bucket",
        ENCRYPTION_KEY: "enckey",
      },
    });

    const { data } = await post("/exec", {
      command:
        'echo "AKID=$AWS_ACCESS_KEY_ID ASAK=$AWS_SECRET_ACCESS_KEY R2ID=$R2_ACCOUNT_ID R2B=$R2_BUCKET_NAME ENC=$ENCRYPTION_KEY"',
    });
    const stdout = (data as any).stdout;
    expect(stdout).not.toContain("akid");
    expect(stdout).not.toContain("asak");
    expect(stdout).not.toContain("r2id");
    expect(stdout).not.toContain("r2bucket");
    expect(stdout).not.toContain("enckey");
  });
});

// ──────────────────────────────────────────
// Init edge cases
// ──────────────────────────────────────────

describe("init edge cases", () => {
  beforeEach(skipIfNoPty);
  it("merges env vars across multiple init calls", async () => {
    await post("/init", { envVars: { VAR_A: "aaa" } });
    await post("/init", { envVars: { VAR_B: "bbb" } });

    const { data } = await post("/exec", {
      command: "echo A=$VAR_A B=$VAR_B",
    });
    const stdout = (data as any).stdout;
    expect(stdout).toContain("aaa");
    expect(stdout).toContain("bbb");
  });

  it("overwrites env vars on re-init", async () => {
    await post("/init", { envVars: { OVER: "old" } });
    await post("/init", { envVars: { OVER: "new" } });

    const { data } = await post("/exec", {
      command: "echo OVER=$OVER",
    });
    expect((data as any).stdout).toContain("new");
  });

  it("creates workspace directory on init", async () => {
    const ws = `/tmp/sandbox-test-init-${Date.now()}`;
    await post("/init", { workspace: ws });

    const { data } = await post("/exec", {
      command: `test -d ${ws} && echo exists`,
    });
    expect((data as any).stdout).toContain("exists");
  });
});

// ──────────────────────────────────────────
// Exec edge cases
// ──────────────────────────────────────────

describe("exec edge cases", () => {
  beforeEach(skipIfNoPty);
  it("returns non-zero exit code for failing command", async () => {
    const { data } = await post("/exec", {
      command: "exit 42",
    });
    expect((data as any).exitCode).toBe(42);
  });

  it("captures stderr-like output from pty", async () => {
    // PTY merges stdout/stderr — server returns all as stdout
    const { data } = await post("/exec", {
      command: "echo errout >&2",
    });
    // PTY merges into stdout
    expect((data as any).stdout).toContain("errout");
  });
});

// ──────────────────────────────────────────
// Session output tracking
// ──────────────────────────────────────────

describe("session output tracking", () => {
  beforeEach(skipIfNoPty);
  it("tracks pending buffer between polls", async () => {
    const { data: startData } = await post("/session-start", {
      command: "echo first && sleep 0.3 && echo second && sleep 10",
    });
    const sid = (startData as any).sessionId;

    // First poll captures "first"
    await new Promise((r) => setTimeout(r, 200));
    const { data: poll1 } = await post("/session-poll", {
      sessionId: sid,
    });
    const pending1 = (poll1 as any).pending;

    // Second poll after more output should have "second"
    await new Promise((r) => setTimeout(r, 400));
    const { data: poll2 } = await post("/session-poll", {
      sessionId: sid,
    });
    const pending2 = (poll2 as any).pending;

    // At least one of the polls should have captured output
    expect(pending1.length + pending2.length).toBeGreaterThan(0);

    await post("/session-kill", { sessionId: sid });
  });

  it("tail returns most recent output", async () => {
    const { data: startData } = await post("/session-start", {
      command: 'for i in $(seq 1 100); do echo "line-$i"; done',
    });
    const sid = (startData as any).sessionId;
    await new Promise((r) => setTimeout(r, 500));

    const { data: pollData } = await post("/session-poll", {
      sessionId: sid,
    });
    const tail = (pollData as any).tail;
    // Tail should contain the last lines, not necessarily all 100
    expect(tail).toContain("line-100");
  });
});

// ──────────────────────────────────────────
// Session log edge cases
// ──────────────────────────────────────────

describe("session-log edge cases", () => {
  beforeEach(skipIfNoPty);
  it("returns full log when tail is not specified", async () => {
    const { data: startData } = await post("/session-start", {
      command: 'echo "full-log-line-1" && echo "full-log-line-2"',
    });
    const sid = (startData as any).sessionId;
    await new Promise((r) => setTimeout(r, 500));

    const { status, text } = await getText(`/session-log/${sid}`);
    expect(status).toBe(200);
    expect(text).toContain("full-log-line-1");
    expect(text).toContain("full-log-line-2");
  });

  it("tail=1 returns only last line", async () => {
    const { data: startData } = await post("/session-start", {
      command: 'echo "first" && echo "second" && echo "third"',
    });
    const sid = (startData as any).sessionId;
    await new Promise((r) => setTimeout(r, 500));

    const { text } = await getText(`/session-log/${sid}?tail=1`);
    // Should not contain "first" since we only asked for 1 line
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});

// ──────────────────────────────────────────
// Health with sessions
// ──────────────────────────────────────────

describe("health with sessions", () => {
  it("reports process count accurately", async () => {
    // Start a process
    await post("/process-start", {
      name: "health-count",
      command: "sleep 30",
    });

    const { data } = await get("/health");
    expect((data as any).processes).toBeGreaterThanOrEqual(1);

    await post("/process-stop", { name: "health-count" });
  });

  it("reports workspace path", async () => {
    const ws = `/tmp/health-ws-${Date.now()}`;
    await post("/init", { workspace: ws });

    const { data } = await get("/health");
    expect((data as any).workspace).toBe(ws);
  });
});
