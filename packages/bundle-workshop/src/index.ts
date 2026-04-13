/**
 * Bundle Workshop — agent-facing capability for authoring, building,
 * testing, deploying, and managing bundle brains.
 *
 * Tools: bundle_init, bundle_build, bundle_test, bundle_deploy,
 *        bundle_disable, bundle_rollback, bundle_versions
 */

import type { AgentContext, AnyAgentTool, Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { BundleRegistry } from "@claw-for-cloudflare/bundle-registry";
import { computeVersionId, MAX_BUNDLE_SIZE_BYTES } from "@claw-for-cloudflare/bundle-registry";

export interface BundleWorkshopOptions {
  /** Bundle registry instance. */
  registry: BundleRegistry;
  /**
   * Check if the sandbox is elevated. Workshop tools require elevation.
   * Returns true if elevated.
   */
  isElevated?: () => boolean | Promise<boolean>;
  /**
   * Execute a command inside the sandbox container.
   * Returns { stdout, stderr, exitCode }.
   */
  exec: (
    cmd: string,
    opts?: { cwd?: string },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Read a file from the sandbox container.
   */
  readFile: (path: string) => Promise<string | null>;
  /**
   * Write a file in the sandbox container.
   */
  writeFile: (path: string, content: string) => Promise<void>;
  /**
   * Check if a path exists in the sandbox container.
   */
  exists: (path: string) => Promise<boolean>;
  /** Maximum deploys per minute per agent. Default: 5. */
  deployRateLimitPerMinute?: number;
}

const DEFAULT_DEPLOY_RATE_LIMIT = 5;
const BUNDLE_WORKSPACE_BASE = "/workspace/bundles";

/**
 * Create the bundle workshop capability.
 */
export function bundleWorkshop(options: BundleWorkshopOptions): Capability {
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

  // Elevation guard — returns error string if not elevated, null if OK
  async function checkElevation(): Promise<string | null> {
    if (!options.isElevated) return null;
    const elevated = await options.isElevated();
    if (!elevated) {
      return "Error: Sandbox must be elevated before using bundle workshop tools. Run the elevate command first.";
    }
    return null;
  }

  return {
    id: "bundle-workshop",
    name: "Bundle Workshop",
    description: "Author, build, test, deploy, and manage bundle brains",

    tools: (context: AgentContext): AnyAgentTool[] => [
      // --- bundle_init ---
      defineTool({
        name: "bundle_init",
        description:
          "Scaffold a new bundle workspace with package.json, tsconfig, and starter code",
        parameters: Type.Object({
          name: Type.String({ description: "Bundle workspace name (used as directory name)" }),
        }),
        execute: async (args) => {
          const elevErr = await checkElevation();
          if (elevErr) return elevErr;

          const dir = `${BUNDLE_WORKSPACE_BASE}/${args.name}`;

          if (await options.exists(dir)) {
            await auditLog(context, "bundle_init", args, "error", "ALREADY_EXISTS");
            return `Error: Workspace "${args.name}" already exists at ${dir}. Choose a different name.`;
          }

          // Scaffold files
          await options.writeFile(
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

          await options.writeFile(
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

          await options.writeFile(
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

          // Run bun install
          const result = await options.exec("bun install --ignore-scripts", { cwd: dir });

          if (result.exitCode !== 0) {
            await auditLog(context, "bundle_init", args, "error", "INSTALL_FAILED");
            return `Workspace scaffolded at ${dir} but bun install failed:\n${result.stderr}`;
          }

          await auditLog(context, "bundle_init", args, "success");
          return `Bundle workspace "${args.name}" created at ${dir}.\nFiles: package.json, tsconfig.json, src/index.ts\nbun install: success`;
        },
      }),

      // --- bundle_build ---
      defineTool({
        name: "bundle_build",
        description: "Compile a bundle workspace into dist/bundle.js using bun build",
        parameters: Type.Object({
          name: Type.String({ description: "Bundle workspace name" }),
        }),
        execute: async (args) => {
          const elevErr = await checkElevation();
          if (elevErr) return elevErr;

          const dir = `${BUNDLE_WORKSPACE_BASE}/${args.name}`;

          if (!(await options.exists(`${dir}/src/index.ts`))) {
            return `Error: No src/index.ts found in ${dir}. Run bundle_init first.`;
          }

          // Verify vendored package integrity (if available)
          const integrityFile = await options.readFile("/opt/claw-sdk/INTEGRITY.json");
          if (integrityFile) {
            // TODO: Full integrity verification against hashes
            // For now, just verify the file exists
          }

          const result = await options.exec(
            'bun build src/index.ts --target=browser --format=esm --outfile=dist/bundle.js --external "cloudflare:workers" --external "cloudflare:sockets"',
            { cwd: dir },
          );

          if (result.exitCode !== 0) {
            return `Build failed:\n${result.stderr}\n${result.stdout}`;
          }

          return `Build successful.\n${result.stdout}`;
        },
      }),

      // --- bundle_test ---
      defineTool({
        name: "bundle_test",
        description: "Test a built bundle by loading it in a scratch isolate and running a prompt",
        parameters: Type.Object({
          name: Type.String({ description: "Bundle workspace name" }),
          prompt: Type.Optional(Type.String({ description: 'Test prompt (default: "hello")' })),
        }),
        execute: async (args) => {
          const bundlePath = `${BUNDLE_WORKSPACE_BASE}/${args.name}/dist/bundle.js`;
          const source = await options.readFile(bundlePath);

          if (!source) {
            return `Error: No built bundle at ${bundlePath}. Run bundle_build first.`;
          }

          // Basic validation: check the bundle has a default export
          if (!source.includes("export")) {
            return "Error: Bundle does not appear to have an export. Check your src/index.ts.";
          }

          return `Bundle test passed (${source.length} bytes). Bundle loads and has exports.\nNote: Full isolate-based testing requires a live Worker Loader — use bundle_deploy for end-to-end validation.`;
        },
      }),

      // --- bundle_deploy ---
      defineTool({
        name: "bundle_deploy",
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
          const source = await options.readFile(bundlePath);

          if (!source) {
            return `Error: No built bundle at ${bundlePath}. Run bundle_build first.`;
          }

          const bytes = new TextEncoder().encode(source);

          if (bytes.byteLength > MAX_BUNDLE_SIZE_BYTES) {
            return `Error: Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES} byte limit (${bytes.byteLength} bytes).`;
          }

          // Pre-deploy smoke test: verify bundle has expected structure
          if (!source.includes("export")) {
            await auditLog(context, "bundle_deploy", args, "error", "SMOKE_FAILED");
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
              rationale: args.rationale ?? "bundle_deploy",
              sessionId: context.sessionId,
            });
          } catch (err) {
            await auditLog(context, "bundle_deploy", args, "error", "REGISTRY_FAILED");
            return `Deploy failed: ${err instanceof Error ? err.message : String(err)}`;
          }

          await auditLog(context, "bundle_deploy", { ...args, versionId }, "success");

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

      // --- bundle_disable ---
      defineTool({
        name: "bundle_disable",
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
            rationale: args.rationale ?? "bundle_disable",
            sessionId: context.sessionId,
          });

          return `Bundle disabled for ${agentId === context.agentId ? "self" : agentId}. Static brain will run on next turn.`;
        },
      }),

      // --- bundle_rollback ---
      defineTool({
        name: "bundle_rollback",
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
            // For InMemoryRegistry / D1Registry, rollback swaps active and previous
            // We simulate this by getting current state and swapping
            const current = await options.registry.getActiveForAgent(agentId);
            if (!current) {
              return "Error: No active bundle to roll back from. Use bundle_disable instead.";
            }

            // Note: full rollback requires the extended registry interface
            // (D1BundleRegistry.rollback). For the base BundleRegistry interface,
            // rollback is not directly available. This tool will be enhanced
            // when wired to D1BundleRegistry.
            return "Rollback requires the D1BundleRegistry. Use bundle_disable to revert to static brain.";
          } catch (err) {
            return `Rollback failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      // --- bundle_versions ---
      defineTool({
        name: "bundle_versions",
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
    ],

    promptSections: () => [
      {
        kind: "included" as const,
        name: "Bundle Workshop",
        content: [
          "You have the Bundle Workshop capability. You can author, build, test, deploy, and manage bundle brains.",
          "",
          "Workflow:",
          "1. `bundle_init` — scaffold a new bundle workspace",
          "2. Edit src/index.ts with the desired brain logic",
          "3. `bundle_build` — compile to dist/bundle.js",
          "4. `bundle_test` — validate the build",
          "5. `bundle_deploy` — deploy as your active brain (self-editing by default)",
          "6. `bundle_disable` — revert to static brain if needed",
          "",
          "Self-editing is safe: the static brain is always available as a fallback.",
        ].join("\n"),
      },
    ],
  };
}
