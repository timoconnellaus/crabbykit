#!/usr/bin/env bun
/**
 * Dependency-direction lint for the role-based packages/ layout.
 *
 * Every workspace package lives under one of the six role buckets:
 *
 *   packages/runtime/*      — the agent engine and bundle plumbing
 *   packages/infra/*        — native-binding-holding providers
 *   packages/capabilities/* — brain-facing tools and hooks
 *   packages/channels/*     — input surfaces
 *   packages/federation/*   — multi-agent coordination
 *   packages/ui/*           — client-side React
 *   packages/dev/*          — build / dev tooling
 *
 * The buckets encode a directed dependency graph. See
 * openspec/specs/workspace-layout/spec.md (ADDED in the
 * `reorganize-packages-by-role` change) for the full rule table.
 * This script enforces the rules by statically walking every
 * TypeScript source file under `packages/<bucket>/<name>/src` and
 * `.../test`, extracting `@claw-for-cloudflare/*` import specifiers
 * with a regex, resolving each to a target bucket via the filesystem
 * layout, and failing on any forbidden edge.
 *
 * Type-only imports (`import type { ... } from "..."` and
 * `export type { ... } from "..."`) are ALLOWED across any bucket
 * boundary. The rationale: type imports are erased at build time and
 * describe contracts, not runtime edges. A capability that exports an
 * interface describing "what a provider must implement" is a type
 * contract, and infra code that uses that interface to constrain its
 * own shape is a contract consumer, not a runtime dependent. Forcing
 * a contract type into a separate "contracts" package would multiply
 * package count without adding clarity.
 *
 * Value imports (plain `import { ... }`, default imports, namespace
 * imports, dynamic `await import(...)`) are restricted per the bucket
 * rules with one documented exception — see EXCEPTIONS below.
 *
 * Invoked from `bun run lint`. No Biome plugin, no AST parser — package
 * names are structured enough that a regex is sufficient and keeps the
 * script dependency-free. Exits with status 1 on any violation and
 * prints each (file, source bucket, specifier, target bucket) tuple.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packagesRoot = join(repoRoot, "packages");

type Bucket = "runtime" | "infra" | "capabilities" | "channels" | "federation" | "ui" | "dev";

const BUCKETS = new Set<Bucket>([
  "runtime",
  "infra",
  "capabilities",
  "channels",
  "federation",
  "ui",
  "dev",
]);

// Allowed target buckets per source bucket. Self-imports are always
// allowed (and included explicitly for clarity). `dev/` is build-time
// only so it is exempt and is not present as a source entry below.
const ALLOWED: Record<Bucket, Set<Bucket>> = {
  runtime: new Set<Bucket>(["runtime"]),
  infra: new Set<Bucket>(["runtime", "infra"]),
  capabilities: new Set<Bucket>(["runtime", "infra", "capabilities"]),
  channels: new Set<Bucket>(["runtime", "infra", "capabilities", "channels"]),
  federation: new Set<Bucket>(["runtime", "infra", "federation"]),
  // UI packages may import transport/protocol types from
  // `runtime/agent-runtime` only (enforced additionally by the
  // per-package target check below). The bucket-level allow set
  // still lists `runtime` so that check is the second filter.
  ui: new Set<Bucket>(["runtime"]),
  // dev/ is exempt — build-time tooling imports whatever it needs.
  dev: new Set<Bucket>(["runtime", "infra", "capabilities", "channels", "federation", "ui", "dev"]),
};

// Per-bucket target allow-lists that further restrict allowed imports.
// Currently only `ui/` uses this: agent-ui may import from
// `@claw-for-cloudflare/agent-runtime` (and nothing else from runtime).
const UI_ALLOWED_RUNTIME_PACKAGES = new Set<string>(["@claw-for-cloudflare/agent-runtime"]);

// Explicit exception list for value-level cross-bucket imports that
// break the bucket rules but are deliberately tolerated because the
// underlying architectural tension is tracked in a follow-up change.
// Format: "<sourcePackage> -> <targetPackage>".
//
// - `@claw-for-cloudflare/agent-runtime` -> `@claw-for-cloudflare/a2a`:
//   The agent runtime imports A2A's executor, tool factories, and task
//   store at the value level (ClawExecutor, createCallAgentTool, etc.).
//   The proposal places `a2a` in `federation/` for taxonomic reasons —
//   "how do agents talk to each other?" — but in practice the runtime
//   hard-depends on A2A for its core call_agent / start_task tool set.
//   The follow-up change `project_a2a_first_class` (tracked in MEMORY.md)
//   will promote A2A into the runtime bucket as part of a larger
//   "A2A first-class" refactor. Until then this edge exists.
const VALUE_IMPORT_EXCEPTIONS = new Set<string>([
  "@claw-for-cloudflare/agent-runtime -> @claw-for-cloudflare/a2a",
]);

/** Build a map of @claw-for-cloudflare/<name> → bucket from the filesystem. */
function loadPackageBuckets(): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (const bucketName of readdirSync(packagesRoot)) {
    const bucketDir = join(packagesRoot, bucketName);
    if (!statSync(bucketDir).isDirectory()) continue;
    if (!BUCKETS.has(bucketName as Bucket)) continue;
    for (const pkgDirName of readdirSync(bucketDir)) {
      const pkgDir = join(bucketDir, pkgDirName);
      if (!statSync(pkgDir).isDirectory()) continue;
      const pkgJsonPath = join(pkgDir, "package.json");
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string };
        if (pkgJson.name?.startsWith("@claw-for-cloudflare/")) {
          out.set(pkgJson.name, bucketName as Bucket);
        }
      } catch {
        // Skip directories without a readable package.json.
      }
    }
  }
  return out;
}

/** Recursively list TypeScript source files under a package's src/ and test/. */
function* walkTsFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Skip dist, coverage, node_modules.
      if (entry === "dist" || entry === "coverage" || entry === "node_modules") continue;
      yield* walkTsFiles(full);
    } else if (st.isFile() && /\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

interface ClawImport {
  specifier: string;
  typeOnly: boolean;
}

/**
 * Extract every @claw-for-cloudflare/<name> import specifier from a
 * source file and classify it as type-only or value.
 *
 * Classification is line-based: the whole statement containing the
 * specifier is inspected. A line is treated as type-only if it begins
 * with `import type`, `export type`, or (for mixed imports) has NO
 * non-type binding — we approximate this by requiring the statement's
 * opening keyword sequence to be `import type` / `export type`. Mixed
 * imports like `import { type X, valueY } from "..."` are conservatively
 * treated as value imports (the stricter interpretation).
 */
function extractClawImports(source: string): ClawImport[] {
  const out: ClawImport[] = [];

  // Regex captures the leading `import`/`export`/`from` context and the
  // specifier. We use multiline mode with [\s\S] to span newlines inside
  // brace blocks. The leading-context capture lets us detect type-only.
  //
  // Pattern: optional `import ` / `export ` / bare `from ` prefix, then
  //          an optional `type` keyword, then the specifier.
  //
  // Three cases we care about:
  //   1. `import type { ... } from "..."` — typeOnly=true
  //   2. `import { ... } from "..."`        — typeOnly=false
  //   3. `export type { ... } from "..."`   — typeOnly=true (re-export)
  //   4. `export { ... } from "..."`        — typeOnly=false
  //   5. `import("...")` / `await import("...")` — typeOnly=false (dynamic)
  //
  // We match statements beginning with `import`/`export` up to the
  // specifier, and separately match dynamic imports.
  const staticRe =
    /(^|\n)\s*(import|export)(?:\s+(type))?\s+[^"'`;]*?from\s*["'](@claw-for-cloudflare\/[^"'/]+)(?:\/[^"']+)?["']/g;
  for (const m of source.matchAll(staticRe)) {
    const keyword = m[3]; // "type" if present
    out.push({ specifier: m[4], typeOnly: keyword === "type" });
  }

  const dynamicRe = /import\s*\(\s*["'](@claw-for-cloudflare\/[^"'/]+)(?:\/[^"']+)?["']/g;
  for (const m of source.matchAll(dynamicRe)) {
    out.push({ specifier: m[1], typeOnly: false });
  }

  return out;
}

/** Resolve which package a source file belongs to, returning [pkgName, bucket]. */
function resolveSourcePackage(
  filePath: string,
  buckets: Map<string, Bucket>,
): { name: string; bucket: Bucket } | null {
  const rel = relative(packagesRoot, filePath);
  const parts = rel.split("/");
  if (parts.length < 3) return null;
  const [bucketName, pkgDirName] = parts;
  if (!BUCKETS.has(bucketName as Bucket)) return null;
  const pkgJsonPath = join(packagesRoot, bucketName, pkgDirName, "package.json");
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string };
    if (!pkgJson.name) return null;
    const bucket = buckets.get(pkgJson.name);
    if (!bucket) return null;
    return { name: pkgJson.name, bucket };
  } catch {
    return null;
  }
}

interface Violation {
  file: string;
  sourceBucket: Bucket;
  sourcePackage: string;
  specifier: string;
  targetBucket: Bucket;
  rule: string;
}

function main(): number {
  const buckets = loadPackageBuckets();
  const violations: Violation[] = [];
  let filesScanned = 0;
  let importsChecked = 0;

  for (const bucketName of readdirSync(packagesRoot)) {
    if (!BUCKETS.has(bucketName as Bucket)) continue;
    const bucketDir = join(packagesRoot, bucketName);
    if (!statSync(bucketDir).isDirectory()) continue;
    for (const pkgDirName of readdirSync(bucketDir)) {
      const pkgDir = join(bucketDir, pkgDirName);
      if (!statSync(pkgDir).isDirectory()) continue;

      for (const scanRoot of ["src", "test"]) {
        const root = join(pkgDir, scanRoot);
        try {
          if (!statSync(root).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const file of walkTsFiles(root)) {
          filesScanned += 1;
          const source = readFileSync(file, "utf8");
          const imports = extractClawImports(source);
          if (imports.length === 0) continue;
          const sourcePkg = resolveSourcePackage(file, buckets);
          if (!sourcePkg) continue;
          for (const imp of imports) {
            importsChecked += 1;
            const spec = imp.specifier;
            // Self-import: trivially allowed.
            if (spec === sourcePkg.name) continue;
            const targetBucket = buckets.get(spec);
            if (!targetBucket) {
              // Unknown @claw package (shouldn't happen in a clean workspace).
              continue;
            }
            // Type-only imports are contracts, not runtime edges.
            // Allowed across every bucket boundary.
            if (imp.typeOnly) continue;
            // Documented value-import exception — see EXCEPTIONS above.
            if (VALUE_IMPORT_EXCEPTIONS.has(`${sourcePkg.name} -> ${spec}`)) continue;
            const allowed = ALLOWED[sourcePkg.bucket];
            if (!allowed.has(targetBucket)) {
              violations.push({
                file: relative(repoRoot, file),
                sourceBucket: sourcePkg.bucket,
                sourcePackage: sourcePkg.name,
                specifier: spec,
                targetBucket,
                rule: `${sourcePkg.bucket}/ may not import from ${targetBucket}/`,
              });
              continue;
            }
            // UI-specific narrowing: only agent-runtime may be imported.
            if (
              sourcePkg.bucket === "ui" &&
              targetBucket === "runtime" &&
              !UI_ALLOWED_RUNTIME_PACKAGES.has(spec)
            ) {
              violations.push({
                file: relative(repoRoot, file),
                sourceBucket: sourcePkg.bucket,
                sourcePackage: sourcePkg.name,
                specifier: spec,
                targetBucket,
                rule: `ui/ may only import from ${Array.from(UI_ALLOWED_RUNTIME_PACKAGES).join(", ")}`,
              });
            }
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`check-package-deps: ${violations.length} violation(s) found\n`);
    for (const v of violations) {
      console.error(`  ${v.file}`);
      console.error(`    source: ${v.sourcePackage} (${v.sourceBucket}/)`);
      console.error(`    imports: ${v.specifier} (${v.targetBucket}/)`);
      console.error(`    rule: ${v.rule}`);
      console.error("");
    }
    return 1;
  }

  console.log(
    `check-package-deps: ok — scanned ${filesScanned} files, checked ${importsChecked} imports`,
  );
  return 0;
}

process.exit(main());
