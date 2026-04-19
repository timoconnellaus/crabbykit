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
 * `AgentStorage` handle. The compiled bundle-sdk runtime is injected
 * as a virtual file at build time from `BUNDLE_RUNTIME_SOURCE`, so
 * every build picks up the current SDK runtime automatically without
 * rewriting files in R2.
 *
 * The low-level build pipeline (`loadBundleFiles`, `buildBundle`,
 * `encodeEnvelope`) lives in `@crabbykit/bundle-host` so
 * the bundle dispatcher can reuse it for auto-rebuild on runtime
 * drift — see `dispatcher.ts` in that package.
 */

import type { AgentContext, AnyAgentTool, Capability } from "@crabbykit/agent-runtime";
import { defineTool, Type } from "@crabbykit/agent-runtime";
import type { AgentStorage } from "@crabbykit/agent-storage";
import type { BuildBundleResult, BundleSourceBucket } from "@crabbykit/bundle-host";
import {
  buildBundle as buildBundleCore,
  bundleFileR2Key,
  bundlePrefix as bundlePrefixFor,
  encodeEnvelope,
} from "@crabbykit/bundle-host";
import type { BundleRegistryWriter, CreateVersionOpts } from "@crabbykit/bundle-registry";
import { MAX_BUNDLE_SIZE_BYTES } from "@crabbykit/bundle-registry";
import { BUNDLE_RUNTIME_HASH, BUNDLE_RUNTIME_SOURCE } from "@crabbykit/bundle-sdk/runtime-source";

const DEFAULT_DEPLOY_RATE_LIMIT = 5;
const MAX_PATH_BYTES = 512;

export { encodeEnvelope };

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
   * capabilities sharing the same bucket (file-tools, vector-memory, …).
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
 * Mirrors `packages/capabilities/file-tools/src/paths.ts::validatePath` — copied so
 * workshop has no dependency on file-tools being enabled.
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

function fileR2Key(namespace: string, name: string, relPath: string): string {
  return bundleFileR2Key(namespace, name, relPath);
}

/**
 * Narrow R2 surface workshop uses for `workshop_file_*` tools. Wider than
 * `BundleSourceBucket` (which only needs `get`/`list`) because the file
 * editor tools must `put`, `head`, and `delete` too.
 */
interface R2Like extends BundleSourceBucket {
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<unknown | null>;
}

type CreateWorker = typeof import("@cloudflare/worker-bundler").createWorker;

/** Override hooks for unit tests. */
export interface WorkshopInternals {
  /** Override the runtime source injected at build time (tests only). */
  getBundleRuntimeSource?: () => string;
  /** Override the runtime hash stamped on deployed bundles (tests only). */
  getBundleRuntimeHash?: () => string;
  /** Override `createWorker` for isolated unit tests. */
  createWorker?: CreateWorker;
}

/**
 * Create the agent workshop capability.
 *
 * The second `internals` argument is test-only. Production consumers pass
 * only `options` — the defaults pull `BUNDLE_RUNTIME_SOURCE` from the
 * bundle-sdk package and `createWorker` from `@cloudflare/worker-bundler`.
 */
export function agentWorkshop(
  options: AgentWorkshopOptions,
  internals: WorkshopInternals = {},
): Capability {
  const getRuntimeSource = internals.getBundleRuntimeSource ?? (() => BUNDLE_RUNTIME_SOURCE);
  const getRuntimeHash = internals.getBundleRuntimeHash ?? (() => BUNDLE_RUNTIME_HASH);
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
   * Build a bundle end-to-end via the shared core helper in bundle-host.
   * Injects the current `BUNDLE_RUNTIME_SOURCE` (or a test override) from R2
   * source files and calls `createWorker`. The same core path is used by
   * the bundle dispatcher's auto-rebuild — keeping the logic here aligned
   * means runtime drift repairs produce byte-identical bundles to
   * freshly-built ones.
   */
  async function buildBundle(name: string): Promise<BuildBundleResult> {
    return buildBundleCore({
      bucket: getBucket(),
      namespace: getNamespace(),
      name,
      runtimeSource: getRuntimeSource(),
      createWorker: internals.createWorker,
    });
  }

  function starterIndex(name: string): string {
    return [
      'import { defineBundleAgent } from "@crabbykit/bundle-sdk";',
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
        // No dependencies by default — the bundle-sdk runtime is
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
            const prefix = `${bundlePrefixFor(namespace, args.name)}/`;
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
            "Compile a bundle workspace in-process via @cloudflare/worker-bundler. No container required. When `requiredCapabilities` is provided, the tool also emits an advisory warning for any declared id not registered on the workshop's host (advisory only — the workshop may be building for a different target deployment).",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            requiredCapabilities: Type.Optional(
              Type.Array(Type.Object({ id: Type.String() }), {
                description:
                  "Optional: declared host-capability requirements. Used to surface advisory warnings for ids missing from the workshop host's capability set.",
              }),
            ),
          }),
          execute: async (args) => {
            const nameErr = validateBundleName(args.name);
            if (nameErr) return `Error: ${nameErr}`;
            try {
              const built = await buildBundle(args.name);
              const moduleCount = Object.keys(built.modules).length;
              await auditLog(context, "workshop_build", args, "success");
              const lines = [
                `Build successful.`,
                `  main module: ${built.mainModule}`,
                `  modules: ${moduleCount}`,
                `  source files: ${built.userFileCount}`,
              ];
              if (args.requiredCapabilities && args.requiredCapabilities.length > 0) {
                const hostIds = new Set(context.getBundleHostCapabilityIds?.() ?? []);
                const missing = args.requiredCapabilities
                  .map((r) => r.id)
                  .filter((id) => !hostIds.has(id));
                if (missing.length > 0) {
                  lines.push(
                    `  Advisory: declared capabilities not in workshop host: ${missing.join(", ")} (advisory — target deployment may differ)`,
                  );
                }
              }
              return lines.join("\n");
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
            "Deploy a built bundle as the active brain for this agent (or a target agent). Declares the bundle's host-capability requirements for catalog validation; pass `skipCatalogCheck: true` for cross-deployment promotions where the local host's capability set is not authoritative (the target deployment's dispatch-time guard will validate instead).",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            rationale: Type.Optional(Type.String({ description: "Why this deployment" })),
            targetAgentId: Type.Optional(
              Type.String({ description: "Target agent ID (default: self)" }),
            ),
            requiredCapabilities: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.String({
                    description:
                      "Host capability id, kebab-case, must match a registered Capability.id",
                  }),
                }),
                {
                  description:
                    "Host-side capabilities this bundle requires. Should match the bundle's `defineBundleAgent({ requiredCapabilities })` declaration. Persisted into bundle version metadata and validated at setActive + dispatch time.",
                },
              ),
            ),
            skipCatalogCheck: Type.Optional(
              Type.Boolean({
                description:
                  "Skip catalog validation on promotion. Use only for cross-deployment promotions where the workshop host's capability set is not authoritative. The target deployment's dispatch-time guard still validates on first dispatch.",
              }),
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

            // Advisory warning: compare declared requirements against the
            // workshop's own host capability set. Does NOT block deploy —
            // the workshop may be building for a different target.
            const hostIdsList = context.getBundleHostCapabilityIds?.() ?? [];
            const hostIds = new Set(hostIdsList);
            const advisoryMissing: string[] = [];
            for (const req of args.requiredCapabilities ?? []) {
              if (!hostIds.has(req.id)) advisoryMissing.push(req.id);
            }

            let version: Awaited<ReturnType<typeof options.registry.createVersion>>;
            try {
              const opts: CreateVersionOpts = {
                bytes: envelope,
                createdBy: context.sessionId,
                metadata: {
                  sourceName: args.name,
                  runtimeHash: getRuntimeHash(),
                  buildTimestamp: Date.now(),
                  ...(args.requiredCapabilities && args.requiredCapabilities.length > 0
                    ? { requiredCapabilities: args.requiredCapabilities }
                    : {}),
                },
              };
              version = await options.registry.createVersion(opts);
            } catch (err) {
              await auditLog(context, "workshop_deploy", args, "error", "CREATE_VERSION_FAILED");
              return `Deploy failed: ${err instanceof Error ? err.message : String(err)}`;
            }

            try {
              if (args.skipCatalogCheck) {
                await options.registry.setActive(agentId, version.versionId, {
                  rationale: args.rationale ?? "workshop_deploy",
                  sessionId: context.sessionId,
                  skipCatalogCheck: true,
                });
              } else {
                await options.registry.setActive(agentId, version.versionId, {
                  rationale: args.rationale ?? "workshop_deploy",
                  sessionId: context.sessionId,
                  knownCapabilityIds: hostIdsList,
                });
              }
            } catch (err) {
              await auditLog(context, "workshop_deploy", args, "error", "SET_ACTIVE_FAILED");
              const msg = err instanceof Error ? err.message : String(err);
              return `Deploy failed at setActive: ${msg}`;
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
            const lines = [
              "Bundle deployed successfully.",
              `  Version: ${version.versionId.slice(0, 12)}...`,
              `  Size: ${envelope.byteLength} bytes`,
              `  Main module: ${built.mainModule}`,
              `  Target: ${agentId === context.agentId ? "self" : agentId}`,
              `  Rationale: ${args.rationale ?? "(none)"}`,
            ];
            if (advisoryMissing.length > 0) {
              if (args.skipCatalogCheck) {
                lines.push(
                  `  Warning: skipCatalogCheck=true but target deployment may lack: ${advisoryMissing.join(", ")}. First dispatch will disable via guard if the target host does not bind these.`,
                );
              } else {
                lines.push(
                  `  Warning: declared capabilities not present in workshop host (advisory): ${advisoryMissing.join(", ")}. If the target deployment differs, validation may still succeed there.`,
                );
              }
            }
            return lines.join("\n");
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
              skipCatalogCheck: true,
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
          "The `@crabbykit/bundle-sdk` runtime is injected at build time — import it from `@crabbykit/bundle-sdk` in your src/index.ts. Do not write files under `_claw/`; the prefix is reserved.",
          "",
          "Self-editing is safe: the static brain is always available as a fallback.",
        ].join("\n"),
      },
    ],
  };
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
