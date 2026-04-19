/**
 * Real build-pipeline regression tests.
 *
 * Existing workshop tests use a `fakeCreateWorker` (workshop.test.ts:13)
 * that skips the actual bundler entirely. That's fine for wiring tests
 * but useless for catching the real failure mode: the bundler failing
 * to inline `@crabbykit/bundle-sdk` imports, leaving them as
 * unresolved externals that blow up at load time with:
 *
 *     Uncaught Error: No such module "@crabbykit/bundle-sdk".
 *       imported from "bundle.js"
 *
 * These tests drive `@cloudflare/worker-bundler#createWorker` end-to-end
 * with the real pre-built bundle runtime (`BUNDLE_RUNTIME_SOURCE`) and
 * assert three invariants on the built output:
 *
 *   1. The build succeeds.
 *   2. `mainModule` and `modules` are populated.
 *   3. No `@crabbykit/*` import remains in the bundled output.
 *
 * The third invariant is the actual regression guard. If the bundler
 * leaves a package import unresolved, a consumer's `@cloudflare/worker-bundler`
 * build will SUCCEED but fail at runtime inside the Worker Loader isolate.
 * A unit test that only calls the bundler can't catch that — you have to
 * grep the output for stray externals.
 *
 * Two source templates are exercised:
 *   (a) The scaffolded starter (`./_claw/bundle-runtime.js` relative
 *       import) — this is what `workshop_init` writes.
 *   (b) The "natural" package import
 *       (`@crabbykit/bundle-sdk`) — this is what a user
 *       reaches for if they know the package name and don't read the
 *       scaffolded starter.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUNDLE_RUNTIME_SOURCE } from "@crabbykit/bundle-sdk/runtime-source";
import { describe, expect, it } from "vitest";

/**
 * Mirror of workshop's runtime injection. Kept as a literal copy (not
 * imported) so the test can catch the case where workshop changes its
 * injection shape without updating production correctly — a test that
 * imports the constants would move in lock-step and miss the drift.
 */
const RELATIVE_RUNTIME_PATHS = ["_claw/bundle-runtime.js", "src/_claw/bundle-runtime.js"] as const;
const VIRTUAL_PACKAGE_JSON_PATH = "node_modules/@crabbykit/bundle-sdk/package.json";
const VIRTUAL_PACKAGE_BUNDLE_PATH = "node_modules/@crabbykit/bundle-sdk/bundle.js";
const VIRTUAL_PACKAGE_JSON = JSON.stringify({
  name: "@crabbykit/bundle-sdk",
  version: "0.0.0-virtual",
  type: "module",
  exports: { ".": "./bundle.js" },
});

/** Inject the runtime bytes at every path workshop would inject them. */
function withRuntime(files: Record<string, string>): Record<string, string> {
  const out = { ...files };
  for (const path of RELATIVE_RUNTIME_PATHS) {
    out[path] = BUNDLE_RUNTIME_SOURCE;
  }
  out[VIRTUAL_PACKAGE_JSON_PATH] = VIRTUAL_PACKAGE_JSON;
  out[VIRTUAL_PACKAGE_BUNDLE_PATH] = BUNDLE_RUNTIME_SOURCE;
  return out;
}

const RUNNER_PATH = fileURLToPath(new URL("./real-build-runner.ts", import.meta.url));

type BuildOk = { ok: true; mainModule: string; modules: Record<string, unknown> };
type BuildErr = { ok: false; error: string; stack?: string };
type BuildResult = BuildOk | BuildErr;

/**
 * Spawn the subprocess bundler runner. We shell out to `bun` because
 * vite-node's transform pipeline can't load the wasm-backed esbuild
 * bundled inside `@cloudflare/worker-bundler`, so a plain static import
 * from inside the vitest test file fails with `Cannot find package 'gojs'`.
 */
function runRealBuild(files: Record<string, string>): BuildResult {
  const payload = JSON.stringify({ files });
  const proc = spawnSync("bun", [RUNNER_PATH, payload], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    return {
      ok: false,
      error: `runner exited with ${proc.status}: ${proc.stderr}`,
    };
  }
  if (!proc.stdout) {
    return { ok: false, error: "runner produced no stdout" };
  }
  return JSON.parse(proc.stdout) as BuildResult;
}

/**
 * Reach into the bundler's module output and concatenate every JS module
 * body into a single searchable string. Used to assert that no
 * `@crabbykit/*` imports remain unresolved.
 */
function concatModules(modules: Record<string, unknown>): string {
  return Object.values(modules)
    .map((mod) => {
      if (typeof mod === "string") return mod;
      if (mod && typeof mod === "object") {
        const m = mod as { js?: string; cjs?: string; text?: string };
        return m.js ?? m.cjs ?? m.text ?? "";
      }
      return "";
    })
    .join("\n");
}

/**
 * Find any `import ... from "@crabbykit/..."` statements the
 * bundler left as externals. Covers both static imports and dynamic
 * `import()` calls.
 */
function findUnresolvedClawImports(source: string): string[] {
  const staticRe = /import\s+[^'"]*['"](@crabbykit\/[^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"](@crabbykit\/[^'"]+)['"]\s*\)/g;
  const hits: string[] = [];
  for (const m of source.matchAll(staticRe)) hits.push(m[1]);
  for (const m of source.matchAll(dynamicRe)) hits.push(m[1]);
  return hits;
}

/**
 * Find any import/export specifier in the bundled output that isn't
 * allowed to remain external. Allowed externals: `cloudflare:*` (Workers
 * runtime APIs). EVERYTHING else — relative paths, bare specifiers,
 * absolute paths — should have been inlined by the bundler. If anything
 * leaks through, workerd will fail at load time with "No such module".
 */
function findDisallowedExternals(source: string): string[] {
  const staticRe = /(?:import|export)\s+[^'"]*['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const hits: string[] = [];
  const seen = new Set<string>();
  const collect = (spec: string) => {
    if (seen.has(spec)) return;
    seen.add(spec);
    if (spec.startsWith("cloudflare:")) return;
    hits.push(spec);
  };
  for (const m of source.matchAll(staticRe)) collect(m[1]);
  for (const m of source.matchAll(dynamicRe)) collect(m[1]);
  return hits;
}

const PACKAGE_JSON = JSON.stringify({ name: "test-bundle", type: "module" });

describe("real build: scaffolded starter (relative runtime import)", () => {
  it("scaffolded `./_claw/bundle-runtime.js` import must resolve and be inlined", () => {
    // This mirrors what `workshop_init` writes today. The starter
    // imports `./_claw/bundle-runtime.js` FROM `src/index.ts`, which a
    // standard relative-path resolver interprets as
    // `src/_claw/bundle-runtime.js` — but the injected runtime lives at
    // the project-root `_claw/bundle-runtime.js`. worker-bundler's
    // `resolveRelativePath` can't find it, falls through to the "mark
    // external" fallback, and workerd fails at load time with
    // `No such module "./_claw/bundle-runtime.js"`.
    const files: Record<string, string> = {
      "package.json": PACKAGE_JSON,
      "src/index.ts": [
        'import { defineBundleAgent } from "./_claw/bundle-runtime.js";',
        "",
        "export default defineBundleAgent({",
        '  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },',
        '  prompt: { agentName: "test" },',
        '  metadata: { name: "test", description: "real-build test" },',
        "});",
      ].join("\n"),
    };

    const result = runRealBuild(withRuntime(files));
    expect(result.ok, result.ok ? "" : `build failed: ${result.error}`).toBe(true);
    if (!result.ok) return;

    expect(result.mainModule).toBeTruthy();
    expect(Object.keys(result.modules).length).toBeGreaterThan(0);

    const combined = concatModules(result.modules);
    const stray = findDisallowedExternals(combined);
    expect(
      stray,
      `scaffolded starter leaked externals at runtime: ${stray.join(", ")}. These should have been inlined.`,
    ).toEqual([]);
  });

  it("workaround: `../_claw/bundle-runtime.js` resolves correctly from src/index.ts", () => {
    // Confirms what the starter SHOULD emit: `../_claw/...` walks out
    // of src/ back to the project root, where the injected runtime
    // lives. This test is the positive control — if this breaks, the
    // workaround we'd suggest to `workshop_init` is also broken.
    const files: Record<string, string> = {
      "package.json": PACKAGE_JSON,
      "src/index.ts": [
        'import { defineBundleAgent } from "../_claw/bundle-runtime.js";',
        "",
        "export default defineBundleAgent({",
        '  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },',
        '  prompt: { agentName: "test" },',
        '  metadata: { name: "test", description: "real-build test" },',
        "});",
      ].join("\n"),
    };

    const result = runRealBuild(withRuntime(files));
    expect(result.ok, result.ok ? "" : `build failed: ${result.error}`).toBe(true);
    if (!result.ok) return;

    const combined = concatModules(result.modules);
    const stray = findDisallowedExternals(combined);
    expect(stray, `correct relative path still leaked externals: ${stray.join(", ")}`).toEqual([]);
  });
});

describe("real build: natural package import path", () => {
  it("user-written `@crabbykit/bundle-sdk` must not leak as an external", () => {
    // Regression test for "No such module" at runtime. A user who
    // imports from the natural package path (instead of the scaffolded
    // relative `./_claw/bundle-runtime.js`) must either get a build
    // error — or, preferably, the bundler/workshop should alias the
    // package path to the injected runtime so the build succeeds and
    // runs. What MUST NOT happen is a successful build that leaves
    // `@crabbykit/bundle-sdk` as an unresolved import
    // for workerd to trip over.
    const files: Record<string, string> = {
      "package.json": PACKAGE_JSON,
      "src/index.ts": [
        'import { defineBundleAgent } from "@crabbykit/bundle-sdk";',
        "",
        "export default defineBundleAgent({",
        '  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },',
        '  prompt: { agentName: "natural" },',
        '  metadata: { name: "natural", description: "natural-path test" },',
        "});",
      ].join("\n"),
    };

    const result = runRealBuild(withRuntime(files));

    if (!result.ok) {
      // Acceptable: loud failure at build time is better than a silent
      // unresolved extern. Document the error shape so a future fix
      // that switches to "build succeeds" can flip this branch.
      expect(result.error).toMatch(/bundle-sdk|bundle-runtime|module|resolve|not found/i);
      return;
    }

    const combined = concatModules(result.modules);
    const stray = findUnresolvedClawImports(combined);
    expect(
      stray,
      `natural import path leaked an unresolved external at runtime: ${stray.join(", ")}. A user who writes \`import from "@crabbykit/bundle-sdk"\` gets a successful build but a broken deploy.`,
    ).toEqual([]);
  });
});

describe("real build: compile-then-grep invariants", () => {
  it("BUNDLE_RUNTIME_SOURCE itself has no unresolved @crabbykit imports", async () => {
    // If the pre-built runtime blob has stray imports, every bundle that
    // embeds it inherits them. Guard the source directly.
    const stray = findUnresolvedClawImports(BUNDLE_RUNTIME_SOURCE);
    expect(
      stray,
      `BUNDLE_RUNTIME_SOURCE has unresolved @crabbykit imports: ${stray.join(", ")}`,
    ).toEqual([]);
  });
});
