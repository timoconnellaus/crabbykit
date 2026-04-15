/**
 * Agent Workshop — agent-facing capability for authoring, building,
 * testing, deploying, and managing bundle brains.
 *
 * Tools:
 *   workshop_init, workshop_file_read, workshop_file_write,
 *   workshop_file_edit, workshop_file_list, workshop_file_delete,
 *   workshop_build, workshop_test, workshop_deploy,
 *   workshop_disable, workshop_rollback, workshop_versions
 *
 * Build runs in-process inside the host Worker via
 * `@cloudflare/worker-bundler#createWorker` — there is no container,
 * no shell, no elevation gate. Source files live in R2 under
 * `{namespace}/workshop/bundles/{name}/...` via the shared
 * `AgentStorage` handle. The compiled agent-bundle runtime is injected
 * as a virtual file at build time from `BUNDLE_RUNTIME_SOURCE`, so
 * every build picks up the current SDK runtime automatically without
 * rewriting files in R2.
 */

import { BUNDLE_RUNTIME_SOURCE } from "@claw-for-cloudflare/agent-bundle/bundle-runtime-source";
import type { AgentContext, AnyAgentTool, Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { BundleRegistryWriter, CreateVersionOpts } from "@claw-for-cloudflare/bundle-registry";
import { MAX_BUNDLE_SIZE_BYTES } from "@claw-for-cloudflare/bundle-registry";

// `@cloudflare/worker-bundler` pulls in esbuild-wasm, which eagerly loads a
// `.wasm` file at module evaluation. That works inside a real Worker isolate
// but fails when a Node test runner imports this file — the wasm asset is not
// resolvable from Node's loader. Lazy-import keeps workshop safe to unit-test
// with vitest in Node while still using the real bundler at runtime.
type CreateWorker = typeof import("@cloudflare/worker-bundler").createWorker;
let cachedCreateWorker: CreateWorker | null = null;
async function loadCreateWorker(): Promise<CreateWorker> {
  if (!cachedCreateWorker) {
    const mod = await import("@cloudflare/worker-bundler");
    cachedCreateWorker = mod.createWorker;
  }
  return cachedCreateWorker;
}

const DEFAULT_DEPLOY_RATE_LIMIT = 5;
const BUNDLE_PREFIX = "workshop/bundles";

/**
 * Relative virtual paths at which the pre-compiled bundle runtime is
 * injected. Both map to the same `BUNDLE_RUNTIME_SOURCE` so relative
 * imports resolve no matter which shape the bundle author chose:
 *
 *   - `_claw/bundle-runtime.js` — project-root-relative. Bundle source
 *     `../_claw/bundle-runtime.js` from `src/index.ts` walks up out of
 *     `src/` and lands here.
 *   - `src/_claw/bundle-runtime.js` — matches `./_claw/bundle-runtime.js`
 *     from `src/index.ts`. Covers older starters that used the `./`
 *     form verbatim.
 *
 * The reserved `_claw/` prefix still holds — users can write neither
 * `_claw/` nor `src/_claw/`.
 */
const RELATIVE_RUNTIME_PATHS = [
  "_claw/bundle-runtime.js",
  "src/_claw/bundle-runtime.js",
] as const;

/**
 * Virtual `node_modules/@claw-for-cloudflare/agent-bundle` package that
 * `@cloudflare/worker-bundler`'s `resolvePackage` can find when bundle
 * source uses the natural package import
 * `import from "@claw-for-cloudflare/agent-bundle/bundle"`. The bundler
 * parses the specifier into `(packageName, subpath)`, reads
 * `node_modules/{packageName}/package.json`, uses the `exports` map to
 * resolve `./{subpath}`, and loads
 * `node_modules/{packageName}/{resolvedPath}`. Seeding a full virtual
 * package (package.json + bundle.js) is the ONLY layout that resolver
 * accepts — a bare key at the specifier path is ignored.
 */
const VIRTUAL_PACKAGE_DIR = "node_modules/@claw-for-cloudflare/agent-bundle";
const VIRTUAL_PACKAGE_JSON_PATH = `${VIRTUAL_PACKAGE_DIR}/package.json`;
const VIRTUAL_PACKAGE_BUNDLE_PATH = `${VIRTUAL_PACKAGE_DIR}/bundle.js`;
const VIRTUAL_PACKAGE_JSON = JSON.stringify({
  name: "@claw-for-cloudflare/agent-bundle",
  version: "0.0.0-virtual",
  type: "module",
  exports: {
    "./bundle": "./bundle.js",
  },
});

const BUNDLE_ENVELOPE_VERSION = 1;
const MAX_PATH_BYTES = 512;

export interface AgentWorkshopOptions {
  /**
   * Bundle registry instance. Must satisfy `BundleRegistryWriter` because
   * `workshop_deploy` writes bundle bytes via `createVersion()` before
   * flipping the active pointer with `setActive()`. The narrow read-only
   * `BundleRegistry` is insufficient — it has no way to persist bytes, and
   * a `setActive` call against a never-persisted version would leave the
   * next dispatch turn looking up bytes that don't exist.
   */
  registry: BundleRegistryWriter;
  /**
   * Shared R2 storage identity (bucket + namespace) used to persist bundle
   * source files. Workshop writes under the prefix
   * `{namespace}/workshop/bundles/{name}/...`, which is isolated from other
   * capabilities sharing the same bucket (r2-storage, vector-memory, …).
   */
  storage: AgentStorage;
  /** Maximum deploys per minute per agent. Default: 5. */
  deployRateLimitPerMinute?: number;
}

interface PathValidationOk {
  valid: true;
  normalizedPath: string;
}
interface PathValidationErr {
  valid: false;
  error: string;
}
type PathValidation = PathValidationOk | PathValidationErr;

/**
 * Validate a relative path supplied by the agent. Rejects null bytes,
 * `..` traversal, absolute paths, and paths exceeding the size limit.
 * Mirrors `packages/r2-storage/src/paths.ts::validatePath` — copied so
 * workshop has no dependency on r2-storage being enabled.
 */
function validateRelativePath(path: string): PathValidation {
  if (typeof path !== "string") {
    return { valid: false, error: "Path must be a string" };
  }
  if (path.includes("\0")) {
    return { valid: false, error: "Path must not contain null bytes" };
  }

  const normalized = path.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      return { valid: false, error: "Path must not contain '..' segments" };
    }
  }

  let clean = normalized;
  while (clean.startsWith("/") || clean.startsWith("./")) {
    clean = clean.startsWith("./") ? clean.slice(2) : clean.slice(1);
  }
  if (clean === ".") clean = "";

  if (clean.length === 0) {
    return { valid: false, error: "Path must not be empty after normalization" };
  }
  if (new TextEncoder().encode(clean).byteLength > MAX_PATH_BYTES) {
    return { valid: false, error: "Path must not exceed 512 bytes" };
  }
  return { valid: true, normalizedPath: clean };
}

function validateBundleName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) {
    return "Bundle name must be a non-empty string";
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return "Bundle name must contain only letters, digits, dot, underscore, and dash";
  }
  if (name.length > 64) {
    return "Bundle name must not exceed 64 characters";
  }
  return null;
}

function bundlePrefix(namespace: string, name: string): string {
  return `${namespace}/${BUNDLE_PREFIX}/${name}`;
}

function fileR2Key(namespace: string, name: string, relPath: string): string {
  return `${bundlePrefix(namespace, name)}/${relPath}`;
}

interface LoadedBundleFiles {
  files: Record<string, string>;
  /** Count of R2 objects read, excluding the injected virtual runtime file. */
  userFileCount: number;
  totalBytes: number;
}

/**
 * Interface for the R2 API workshop needs. Kept narrow so tests can supply
 * a tiny in-memory bucket without pulling in the full Cloudflare types.
 */
interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<unknown | null>;
  list(opts: { prefix: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

/**
 * Runtime-source provider. Indirected so tests can inject a different
 * runtime string to verify the auto-upgrade-on-rebuild guarantee.
 */
export interface WorkshopInternals {
  /** Override the runtime source injected at build time (tests only). */
  getBundleRuntimeSource?: () => string;
  /** Override `createWorker` for isolated unit tests. */
  createWorker?: CreateWorker;
}

/**
 * Create the agent workshop capability.
 *
 * The second `internals` argument is test-only. Production consumers pass
 * only `options` — the defaults pull `BUNDLE_RUNTIME_SOURCE` from the
 * agent-bundle package and `createWorker` from `@cloudflare/worker-bundler`.
 */
export function agentWorkshop(
  options: AgentWorkshopOptions,
  internals: WorkshopInternals = {},
): Capability {
  const getRuntimeSource = internals.getBundleRuntimeSource ?? (() => BUNDLE_RUNTIME_SOURCE);
  const runCreateWorker: CreateWorker = internals.createWorker
    ? internals.createWorker
    : async (opts) => (await loadCreateWorker())(opts);
  const deployCounters = new Map<string, { count: number; resetAt: number }>();

  function checkDeployRate(agentId: string): boolean {
    const limit = options.deployRateLimitPerMinute ?? DEFAULT_DEPLOY_RATE_LIMIT;
    const now = Date.now();
    const entry = deployCounters.get(agentId);
    if (!entry || entry.resetAt <= now) {
      deployCounters.set(agentId, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  }

  async function auditLog(
    context: AgentContext,
    tool: string,
    args: Record<string, unknown>,
    status: "success" | "error",
    errorCode?: string,
  ): Promise<void> {
    try {
      context.broadcast("workshop_audit", {
        tool,
        args: Object.fromEntries(
          Object.entries(args).filter(([k]) => k !== "content" && k !== "bytes"),
        ),
        status,
        errorCode,
        timestamp: Date.now(),
      });
    } catch {
      // Audit logging is best-effort.
    }
  }

  function getBucket(): R2Like {
    return options.storage.bucket() as unknown as R2Like;
  }

  function getNamespace(): string {
    return options.storage.namespace();
  }

  /**
   * List all R2 objects under the bundle prefix, fetch their contents,
   * and merge the compiled agent-bundle runtime as virtual files at
   * every path listed in `RUNTIME_VIRTUAL_PATHS`, ready to be passed
   * to `createWorker`.
   *
   * Exported for tests that want to assert the runtime-injection contract
   * without invoking `createWorker`.
   */
  async function loadBundleFiles(name: string): Promise<LoadedBundleFiles> {
    const namespace = getNamespace();
    const prefix = `${bundlePrefix(namespace, name)}/`;
    const bucket = getBucket();
    const files: Record<string, string> = {};
    let totalBytes = 0;
    let userFileCount = 0;

    const listed = await bucket.list({ prefix });
    for (const obj of listed.objects) {
      const rel = obj.key.slice(prefix.length);
      if (!rel) continue;
      const got = await bucket.get(obj.key);
      if (!got) continue;
      const contents = await got.text();
      files[rel] = contents;
      totalBytes += contents.length;
      userFileCount++;
    }

    // Inject the pre-compiled bundle runtime at every virtual path a
    // bundle author might use. Done on EVERY build — never persisted
    // to R2 — so existing bundles pick up runtime changes automatically
    // on their next build.
    const runtimeSource = getRuntimeSource();
    for (const path of RELATIVE_RUNTIME_PATHS) {
      files[path] = runtimeSource;
    }
    // Virtual node_modules package for
    // `import from "@claw-for-cloudflare/agent-bundle/bundle"`. The
    // bundler's `resolvePackage` looks up the package.json, follows
    // the exports map, and reads the resolved file — so we need BOTH
    // entries present, not just a bare key.
    files[VIRTUAL_PACKAGE_JSON_PATH] = VIRTUAL_PACKAGE_JSON;
    files[VIRTUAL_PACKAGE_BUNDLE_PATH] = runtimeSource;

    return { files, userFileCount, totalBytes };
  }

  /**
   * Build a bundle end-to-end: list files → merge runtime → createWorker.
   * Returns the raw bundler output plus summary statistics.
   */
  async function buildBundle(name: string): Promise<{
    mainModule: string;
    modules: Record<string, unknown>;
    userFileCount: number;
  }> {
    const loaded = await loadBundleFiles(name);
    if (loaded.userFileCount === 0) {
      throw new Error(`No files under workshop/bundles/${name}/. Run workshop_init first.`);
    }

    const result = await runCreateWorker({ files: loaded.files });
    return {
      mainModule: result.mainModule,
      modules: result.modules as Record<string, unknown>,
      userFileCount: loaded.userFileCount,
    };
  }

  function starterIndex(name: string): string {
    return [
      'import { defineBundleAgent } from "@claw-for-cloudflare/agent-bundle/bundle";',
      "",
      "export default defineBundleAgent({",
      '  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },',
      `  prompt: { agentName: "${name}" },`,
      "  metadata: {",
      `    name: "${name}",`,
      `    description: "Bundle brain for ${name}",`,
      "  },",
      "});",
      "",
    ].join("\n");
  }

  function starterPackageJson(name: string): string {
    return `${JSON.stringify(
      {
        name,
        type: "module",
        // No dependencies by default — the agent-bundle runtime is
        // injected at build time from the host worker, not resolved
        // from npm. Add real npm deps here if the bundle needs them.
        dependencies: {},
      },
      null,
      2,
    )}\n`;
  }

  return {
    id: "agent-workshop",
    name: "Agent Workshop",
    description: "Author, build, test, deploy, and manage bundle brains",

    tools: (context: AgentContext): AnyAgentTool[] => {
      const namespace = getNamespace();
      const bucket = getBucket();

      function resolveFileKey(
        name: string,
        path: string,
      ): { key: string; relPath: string } | string {
        const nameErr = validateBundleName(name);
        if (nameErr) return nameErr;
        const pathVal = validateRelativePath(path);
        if (!pathVal.valid) return pathVal.error;
        if (pathVal.normalizedPath.startsWith("_claw/")) {
          return "Path '_claw/' is reserved for the injected bundle runtime and may not be written.";
        }
        return {
          key: fileR2Key(namespace, name, pathVal.normalizedPath),
          relPath: pathVal.normalizedPath,
        };
      }

      return [
        defineTool({
          name: "workshop_init",
          description:
            "Scaffold a new bundle workspace with package.json and a defineBundleAgent starter. Files persist in R2 under workshop/bundles/{name}/.",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
          }),
          execute: async (args) => {
            const nameErr = validateBundleName(args.name);
            if (nameErr) {
              await auditLog(context, "workshop_init", args, "error", "INVALID_NAME");
              return `Error: ${nameErr}`;
            }
            const pkgKey = fileR2Key(namespace, args.name, "package.json");
            const existing = await bucket.head(pkgKey);
            if (existing) {
              await auditLog(context, "workshop_init", args, "error", "ALREADY_EXISTS");
              return `Error: Workspace "${args.name}" already exists. Choose a different name or edit it directly with workshop_file_* tools.`;
            }
            await bucket.put(pkgKey, starterPackageJson(args.name));
            await bucket.put(
              fileR2Key(namespace, args.name, "src/index.ts"),
              starterIndex(args.name),
            );
            await auditLog(context, "workshop_init", args, "success");
            return `Bundle workspace "${args.name}" created.\nFiles: package.json, src/index.ts\nEdit with workshop_file_edit, then workshop_build → workshop_test → workshop_deploy.`;
          },
        }),

        defineTool({
          name: "workshop_file_read",
          description: "Read a file from a bundle workspace in R2",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            path: Type.String({ description: "Relative path within the workspace" }),
          }),
          execute: async (args) => {
            const resolved = resolveFileKey(args.name, args.path);
            if (typeof resolved === "string") return `Error: ${resolved}`;
            const obj = await bucket.get(resolved.key);
            if (!obj) return `Error: File not found: ${resolved.relPath}`;
            return await obj.text();
          },
        }),

        defineTool({
          name: "workshop_file_write",
          description: "Write (create or overwrite) a file in a bundle workspace",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            path: Type.String({ description: "Relative path within the workspace" }),
            content: Type.String({ description: "File contents" }),
          }),
          execute: async (args) => {
            const resolved = resolveFileKey(args.name, args.path);
            if (typeof resolved === "string") {
              await auditLog(context, "workshop_file_write", args, "error", "BAD_PATH");
              return `Error: ${resolved}`;
            }
            await bucket.put(resolved.key, args.content);
            await auditLog(context, "workshop_file_write", args, "success");
            return `Wrote ${resolved.relPath} (${args.content.length} bytes)`;
          },
        }),

        defineTool({
          name: "workshop_file_edit",
          description:
            "Replace an exact string in an existing file. Fails if the string is not found exactly once.",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            path: Type.String({ description: "Relative path within the workspace" }),
            oldString: Type.String({ description: "Exact string to replace" }),
            newString: Type.String({ description: "Replacement string" }),
          }),
          execute: async (args) => {
            const resolved = resolveFileKey(args.name, args.path);
            if (typeof resolved === "string") return `Error: ${resolved}`;
            const obj = await bucket.get(resolved.key);
            if (!obj) return `Error: File not found: ${resolved.relPath}`;
            const current = await obj.text();
            const first = current.indexOf(args.oldString);
            if (first === -1) return "Error: oldString not found in file";
            const second = current.indexOf(args.oldString, first + args.oldString.length);
            if (second !== -1) {
              return "Error: oldString matches more than once; include more surrounding context";
            }
            const next =
              current.slice(0, first) +
              args.newString +
              current.slice(first + args.oldString.length);
            await bucket.put(resolved.key, next);
            await auditLog(context, "workshop_file_edit", args, "success");
            return `Edited ${resolved.relPath}`;
          },
        }),

        defineTool({
          name: "workshop_file_list",
          description: "List files in a bundle workspace",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
          }),
          execute: async (args) => {
            const nameErr = validateBundleName(args.name);
            if (nameErr) return `Error: ${nameErr}`;
            const prefix = `${bundlePrefix(namespace, args.name)}/`;
            const listed = await bucket.list({ prefix });
            if (listed.objects.length === 0) {
              return `(empty) Workspace "${args.name}" has no files. Run workshop_init first.`;
            }
            const rels = listed.objects
              .map((o) => o.key.slice(prefix.length))
              .filter((rel) => rel && !rel.startsWith("_claw/"))
              .sort();
            return rels.join("\n");
          },
        }),

        defineTool({
          name: "workshop_file_delete",
          description: "Delete a file from a bundle workspace",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            path: Type.String({ description: "Relative path within the workspace" }),
          }),
          execute: async (args) => {
            const resolved = resolveFileKey(args.name, args.path);
            if (typeof resolved === "string") return `Error: ${resolved}`;
            await bucket.delete(resolved.key);
            await auditLog(context, "workshop_file_delete", args, "success");
            return `Deleted ${resolved.relPath}`;
          },
        }),

        defineTool({
          name: "workshop_build",
          description:
            "Compile a bundle workspace in-process via @cloudflare/worker-bundler. No container required.",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
          }),
          execute: async (args) => {
            const nameErr = validateBundleName(args.name);
            if (nameErr) return `Error: ${nameErr}`;
            try {
              const built = await buildBundle(args.name);
              const moduleCount = Object.keys(built.modules).length;
              await auditLog(context, "workshop_build", args, "success");
              return `Build successful.\n  main module: ${built.mainModule}\n  modules: ${moduleCount}\n  source files: ${built.userFileCount}`;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await auditLog(context, "workshop_build", args, "error", "BUILD_FAILED");
              return `Build failed: ${msg}`;
            }
          },
        }),

        defineTool({
          name: "workshop_test",
          description:
            "Smoke-test a bundle by rebuilding and validating the output has a main module with a default export.",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
          }),
          execute: async (args) => {
            const nameErr = validateBundleName(args.name);
            if (nameErr) return `Error: ${nameErr}`;
            let built: Awaited<ReturnType<typeof buildBundle>>;
            try {
              built = await buildBundle(args.name);
            } catch (err) {
              return `Test failed (build error): ${err instanceof Error ? err.message : String(err)}`;
            }
            const mainContent = extractModuleContent(built.modules[built.mainModule]);
            if (!mainContent) {
              return `Test failed: main module "${built.mainModule}" is missing or empty`;
            }
            if (!hasDefaultExport(mainContent)) {
              return `Test failed: main module "${built.mainModule}" has no default export`;
            }
            const envelope = encodeEnvelope(built.mainModule, built.modules);
            if (envelope.byteLength > MAX_BUNDLE_SIZE_BYTES) {
              return `Test failed: bundle exceeds ${MAX_BUNDLE_SIZE_BYTES} byte limit (${envelope.byteLength} bytes)`;
            }
            return `Test passed.\n  main module: ${built.mainModule}\n  envelope size: ${envelope.byteLength} bytes\n  modules: ${Object.keys(built.modules).length}`;
          },
        }),

        defineTool({
          name: "workshop_deploy",
          description:
            "Deploy a built bundle as the active brain for this agent (or a target agent)",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            rationale: Type.Optional(Type.String({ description: "Why this deployment" })),
            targetAgentId: Type.Optional(
              Type.String({ description: "Target agent ID (default: self)" }),
            ),
          }),
          execute: async (args) => {
            const nameErr = validateBundleName(args.name);
            if (nameErr) return `Error: ${nameErr}`;
            const agentId = args.targetAgentId ?? context.agentId;
            if (!checkDeployRate(agentId)) {
              return "Error: Deploy rate limit exceeded (ERR_DEPLOY_RATE_LIMITED). Wait and try again.";
            }

            let built: Awaited<ReturnType<typeof buildBundle>>;
            try {
              built = await buildBundle(args.name);
            } catch (err) {
              await auditLog(context, "workshop_deploy", args, "error", "BUILD_FAILED");
              return `Deploy failed (build error): ${err instanceof Error ? err.message : String(err)}`;
            }

            const mainContent = extractModuleContent(built.modules[built.mainModule]);
            if (!hasDefaultExport(mainContent)) {
              await auditLog(context, "workshop_deploy", args, "error", "SMOKE_FAILED");
              return "Error: Pre-deploy smoke test failed — main module has no default export";
            }

            const envelope = encodeEnvelope(built.mainModule, built.modules);
            if (envelope.byteLength > MAX_BUNDLE_SIZE_BYTES) {
              return `Error: Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES} byte limit (${envelope.byteLength} bytes)`;
            }

            let version: Awaited<ReturnType<typeof options.registry.createVersion>>;
            try {
              const opts: CreateVersionOpts = {
                bytes: envelope,
                createdBy: context.sessionId,
              };
              version = await options.registry.createVersion(opts);
            } catch (err) {
              await auditLog(context, "workshop_deploy", args, "error", "CREATE_VERSION_FAILED");
              return `Deploy failed: ${err instanceof Error ? err.message : String(err)}`;
            }

            try {
              await options.registry.setActive(agentId, version.versionId, {
                rationale: args.rationale ?? "workshop_deploy",
                sessionId: context.sessionId,
              });
            } catch (err) {
              await auditLog(context, "workshop_deploy", args, "error", "SET_ACTIVE_FAILED");
              return `Deploy failed at setActive: ${err instanceof Error ? err.message : String(err)}`;
            }

            // Notify the DO's hot cache so the next turn picks up the new
            // bundle. No-op on agents without bundle dispatch installed.
            if (agentId === context.agentId) {
              await context.notifyBundlePointerChanged?.();
            }

            await auditLog(
              context,
              "workshop_deploy",
              { ...args, versionId: version.versionId },
              "success",
            );
            return [
              "Bundle deployed successfully.",
              `  Version: ${version.versionId.slice(0, 12)}...`,
              `  Size: ${envelope.byteLength} bytes`,
              `  Main module: ${built.mainModule}`,
              `  Target: ${agentId === context.agentId ? "self" : agentId}`,
              `  Rationale: ${args.rationale ?? "(none)"}`,
            ].join("\n");
          },
        }),

        defineTool({
          name: "workshop_disable",
          description: "Disable the active bundle, reverting to the static brain",
          parameters: Type.Object({
            rationale: Type.Optional(Type.String({ description: "Why disabling" })),
            targetAgentId: Type.Optional(
              Type.String({ description: "Target agent ID (default: self)" }),
            ),
          }),
          execute: async (args) => {
            const agentId = args.targetAgentId ?? context.agentId;
            await options.registry.setActive(agentId, null, {
              rationale: args.rationale ?? "workshop_disable",
              sessionId: context.sessionId,
            });
            if (agentId === context.agentId) {
              await context.notifyBundlePointerChanged?.();
            }
            await auditLog(context, "workshop_disable", args, "success");
            return `Bundle disabled for ${agentId === context.agentId ? "self" : agentId}. Static brain will run on next turn.`;
          },
        }),

        defineTool({
          name: "workshop_rollback",
          description: "Roll back to the previous bundle version",
          parameters: Type.Object({
            rationale: Type.Optional(Type.String({ description: "Why rolling back" })),
            targetAgentId: Type.Optional(
              Type.String({ description: "Target agent ID (default: self)" }),
            ),
          }),
          execute: async (args) => {
            const agentId = args.targetAgentId ?? context.agentId;
            const current = await options.registry.getActiveForAgent(agentId);
            if (!current) {
              return "Error: No active bundle to roll back from. Use workshop_disable instead.";
            }
            return "Rollback requires the extended D1BundleRegistry.rollback method (not yet exposed on BundleRegistryWriter). Use workshop_disable to revert to the static brain.";
          },
        }),

        defineTool({
          name: "workshop_versions",
          description: "Show active bundle status for an agent",
          parameters: Type.Object({
            targetAgentId: Type.Optional(
              Type.String({ description: "Target agent ID (default: self)" }),
            ),
          }),
          execute: async (args) => {
            const agentId = args.targetAgentId ?? context.agentId;
            const activeId = await options.registry.getActiveForAgent(agentId);
            return [
              `Bundle status for ${agentId === context.agentId ? "self" : agentId}:`,
              `  Active version: ${activeId ?? "(none — static brain)"}`,
              "",
              "Full deployment history requires D1BundleRegistry.listDeployments.",
            ].join("\n");
          },
        }),
      ];
    },

    promptSections: () => [
      {
        kind: "included" as const,
        name: "Agent Workshop",
        content: [
          "You have the Agent Workshop capability. You can author, build, test, deploy, and manage bundle brains.",
          "",
          "Bundle source files live in R2 under `workshop/bundles/{name}/`. Build is in-process — no container, no elevation required.",
          "",
          "Workflow:",
          "1. `workshop_init` — scaffold a new bundle workspace (creates package.json + src/index.ts)",
          "2. `workshop_file_read` / `workshop_file_write` / `workshop_file_edit` — author the bundle",
          "3. `workshop_build` — compile via @cloudflare/worker-bundler",
          "4. `workshop_test` — smoke-test the compiled output",
          "5. `workshop_deploy` — deploy as your active brain (self-editing by default)",
          "6. `workshop_disable` — revert to static brain if needed",
          "",
          "The `@claw-for-cloudflare/agent-bundle` runtime is injected at build time — import it from `@claw-for-cloudflare/agent-bundle/bundle` in your src/index.ts. Do not write files under `_claw/`; the prefix is reserved.",
          "",
          "Self-editing is safe: the static brain is always available as a fallback.",
        ].join("\n"),
      },
    ],
  };
}

/**
 * Encode a built bundle into the v1 JSON envelope the dispatcher expects.
 * Exported for tests that want to assert the payload shape without driving
 * a full deploy.
 */
export function encodeEnvelope(mainModule: string, modules: Record<string, unknown>): ArrayBuffer {
  const payload = JSON.stringify({
    v: BUNDLE_ENVELOPE_VERSION,
    mainModule,
    modules,
  });
  const bytes = new TextEncoder().encode(payload);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/**
 * Return true if the bundled source exposes a default export. Accepts both
 * the literal `export default` form written by hand in src/index.ts and the
 * rewritten `export { <name> as default }` / `export {default as default}`
 * forms emitted by bundlers that hoist the default through a named binding.
 * Exported for unit tests.
 */
export function hasDefaultExport(source: string | undefined): boolean {
  if (!source) return false;
  if (source.includes("export default")) return true;
  return /export\s*\{[^}]*\bas\s+default\b/.test(source);
}

/**
 * Extract the raw JS content from a `createWorker` module entry, which
 * may be either a string or a structured `{js?, cjs?, text?, json?}`
 * module. Returns undefined when no text-form content is available.
 */
function extractModuleContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as { js?: string; cjs?: string; text?: string };
    return obj.js ?? obj.cjs ?? obj.text;
  }
  return undefined;
}
