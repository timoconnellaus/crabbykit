#!/usr/bin/env bun
/**
 * Serial coverage runner for the pre-commit hook.
 *
 * The root `test:coverage` script fans out via `bun run --filter '*'`,
 * which runs every workspace's `test:coverage` in parallel. That works
 * in CI (one machine per job) but on a dev machine it starves workerd
 * of loopback ports — every `@cloudflare/vitest-pool-workers` package
 * spins up its own miniflare instance at the same time and they race
 * on ephemeral port allocation, producing
 * `EADDRNOTAVAIL 127.0.0.1:N` hangs and `connect(): Connection refused`
 * fallback-service errors that look like test failures but are pure
 * resource contention.
 *
 * This script walks the workspace globs and invokes each package's
 * `test:coverage` sequentially, exiting non-zero on the first failure.
 * Packages without a `test:coverage` script are skipped silently.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const WORKSPACE_GLOBS = [
  join(repoRoot, "packages"),
  join(repoRoot, "examples"),
  join(repoRoot, "e2e"),
  join(repoRoot, "spike"),
];

interface Pkg {
  name: string;
  dir: string;
}

function collectPackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const base of WORKSPACE_GLOBS) {
    if (!safeIsDir(base)) continue;
    for (const entry of readdirSync(base)) {
      const entryPath = join(base, entry);
      if (!safeIsDir(entryPath)) continue;
      const direct = tryReadPackageJson(entryPath);
      if (direct) {
        out.push({ name: direct.name, dir: entryPath });
        continue;
      }
      for (const sub of readdirSync(entryPath)) {
        const subPath = join(entryPath, sub);
        if (!safeIsDir(subPath)) continue;
        const nested = tryReadPackageJson(subPath);
        if (nested) out.push({ name: nested.name, dir: subPath });
      }
    }
  }
  return out;
}

function tryReadPackageJson(
  dir: string,
): { name: string; scripts?: Record<string, string> } | null {
  const pkgPath = join(dir, "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    if (typeof parsed.name !== "string") return null;
    if (!parsed.scripts || typeof parsed.scripts["test:coverage"] !== "string") return null;
    return { name: parsed.name, scripts: parsed.scripts };
  } catch {
    return null;
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const packages = collectPackages();
console.log(`[test-coverage-serial] running ${packages.length} package(s) sequentially`);

function reapWorkerd(): void {
  // vitest-pool-workers sometimes leaks workerd children on crash or
  // coverage-instrumented test failure; leaked children hold loopback
  // ports and poison the next package's miniflare startup with
  // `EADDRNOTAVAIL` / `connect(): Connection refused`. Sweep between
  // packages so each run starts from a clean port table.
  //
  // Scope the kill to workerd binaries under THIS repo's node_modules
  // so parallel work on other Cloudflare projects on the same host
  // isn't collaterally nuked. The workerd binary path always contains
  // the repo root because bun installs package binaries under
  // `<repo>/node_modules/.bun/@cloudflare+workerd-*/…/bin/workerd`.
  try {
    execSync(`pkill -9 -f '^${repoRoot}/node_modules/.*/workerd '`, { stdio: "ignore" });
  } catch {
    // pkill exits 1 when no processes match — expected on clean runs.
  }
  // Brief pause for kernel to reclaim the ports into the ephemeral pool
  // before the next miniflare instance grabs a fresh batch. Without
  // this, TIME_WAIT entries accumulate across 30+ sequential packages
  // and the last-run package (usually agent-runtime, which spins up
  // many DOs) trips `EADDRNOTAVAIL` even though no workerd is alive.
  execSync("sleep 2");
}

function runPackage(pkg: Pkg): boolean {
  try {
    execSync("bun run test:coverage", { cwd: pkg.dir, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

const MAX_ATTEMPTS = 3;

let failed = 0;
for (const pkg of packages) {
  reapWorkerd();
  console.log(`\n── ${pkg.name} ──`);
  let ok = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // Extend the reap/sleep window on each retry. vitest-pool-workers
      // + miniflare startup flakes on `EADDRNOTAVAIL` / fallback-service
      // disconnects when the host has just finished 30+ pool-worker
      // packages back-to-back; real test-logic failures reproduce
      // deterministically on the retry, so progressively longer cooldown
      // keeps the hook reliable without masking bugs.
      console.warn(
        `[test-coverage-serial] ${pkg.name} attempt ${attempt - 1}/${MAX_ATTEMPTS} failed — cooling down`,
      );
      reapWorkerd();
      execSync(`sleep ${attempt * 3}`);
    }
    if (runPackage(pkg)) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    failed++;
    console.error(`[test-coverage-serial] FAIL: ${pkg.name} (after ${MAX_ATTEMPTS} attempts)`);
  }
}
reapWorkerd();

if (failed > 0) {
  console.error(`\n[test-coverage-serial] ${failed} package(s) failed`);
  process.exit(1);
}
console.log("\n[test-coverage-serial] all packages passed");
