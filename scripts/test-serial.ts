#!/usr/bin/env bun
/**
 * Serial test runner for git hooks.
 *
 * `bun run --filter '*' <script>` fans out every workspace in parallel.
 * That works in CI (one machine per job) but on a dev machine 30+
 * simultaneous `@cloudflare/vitest-pool-workers` packages starve workerd
 * of loopback ports — they race on ephemeral port allocation, producing
 * `EADDRNOTAVAIL 127.0.0.1:N` hangs and `connect(): Connection refused`
 * fallback-service errors that look like test failures but are pure
 * resource contention.
 *
 * This script takes a script name as argv[2] (e.g. `test` or
 * `test:coverage`), walks the workspace globs, and invokes each
 * package's matching script sequentially. Packages without that
 * script are skipped. Failing packages retry up to three times with
 * progressively longer cooldowns to shake off infra flakes — real
 * test-logic failures reproduce deterministically.
 *
 * Between packages it sweeps leaked workerd children with a
 * repo-scoped pkill -f (matching only
 * <repo>/node_modules/(any)/workerd) so parallel work on other
 * Cloudflare projects on the same host isn't collaterally killed.
 */

import { execSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptName = process.argv[2];
if (!scriptName) {
  console.error("usage: test-serial.ts <script-name>  (e.g. test, test:coverage)");
  process.exit(2);
}

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

function tryReadPackageJson(dir: string): { name: string } | null {
  const pkgPath = join(dir, "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    if (typeof parsed.name !== "string") return null;
    if (!parsed.scripts || typeof parsed.scripts[scriptName] !== "string") return null;
    return { name: parsed.name };
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

// Order: heavy pool-workers packages FIRST while the loopback TIME_WAIT
// table is empty. By the 30th package, ~1000+ TIME_WAIT entries have
// accumulated on 127.0.0.1 and miniflare startup starts failing with
// `EADDRNOTAVAIL 127.0.0.1:N` even after workerd reaping. The packages
// with the largest test suites (agent-runtime, bundle-registry,
// bundle-host, bundle-sdk) are the most sensitive, so run them early.
const HEAVY_FIRST = [
  "@crabbykit/agent-runtime",
  "@crabbykit/bundle-registry",
  "@crabbykit/bundle-host",
  "@crabbykit/bundle-sdk",
];
function packageOrder(a: Pkg, b: Pkg): number {
  const ai = HEAVY_FIRST.indexOf(a.name);
  const bi = HEAVY_FIRST.indexOf(b.name);
  if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

const packages = collectPackages().sort(packageOrder);
console.log(`[test-serial ${scriptName}] running ${packages.length} package(s) sequentially`);

function reapWorkerd(): void {
  // vitest-pool-workers sometimes leaks workerd children on crash or
  // test failure; leaked children hold loopback ports and poison the
  // next package's miniflare startup with `EADDRNOTAVAIL` /
  // `connect(): Connection refused`. Sweep between packages so each
  // run starts from a clean port table.
  //
  // Scope the kill to workerd binaries under THIS repo's node_modules
  // so parallel work on other Cloudflare projects on the same host
  // isn't collaterally nuked. The workerd binary path always contains
  // the repo root because bun installs package binaries under
  // `<repo>/node_modules/.bun/@cloudflare+workerd-*/.../bin/workerd`.
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
  // Route through `/bin/bash -c` rather than `execSync`ing bun directly.
  // execSync-from-bun inherits the parent bun process's open file
  // descriptors, including its sockets, into the child bun. miniflare
  // then sees an already-strained fd table and trips `EADDRNOTAVAIL`
  // on fresh loopback binds even when workerd has been reaped and the
  // TIME_WAIT pool is clean. Going via bash breaks the fd inheritance
  // chain: the child bun starts with a fresh table.
  const res = spawnSync("/bin/bash", ["-c", `bun run ${scriptName}`], {
    cwd: pkg.dir,
    stdio: "inherit",
  });
  return res.status === 0;
}

const MAX_ATTEMPTS = 3;

let failed = 0;
for (const pkg of packages) {
  reapWorkerd();
  console.log(`\n── ${pkg.name} (${scriptName}) ──`);
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
        `[test-serial ${scriptName}] ${pkg.name} attempt ${attempt - 1}/${MAX_ATTEMPTS} failed — cooling down`,
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
    console.error(`[test-serial ${scriptName}] FAIL: ${pkg.name} (after ${MAX_ATTEMPTS} attempts)`);
  }
}
reapWorkerd();

if (failed > 0) {
  console.error(`\n[test-serial ${scriptName}] ${failed} package(s) failed`);
  process.exit(1);
}
console.log(`\n[test-serial ${scriptName}] all packages passed`);
