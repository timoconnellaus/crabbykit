import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import type { BackendBundle } from "../backend-api-proxy.js";

/** Metadata persisted per deployment. */
export interface DeployMetadata {
  deployId: string;
  files: string[];
  deployedAt: string;
  buildDir: string;
  hasBackend?: boolean;
}

export function createDeployAppTool(
  provider: SandboxProvider,
  context: AgentContext,
  storage: AgentStorage,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "deploy_app",
    description:
      "Deploy a built web app. Takes the path to a Vite build output directory (e.g. dist/) " +
      "and deploys it as a static site served via a dynamic worker. " +
      "The app must already be built before calling this tool. " +
      "If the app has a backend, also provide the backend entry point to deploy it alongside the frontend.",
    guidance:
      "Deploy a built web app as a static site. " +
      "The app must be built first (e.g., via Vite build in the sandbox). " +
      "If the app has a backend, provide the backend entry point to deploy it alongside the frontend.",
    parameters: Type.Object({
      buildDir: Type.String({
        description:
          "Absolute path to the build output directory in the sandbox (e.g. /mnt/r2/my-app/dist)",
      }),
      backendEntry: Type.Optional(
        Type.String({
          description:
            "Path to backend entry file (e.g. /mnt/r2/my-app/server/index.ts). " +
            "When provided, the backend is bundled and deployed alongside the frontend.",
        }),
      ),
    }),
    execute: async ({ buildDir, backendEntry }) => {
      // Validate the build directory exists
      const checkResult = await provider.exec(`test -d "${buildDir}" && echo "OK"`, {
        timeout: 10_000,
      });
      if (!checkResult.stdout.includes("OK")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Build directory "${buildDir}" does not exist. Build the app first (e.g. \`bun run build\`).`,
            },
          ],
          details: null,
        };
      }

      // List all files in the build directory
      const listResult = await provider.exec(
        `find "${buildDir}" -type f | sed "s|^${buildDir}/||"`,
        { timeout: 30_000 },
      );
      if (listResult.exitCode !== 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing files in "${buildDir}": ${listResult.stderr}`,
            },
          ],
          details: null,
        };
      }

      const files = listResult.stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

      if (files.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Build directory "${buildDir}" contains no files.`,
            },
          ],
          details: null,
        };
      }

      // Generate deploy ID
      const deployId = crypto.randomUUID().slice(0, 8);
      const deployPath = `/mnt/r2/deploys/${deployId}`;

      // Copy build output to deploy path on R2 (via FUSE mount)
      const copyResult = await provider.exec(
        `mkdir -p "${deployPath}" && cp -r "${buildDir}/." "${deployPath}/"`,
        { timeout: 60_000 },
      );
      if (copyResult.exitCode !== 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error copying build to deploy path: ${copyResult.stderr}`,
            },
          ],
          details: null,
        };
      }

      // Bundle and store backend if provided
      let hasBackend = false;
      if (backendEntry) {
        const backendResult = await bundleAndStoreBackend(provider, backendEntry, deployPath);
        if (backendResult.error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Frontend deployed but backend failed: ${backendResult.error}`,
              },
            ],
            details: null,
          };
        }
        hasBackend = true;
      }

      // Persist deploy metadata in capability storage
      const metadata: DeployMetadata = {
        deployId,
        files,
        deployedAt: new Date().toISOString(),
        buildDir,
        hasBackend,
      };

      if (context.storage) {
        await context.storage.put(`deploy:${deployId}`, metadata);
      }

      // Build the deploy URL
      const namespace = storage.namespace();
      const deployUrl = `/deploy/${namespace}/${deployId}/`;

      // Broadcast deploy_complete event
      context.broadcast("deploy_complete", {
        deployId,
        url: deployUrl,
        files,
        hasBackend,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `App deployed successfully!\n\n` +
              `Deploy ID: ${deployId}\n` +
              `URL: ${deployUrl}\n` +
              `Files: ${files.length} assets` +
              (hasBackend ? "\nBackend: deployed (API available at /api/*)" : ""),
          },
        ],
        details: {
          deployId,
          url: deployUrl,
          files,
          deployedAt: metadata.deployedAt,
          hasBackend,
        },
      };
    },
  });
}

/**
 * Read backend source files from the sandbox, bundle them, and store
 * the bundle as JSON in the deploy directory on R2.
 */
async function bundleAndStoreBackend(
  provider: SandboxProvider,
  entryPoint: string,
  deployPath: string,
): Promise<{ error?: string }> {
  const sourceDir = entryPoint.slice(0, entryPoint.lastIndexOf("/"));
  const entryRelative = entryPoint.slice(sourceDir.length + 1);

  // List backend source files
  const listResult = await provider.exec(
    `find "${sourceDir}" -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.json" \\) | head -100`,
    { timeout: 15_000 },
  );
  if (listResult.exitCode !== 0 || !listResult.stdout.trim()) {
    return { error: `Failed to list backend files in ${sourceDir}: ${listResult.stderr}` };
  }

  const filePaths = listResult.stdout
    .trim()
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  // Read files
  const files: Record<string, string> = {};
  for (const absPath of filePaths) {
    const relPath = absPath.slice(sourceDir.length + 1);
    const readResult = await provider.exec(`cat "${absPath}"`, { timeout: 10_000 });
    if (readResult.exitCode === 0) {
      files[relPath] = readResult.stdout;
    }
  }

  if (!files[entryRelative]) {
    return { error: `Entry point "${entryRelative}" not found in backend source files` };
  }

  // Bundle using worker-bundler
  const { createWorker } = await import("@cloudflare/worker-bundler");
  let bundle: BackendBundle;
  try {
    const result = await createWorker({ files, entryPoint: entryRelative });
    bundle = { mainModule: result.mainModule, modules: result.modules };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `Backend bundling failed: ${message}` };
  }

  // Store bundle as JSON in the deploy directory
  const bundleJson = JSON.stringify(bundle);
  const bundlePath = `${deployPath}/.backend/bundle.json`;
  const writeResult = await provider.exec(
    `mkdir -p "${deployPath}/.backend" && cat > "${bundlePath}" << 'BUNDLE_EOF'\n${bundleJson}\nBUNDLE_EOF`,
    { timeout: 30_000 },
  );
  if (writeResult.exitCode !== 0) {
    return { error: `Failed to write backend bundle: ${writeResult.stderr}` };
  }

  return {};
}
