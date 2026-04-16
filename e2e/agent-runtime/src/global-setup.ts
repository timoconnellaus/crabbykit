/**
 * Global setup/teardown for wrangler-dev-based e2e tests.
 *
 * Cleans the .wrangler directory, starts `wrangler dev`, waits for
 * the server to be ready, then tears it down after all tests complete.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_DIR = resolve(import.meta.dirname, "..");
const WRANGLER_DIR = resolve(PROJECT_DIR, ".wrangler");
const PORT = 8787;
const BASE_URL = `http://localhost:${PORT}`;
const READY_TIMEOUT_MS = 120_000; // containers can take a while to build/start

let wranglerProcess: ChildProcess | undefined;

async function waitForReady(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
}

export async function setup() {
  // Clean .wrangler directory for a fresh state
  if (existsSync(WRANGLER_DIR)) {
    rmSync(WRANGLER_DIR, { recursive: true, force: true });
  }

  // Start wrangler dev with the dev config
  wranglerProcess = spawn(
    "npx",
    ["wrangler", "dev", "--config", "wrangler.dev.jsonc", "--port", String(PORT)],
    {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );

  // Log wrangler output for debugging
  wranglerProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  wranglerProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler:err] ${line}`);
  });

  wranglerProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[wrangler] exited with code ${code}`);
    }
  });

  await waitForReady();
  console.log(`[e2e] wrangler dev ready on ${BASE_URL}`);
}

export async function teardown() {
  if (wranglerProcess) {
    wranglerProcess.kill("SIGTERM");
    // Give it a moment to clean up
    await new Promise((r) => setTimeout(r, 1000));
    if (!wranglerProcess.killed) {
      wranglerProcess.kill("SIGKILL");
    }
    wranglerProcess = undefined;
  }
}
