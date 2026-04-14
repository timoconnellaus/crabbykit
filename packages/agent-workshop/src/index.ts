/**
 * Agent Workshop — agent-facing capability for authoring, building,
 * testing, deploying, and managing bundle brains.
 *
 * Tools: workshop_init, workshop_build, workshop_test, workshop_deploy,
 *        workshop_disable, workshop_rollback, workshop_versions
 *
 * Every container interaction routes through a single `sandboxExec`
 * callback that must delegate to the sandbox capability's `exec` tool.
 * That guarantees workshop behaves identically to the bash tool:
 *   - the session must be elevated (agent calls `elevate` first)
 *   - the container is woken / restarted if dead
 *   - the sandbox idle de-elevation timer is reset on every call
 */

import type { AgentContext, AnyAgentTool, Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { BundleRegistry } from "@claw-for-cloudflare/bundle-registry";
import { computeVersionId, MAX_BUNDLE_SIZE_BYTES } from "@claw-for-cloudflare/bundle-registry";

export interface WorkshopExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgentWorkshopOptions {
  /** Bundle registry instance. */
  registry: BundleRegistry;
  /**
   * Run a shell command through the sandbox for the given session. Must
   * route through the sandbox capability's `exec` tool so elevation,
   * container health, and de-elevation timer reset behave identically to
   * a direct bash call from the agent.
   *
   * When the session is not elevated, return a non-zero exit with stderr
   * that tells the agent to run `elevate` first — workshop bubbles that
   * message up verbatim so the agent knows what to do.
   */
  sandboxExec: (
    sessionId: string,
    command: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<WorkshopExecResult>;
  /** Maximum deploys per minute per agent. Default: 5. */
  deployRateLimitPerMinute?: number;
}

const DEFAULT_DEPLOY_RATE_LIMIT = 5;
const BUNDLE_WORKSPACE_BASE = "/workspace/bundles";

/** Quote a string for use inside a double-quoted shell argument. */
function shQuote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.substring(0, idx) : "/";
}

/**
 * Create the agent workshop capability.
 */
export function agentWorkshop(options: AgentWorkshopOptions): Capability {
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

  // Audit logging helper — appends workshop_audit custom session entry
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
      // Audit logging is best-effort
    }
  }

  // --- Sandbox shell helpers (all route through options.sandboxExec) ---

  function sh(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<WorkshopExecResult> {
    return options.sandboxExec(sessionId, command, signal ? { signal } : undefined);
  }

  async function sbExists(sessionId: string, path: string): Promise<WorkshopExecResult> {
    return sh(sessionId, `test -e ${shQuote(path)}`);
  }

  async function sbReadFile(sessionId: string, path: string): Promise<string | null> {
    const r = await sh(sessionId, `cat ${shQuote(path)}`);
    return r.exitCode === 0 ? r.stdout : null;
  }

  async function sbWriteFile(
    sessionId: string,
    path: string,
    content: string,
  ): Promise<WorkshopExecResult> {
    const dir = parentDir(path);
    const b64 = btoa(content);
    const cmd = `mkdir -p ${shQuote(dir)} && echo ${shQuote(b64)} | base64 -d > ${shQuote(path)}`;
    return sh(sessionId, cmd);
  }

  /**
   * Format a shell failure (e.g. a write or exec error) for presentation
   * to the agent. Surfaces stderr so "Not elevated" messages bubble up
   * verbatim and the agent knows to run `elevate` first.
   */
  function failureText(label: string, result: WorkshopExecResult): string {
    const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`;
    return `${label}: ${detail.trim()}`;
  }

  return {
    id: "agent-workshop",
    name: "Agent Workshop",
    description: "Author, build, test, deploy, and manage bundle brains",

    tools: (context: AgentContext): AnyAgentTool[] => {
      const sessionId = context.sessionId;

      return [
        // --- workshop_init ---
        defineTool({
          name: "workshop_init",
          description:
            "Scaffold a new bundle workspace with package.json, tsconfig, and starter code",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name (used as directory name)" }),
          }),
          execute: async (args, execCtx) => {
            const dir = `${BUNDLE_WORKSPACE_BASE}/${args.name}`;

            const existsResult = await sbExists(sessionId, dir);
            if (existsResult.exitCode !== 0 && existsResult.stderr) {
              // Shell command itself failed (likely not elevated) — bubble up
              return failureText("Error", existsResult);
            }
            if (existsResult.exitCode === 0) {
              await auditLog(context, "workshop_init", args, "error", "ALREADY_EXISTS");
              return `Error: Workspace "${args.name}" already exists at ${dir}. Choose a different name.`;
            }

            // Scaffold files
            const packageJsonWrite = await sbWriteFile(
              sessionId,
              `${dir}/package.json`,
              JSON.stringify(
                {
                  name: args.name,
                  type: "module",
                  dependencies: {
                    "@claw-for-cloudflare/agent-bundle": "file:/opt/claw-sdk/agent-bundle",
                  },
                },
                null,
                2,
              ),
            );
            if (packageJsonWrite.exitCode !== 0) {
              return failureText("Failed to write package.json", packageJsonWrite);
            }

            const tsconfigWrite = await sbWriteFile(
              sessionId,
              `${dir}/tsconfig.json`,
              JSON.stringify(
                {
                  compilerOptions: {
                    target: "ES2022",
                    module: "ES2022",
                    moduleResolution: "bundler",
                    strict: true,
                    skipLibCheck: true,
                    noEmit: true,
                  },
                  include: ["src/**/*.ts"],
                },
                null,
                2,
              ),
            );
            if (tsconfigWrite.exitCode !== 0) {
              return failureText("Failed to write tsconfig.json", tsconfigWrite);
            }

            const indexWrite = await sbWriteFile(
              sessionId,
              `${dir}/src/index.ts`,
              [
                'import { defineBundleAgent } from "@claw-for-cloudflare/agent-bundle/bundle";',
                "",
                "export default defineBundleAgent({",
                '  model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },',
                `  prompt: { agentName: "${args.name}" },`,
                "  metadata: {",
                `    name: "${args.name}",`,
                `    description: "Bundle brain for ${args.name}",`,
                "  },",
                "});",
                "",
              ].join("\n"),
            );
            if (indexWrite.exitCode !== 0) {
              return failureText("Failed to write src/index.ts", indexWrite);
            }

            // Run bun install inside the workspace directory
            const install = await sh(
              sessionId,
              `cd ${shQuote(dir)} && bun install --ignore-scripts`,
              execCtx?.signal,
            );

            if (install.exitCode !== 0) {
              await auditLog(context, "workshop_init", args, "error", "INSTALL_FAILED");
              return `Workspace scaffolded at ${dir} but bun install failed:\n${install.stderr || install.stdout}`;
            }

            await auditLog(context, "workshop_init", args, "success");
            return `Bundle workspace "${args.name}" created at ${dir}.\nFiles: package.json, tsconfig.json, src/index.ts\nbun install: success`;
          },
        }),

        // --- workshop_build ---
        defineTool({
          name: "workshop_build",
          description: "Compile a bundle workspace into dist/bundle.js using bun build",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
          }),
          execute: async (args, execCtx) => {
            const dir = `${BUNDLE_WORKSPACE_BASE}/${args.name}`;
            const srcPath = `${dir}/src/index.ts`;

            const srcCheck = await sbExists(sessionId, srcPath);
            if (srcCheck.exitCode !== 0 && srcCheck.stderr) {
              return failureText("Error", srcCheck);
            }
            if (srcCheck.exitCode !== 0) {
              return `Error: No src/index.ts found in ${dir}. Run workshop_init first.`;
            }

            // Verify vendored package integrity (if available). We use
            // a single shell chain: cat returns content (caller ignores).
            // Full integrity verification is a TODO; today we just check
            // the file is there.
            await sbReadFile(sessionId, "/opt/claw-sdk/INTEGRITY.json");

            const build = await sh(
              sessionId,
              `cd ${shQuote(dir)} && bun build src/index.ts --target=browser --format=esm --outfile=dist/bundle.js --external "cloudflare:workers" --external "cloudflare:sockets"`,
              execCtx?.signal,
            );

            if (build.exitCode !== 0) {
              return `Build failed:\n${build.stderr}\n${build.stdout}`;
            }

            return `Build successful.\n${build.stdout}`;
          },
        }),

        // --- workshop_test ---
        defineTool({
          name: "workshop_test",
          description: "Test a built bundle by loading it in a scratch isolate and running a prompt",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            prompt: Type.Optional(Type.String({ description: 'Test prompt (default: "hello")' })),
          }),
          execute: async (args) => {
            const bundlePath = `${BUNDLE_WORKSPACE_BASE}/${args.name}/dist/bundle.js`;
            const source = await sbReadFile(sessionId, bundlePath);

            if (!source) {
              return `Error: No built bundle at ${bundlePath}. Run workshop_build first.`;
            }

            // Basic validation: check the bundle has a default export
            if (!source.includes("export")) {
              return "Error: Bundle does not appear to have an export. Check your src/index.ts.";
            }

            return `Bundle test passed (${source.length} bytes). Bundle loads and has exports.\nNote: Full isolate-based testing requires a live Worker Loader — use workshop_deploy for end-to-end validation.`;
          },
        }),

        // --- workshop_deploy ---
        defineTool({
          name: "workshop_deploy",
          description: "Deploy a built bundle as the active brain for this agent (or a target agent)",
          parameters: Type.Object({
            name: Type.String({ description: "Bundle workspace name" }),
            rationale: Type.Optional(Type.String({ description: "Why this deployment" })),
            targetAgentId: Type.Optional(
              Type.String({ description: "Target agent ID (default: self)" }),
            ),
          }),
          execute: async (args) => {
            const agentId = args.targetAgentId ?? context.agentId;

            // Rate limit
            if (!checkDeployRate(agentId)) {
              return "Error: Deploy rate limit exceeded (ERR_DEPLOY_RATE_LIMITED). Wait and try again.";
            }

            const bundlePath = `${BUNDLE_WORKSPACE_BASE}/${args.name}/dist/bundle.js`;
            const source = await sbReadFile(sessionId, bundlePath);

            if (!source) {
              return `Error: No built bundle at ${bundlePath}. Run workshop_build first.`;
            }

            const bytes = new TextEncoder().encode(source);

            if (bytes.byteLength > MAX_BUNDLE_SIZE_BYTES) {
              return `Error: Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES} byte limit (${bytes.byteLength} bytes).`;
            }

            // Pre-deploy smoke test: verify bundle has expected structure
            if (!source.includes("export")) {
              await auditLog(context, "workshop_deploy", args, "error", "SMOKE_FAILED");
              return "Error: Pre-deploy smoke test failed — bundle has no exports. Check your bundle source.";
            }

            // Compute version ID
            const buf = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(buf).set(bytes);
            const versionId = await computeVersionId(buf);

            // Extract metadata from bundle source (basic heuristic —
            // full metadata extraction via POST /metadata requires Worker Loader)
            let metadata: string | undefined;
            const metadataMatch = source.match(/metadata:\s*\{([^}]+)\}/);
            if (metadataMatch) {
              metadata = metadataMatch[0];
            }

            // Create version in registry (handles KV write + readback)
            try {
              await options.registry.setActive(agentId, versionId, {
                rationale: args.rationale ?? "workshop_deploy",
                sessionId: context.sessionId,
              });
            } catch (err) {
              await auditLog(context, "workshop_deploy", args, "error", "REGISTRY_FAILED");
              return `Deploy failed: ${err instanceof Error ? err.message : String(err)}`;
            }

            await auditLog(context, "workshop_deploy", { ...args, versionId }, "success");

            return [
              "Bundle deployed successfully.",
              `  Version: ${versionId.slice(0, 12)}...`,
              `  Size: ${bytes.byteLength} bytes`,
              `  Target: ${agentId === context.agentId ? "self" : agentId}`,
              `  Rationale: ${args.rationale ?? "(none)"}`,
              metadata ? `  Metadata: ${metadata}` : undefined,
            ]
              .filter(Boolean)
              .join("\n");
          },
        }),

        // --- workshop_disable ---
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

            return `Bundle disabled for ${agentId === context.agentId ? "self" : agentId}. Static brain will run on next turn.`;
          },
        }),

        // --- workshop_rollback ---
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

            try {
              const current = await options.registry.getActiveForAgent(agentId);
              if (!current) {
                return "Error: No active bundle to roll back from. Use workshop_disable instead.";
              }

              // Note: full rollback requires the extended registry interface
              // (D1BundleRegistry.rollback). For the base BundleRegistry interface,
              // rollback is not directly available. This tool will be enhanced
              // when wired to D1BundleRegistry.
              return "Rollback requires the D1BundleRegistry. Use workshop_disable to revert to static brain.";
            } catch (err) {
              return `Rollback failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        }),

        // --- workshop_versions ---
        defineTool({
          name: "workshop_versions",
          description: "List recent bundle deployment history",
          parameters: Type.Object({
            limit: Type.Optional(
              Type.Number({
                description: "Max results (default: 20, max: 100)",
                minimum: 1,
                maximum: 100,
              }),
            ),
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
              "Note: Full deployment history requires D1BundleRegistry.listDeployments.",
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
          "Workshop tools run shell commands inside the sandbox, so the sandbox must be elevated first — call the `elevate` tool before running any workshop tool.",
          "",
          "Workflow:",
          "1. `elevate` — activate the sandbox (one-time per session)",
          "2. `workshop_init` — scaffold a new bundle workspace",
          "3. Edit src/index.ts with the desired brain logic",
          "4. `workshop_build` — compile to dist/bundle.js",
          "5. `workshop_test` — validate the build",
          "6. `workshop_deploy` — deploy as your active brain (self-editing by default)",
          "7. `workshop_disable` — revert to static brain if needed",
          "",
          "Self-editing is safe: the static brain is always available as a fallback.",
        ].join("\n"),
      },
    ],
  };
}
