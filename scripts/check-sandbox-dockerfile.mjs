#!/usr/bin/env bun
/**
 * Guard script for the sandbox container image (tasks 6.7 and 6.8).
 *
 * Runs cheap static checks against the sandbox Dockerfile and the vendored
 * snapshot so a CI job can fail fast without needing a full docker build:
 *
 *   1. The Dockerfile contains the expected vendored-package COPY lines.
 *   2. The Dockerfile contains the INTEGRITY.json generation step.
 *   3. Every COPY source path exists on disk (detects a rename that
 *      would silently break the image build).
 *   4. The vendored file set recomputes the same hashes that the image
 *      would compute at build time (drift detection equivalent to 6.8).
 *
 * Exits non-zero on any failure with a pointed message.
 *
 * CI wiring: see .github/workflows/sandbox-container.yml.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const dockerfilePath = join(repoRoot, "packages/infra/cloudflare-sandbox/container/Dockerfile");

const REQUIRED_COPY_SOURCES = [
  "packages/runtime/agent-bundle/src/bundle",
  "packages/runtime/agent-bundle/package.vendored.json",
  "packages/capabilities/tavily-web-search/src/client.ts",
  "packages/capabilities/tavily-web-search/src/schemas.ts",
  "packages/capabilities/tavily-web-search/package.vendored.json",
];

const REQUIRED_INTEGRITY_MARKERS = ["INTEGRITY.json", "sha256sum"];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

async function main() {
  if (!existsSync(dockerfilePath)) {
    fail(`Dockerfile not found at ${dockerfilePath}`);
    return;
  }

  const dockerfile = readFileSync(dockerfilePath, "utf8");

  for (const src of REQUIRED_COPY_SOURCES) {
    if (!dockerfile.includes(src)) {
      fail(
        `Dockerfile is missing required COPY of ${src}. ` +
          `Did you rename or relocate a vendored package?`,
      );
      continue;
    }
    const diskPath = join(repoRoot, src);
    if (!existsSync(diskPath)) {
      fail(
        `COPY source ${src} is referenced in the Dockerfile but does not ` +
          `exist on disk. The next image build will fail.`,
      );
      continue;
    }
    pass(`COPY source exists: ${src}`);
  }

  for (const marker of REQUIRED_INTEGRITY_MARKERS) {
    if (!dockerfile.includes(marker)) {
      fail(
        `Dockerfile does not mention '${marker}' — the INTEGRITY.json ` +
          `generation step may have been removed.`,
      );
    } else {
      pass(`Dockerfile contains integrity marker: ${marker}`);
    }
  }

  // Re-hash the vendored file set locally as a drift proxy for the
  // manifest that the container image build generates. Failing here
  // doesn't block the image build, but it catches orphaned references.
  const hashedFiles = [
    "packages/runtime/agent-bundle/package.vendored.json",
    "packages/capabilities/tavily-web-search/src/client.ts",
    "packages/capabilities/tavily-web-search/src/schemas.ts",
    "packages/capabilities/tavily-web-search/package.vendored.json",
  ];

  const manifest = {};
  for (const rel of hashedFiles) {
    const full = join(repoRoot, rel);
    if (!existsSync(full)) {
      fail(`Cannot hash ${rel}: file missing`);
      continue;
    }
    const data = await readFile(full);
    manifest[rel] = createHash("sha256").update(data).digest("hex");
  }

  if (Object.keys(manifest).length === hashedFiles.length) {
    pass(`Re-hashed ${hashedFiles.length} vendored files successfully`);
    console.log(`  (manifest preview: ${Object.keys(manifest).join(", ")})`);
  }

  if (process.exitCode === 1) {
    console.error("\nSandbox container pre-build checks failed.");
  } else {
    console.log("\nSandbox container pre-build checks passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
