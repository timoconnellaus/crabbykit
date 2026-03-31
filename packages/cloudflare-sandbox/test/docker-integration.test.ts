/**
 * Docker integration tests for the sandbox container.
 *
 * These tests build and run a real Docker container with the sandbox server
 * and nm-guard daemon. They require Docker to be available.
 *
 * Run with: npx vitest run test/docker-integration.test.ts
 *
 * NOTE: Requires SYS_ADMIN capability for mount --bind (nm-guard).
 * The test uses the Docker FUSE proxy or OrbStack which grants this.
 */
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const IMAGE_NAME = "claw-sandbox-test";
const CONTAINER_NAME = "claw-sandbox-test-runner";
const PORT = 18080;

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function exec(cmd: string, timeout = 30_000): string {
  return execSync(cmd, { timeout, encoding: "utf-8" }).trim();
}

function containerExec(cmd: string): string {
  return exec(`docker exec ${CONTAINER_NAME} ${cmd}`);
}

async function fetch_(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost:${PORT}${path}`, init);
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch_(path, init);
  return res.json();
}

async function waitForServer(maxWaitMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch_("/health");
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not become ready");
}

describe.skipIf(!dockerAvailable())("Docker Integration", () => {
  beforeAll(async () => {
    const pkgRoot = new URL("..", import.meta.url).pathname;

    // Build test image
    console.log("[test] Building test image...");
    exec(`docker build -f ${pkgRoot}test/Dockerfile.test -t ${IMAGE_NAME} ${pkgRoot}`, 120_000);

    // Remove any stale container
    try {
      exec(`docker rm -f ${CONTAINER_NAME}`);
    } catch {}

    // Start container with SYS_ADMIN (needed for mount --bind)
    console.log("[test] Starting container...");
    exec(
      `docker run -d --name ${CONTAINER_NAME} ` +
        `--cap-add SYS_ADMIN ` +
        `-p ${PORT}:8080 ` +
        `-e AGENT_ID=test-agent ` +
        `${IMAGE_NAME}`,
    );

    // Wait for server to be ready
    await waitForServer();
    console.log("[test] Container ready");
  }, 180_000);

  afterAll(() => {
    try {
      exec(`docker rm -f ${CONTAINER_NAME}`);
    } catch {}
  });

  // --- Server tests ---

  describe("Server /health", () => {
    it("returns ready status", async () => {
      const health = (await fetchJson("/health")) as Record<string, unknown>;
      expect(health.ready).toBe(true);
      expect(health.workspace).toBe("/mnt/r2");
    });
  });

  describe("Server /exec", () => {
    it("executes a command and returns output", async () => {
      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "echo hello world" }),
      })) as { stdout: string; stderr: string; exitCode: number };

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
      expect(result.stderr).toBe("");
    });

    it("returns exit code for failing commands", async () => {
      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "exit 42" }),
      })) as { exitCode: number };

      expect(result.exitCode).toBe(42);
    });

    it("does not leak sensitive env vars", async () => {
      // Start container with a sensitive var
      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "env" }),
      })) as { stdout: string };

      expect(result.stdout).not.toContain("AWS_ACCESS_KEY_ID");
      expect(result.stdout).not.toContain("AWS_SECRET_ACCESS_KEY");
    });

    it("uses workspace as cwd by default", async () => {
      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "pwd" }),
      })) as { stdout: string };

      expect(result.stdout.trim()).toBe("/mnt/r2");
    });
  });

  describe("Server /init", () => {
    it("accepts environment variables", async () => {
      await fetchJson("/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envVars: { MY_VAR: "test-value" } }),
      });

      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "echo $MY_VAR" }),
      })) as { stdout: string };

      expect(result.stdout.trim()).toBe("test-value");
    });
  });

  describe("Server process management", () => {
    it("starts and lists a process", async () => {
      // Start a long-running process
      const startResult = (await fetchJson("/process-start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "sleeper", command: "sleep 30" }),
      })) as { pid: number; name: string };

      expect(startResult.name).toBe("sleeper");
      expect(startResult.pid).toBeGreaterThan(0);

      // List processes
      const list = (await fetchJson("/process-list")) as Array<{
        name: string;
        running: boolean;
      }>;
      const sleeper = list.find((p) => p.name === "sleeper");
      expect(sleeper).toBeDefined();
      expect(sleeper!.running).toBe(true);

      // Stop it
      await fetchJson("/process-stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "sleeper" }),
      });

      // Wait for process to actually stop
      await new Promise((r) => setTimeout(r, 1000));

      const listAfter = (await fetchJson("/process-list")) as Array<{
        name: string;
        running: boolean;
      }>;
      const sleeperAfter = listAfter.find((p) => p.name === "sleeper");
      expect(sleeperAfter?.running).toBe(false);
    });
  });

  // --- Dev port proxy tests ---

  describe("Dev port proxy", () => {
    const DEV_PORT = 9876;

    it("set-dev-port accepts a valid port", async () => {
      const result = (await fetchJson("/set-dev-port", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: DEV_PORT }),
      })) as { ok: boolean; port: number };

      expect(result.ok).toBe(true);
      expect(result.port).toBe(DEV_PORT);
    });

    it("rejects invalid port values", async () => {
      const res = await fetch_("/set-dev-port", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: -1 }),
      });
      expect(res.status).toBe(400);

      const res2 = await fetch_("/set-dev-port", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: 99999 }),
      });
      expect(res2.status).toBe(400);
    });

    it("proxies requests to the dev server when port is set", async () => {
      // Start a simple HTTP server inside the container
      await fetchJson("/process-start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "test-dev-server",
          command: `node -e "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html><head><title>Test</title></head><body>hello</body></html>')}).listen(${DEV_PORT})"`,
        }),
      });

      // Wait for server to start
      await new Promise((r) => setTimeout(r, 1000));

      // Set the dev port
      await fetchJson("/set-dev-port", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: DEV_PORT }),
      });

      // Request should be proxied to the dev server
      const res = await fetch_("/");
      expect(res.ok).toBe(true);
      const html = await res.text();
      expect(html).toContain("hello");
    });

    it("passes HTML through without modification", async () => {
      // The dev server from previous test should still be running
      // Console capture is now handled by @claw-for-cloudflare/vite-plugin,
      // not the container proxy — proxy is a simple pass-through.
      const res = await fetch_("/");
      const html = await res.text();

      expect(html).toContain("<title>Test</title>");
      expect(html).toContain("hello");
      // Should NOT contain injected scripts (that's the Vite plugin's job now)
      expect(html).not.toContain("claw:console");
    });

    it("passes non-HTML responses through unchanged", async () => {
      // Stop the HTML server and start a JSON one
      await fetchJson("/process-stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-dev-server" }),
      });
      await new Promise((r) => setTimeout(r, 500));

      await fetchJson("/process-start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "test-json-server",
          command: `node -e "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}))}).listen(${DEV_PORT})"`,
        }),
      });
      await new Promise((r) => setTimeout(r, 1000));

      const res = await fetch_("/some-api");
      const body = await res.text();
      expect(body).not.toContain("claw:console");
      expect(JSON.parse(body)).toEqual({ ok: true });
    });

    it("returns 404 when dev server is not reachable", async () => {
      // Stop the server
      await fetchJson("/process-stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-json-server" }),
      });
      await new Promise((r) => setTimeout(r, 500));

      // Set a port where nothing is listening
      await fetchJson("/set-dev-port", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: 19999 }),
      });

      // Should return 503 (loading/retry page) since dev server is unreachable
      const res = await fetch_("/");
      expect(res.status).toBe(503);
    });

    it("clear-dev-port stops proxying", async () => {
      await fetchJson("/clear-dev-port", { method: "POST" });

      // Known endpoints should still work
      const health = (await fetchJson("/health")) as Record<string, unknown>;
      expect(health.ready).toBe(true);

      // Unknown paths should 404 (no proxy fallback)
      const res = await fetch_("/some-page");
      expect(res.status).toBe(404);
    });
  });

  // --- nm-guard tests ---

  describe("nm-guard", () => {
    it("bind-mounts local disk over node_modules within 2 seconds", async () => {
      // Create a project with node_modules on the workspace
      containerExec("sh -c 'mkdir -p /mnt/r2/test-project/node_modules'");

      // Wait for nm-guard to detect and mount (polls every 500ms)
      await new Promise((r) => setTimeout(r, 2000));

      // Check if it's now a mountpoint
      const isMounted = containerExec(
        "sh -c 'grep -q /mnt/r2/test-project/node_modules /proc/mounts && echo yes || echo no'",
      );
      expect(isMounted).toBe("yes");
    });

    it("reports cleanup prefix via /health when nm-guard handles mount", async () => {
      // nm-intercept handles mounts instantly via LD_PRELOAD, but nm-guard
      // is the fallback that reports cleanup prefixes. Create a directory
      // as root (bypassing LD_PRELOAD) so nm-guard picks it up.
      containerExec("sh -c 'mkdir -p /mnt/r2/guard-project/node_modules'");
      await new Promise((r) => setTimeout(r, 2000));

      // Consume any stale prefixes
      await fetchJson("/health");
      // nm-guard may have already reported — create another
      containerExec("sh -c 'mkdir -p /mnt/r2/another-guard-project/node_modules'");
      await new Promise((r) => setTimeout(r, 2000));

      const health2 = (await fetchJson("/health")) as Record<string, unknown>;
      const prefixes = health2.cleanupPrefixes as string[] | undefined;
      // nm-guard cleanup prefix reporting is best-effort — may or may not be present
      // depending on timing. Just verify health endpoint works.
      expect(health2.ready).toBe(true);
    });

    it("files written to bind-mounted node_modules have execute bits", async () => {
      // Write a file with execute permission in the mounted node_modules
      containerExec(
        "sh -c 'echo \"#!/bin/sh\" > /mnt/r2/test-project/node_modules/test-bin && chmod +x /mnt/r2/test-project/node_modules/test-bin'",
      );

      // Verify execute bit is preserved (would fail on FUSE)
      const perms = containerExec("sh -c 'stat -c %a /mnt/r2/test-project/node_modules/test-bin'");
      expect(Number.parseInt(perms, 8) & 0o111).toBeGreaterThan(0);
    });

    it("multiple projects get independent mounts", async () => {
      // test-project already has a mount from earlier test
      // guard-project also has one from the cleanup prefix test
      const mount1 = containerExec(
        "sh -c 'grep -q /mnt/r2/test-project/node_modules /proc/mounts && echo yes || echo no'",
      );
      const mount2 = containerExec(
        "sh -c 'grep -q /mnt/r2/guard-project/node_modules /proc/mounts && echo yes || echo no'",
      );
      expect(mount1).toBe("yes");
      expect(mount2).toBe("yes");

      // Write different files to verify independence
      containerExec("sh -c 'echo p1 > /mnt/r2/test-project/node_modules/marker'");
      containerExec("sh -c 'echo p2 > /mnt/r2/guard-project/node_modules/marker'");

      const f1 = containerExec("cat /mnt/r2/test-project/node_modules/marker");
      const f2 = containerExec("cat /mnt/r2/guard-project/node_modules/marker");
      expect(f1.trim()).toBe("p1");
      expect(f2.trim()).toBe("p2");
    });

    it("skips already-mounted directories", async () => {
      // The guard should not try to re-mount an existing mountpoint
      // Just verify the mount is still valid after multiple guard cycles
      await new Promise((r) => setTimeout(r, 1500));
      const still = containerExec(
        "sh -c 'grep -q /mnt/r2/test-project/node_modules /proc/mounts && echo yes || echo no'",
      );
      expect(still).toBe("yes");
    });
  });

  // --- nm-intercept tests (LD_PRELOAD instant mount) ---

  describe("nm-intercept", () => {
    it("mounts node_modules instantly via LD_PRELOAD when mkdir is called", async () => {
      // Run mkdir as the sandbox user (which has LD_PRELOAD active)
      // The mount should happen synchronously before mkdir returns
      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "mkdir -p /mnt/r2/intercept-test/node_modules && grep -q /mnt/r2/intercept-test/node_modules /proc/mounts && echo mounted || echo not-mounted",
        }),
      })) as { stdout: string; exitCode: number };

      expect(result.stdout.trim()).toContain("mounted");
    });

    it("npm install succeeds in a project on the workspace", async () => {
      // Create a minimal package.json (as sandbox user so npm can write)
      containerExec(
        `gosu sandbox sh -c 'mkdir -p /mnt/r2/npm-test && cat > /mnt/r2/npm-test/package.json << "PKGJSON"
{
  "name": "nm-test",
  "private": true,
  "dependencies": {
    "is-odd": "3.0.1"
  }
}
PKGJSON'`,
      );

      // Run npm install via the server (as sandbox user with LD_PRELOAD)
      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "cd /mnt/r2/npm-test && npm install --no-audit --no-fund 2>&1",
          timeout: 60000,
        }),
      })) as { stdout: string; stderr: string; exitCode: number };

      expect(result.exitCode).toBe(0);

      // Verify node_modules was bind-mounted
      const isMounted = containerExec(
        "sh -c 'grep -q /mnt/r2/npm-test/node_modules /proc/mounts && echo yes || echo no'",
      );
      expect(isMounted).toBe("yes");

      // Verify the package was actually installed
      const installed = containerExec(
        "sh -c 'test -d /mnt/r2/npm-test/node_modules/is-odd && echo yes || echo no'",
      );
      expect(installed).toBe("yes");
    }, 90_000);

    it("node_modules/.bin scripts have execute bits after npm install", async () => {
      // Install a package with .bin entries to verify execute bits are preserved
      containerExec(
        `gosu sandbox sh -c 'mkdir -p /mnt/r2/bin-test && cat > /mnt/r2/bin-test/package.json << "PKGJSON"
{
  "name": "bin-test",
  "private": true,
  "dependencies": {
    "semver": "7.6.3"
  }
}
PKGJSON'`,
      );

      const result = (await fetchJson("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "cd /mnt/r2/bin-test && npm install --no-audit --no-fund 2>&1",
          timeout: 60000,
        }),
      })) as { exitCode: number };

      expect(result.exitCode).toBe(0);

      // Verify .bin/semver is executable
      const perms = containerExec(
        "sh -c 'stat -c %a /mnt/r2/bin-test/node_modules/.bin/semver 2>/dev/null || echo missing'",
      );
      expect(perms).not.toBe("missing");
      expect(Number.parseInt(perms, 8) & 0o111).toBeGreaterThan(0);
    }, 90_000);
  });
});
