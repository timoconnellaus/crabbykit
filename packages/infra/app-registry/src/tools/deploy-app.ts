import type { AgentContext, AgentTool } from "@crabbykit/agent-runtime";
import { defineTool, Type } from "@crabbykit/agent-runtime";
import type { SandboxProvider } from "@crabbykit/sandbox";
import type { AppStore } from "../app-store.js";
import { slugify } from "../slugify.js";
import type { BackendOptions } from "../types.js";

export function createDeployAppTool(
  provider: SandboxProvider,
  context: AgentContext,
  appStore: AppStore,
  broadcastAppList: () => void,
  backend?: BackendOptions,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast
): AgentTool<any> {
  return defineTool({
    name: "deploy_app",
    description:
      "Deploy a built web app with versioning. Requires a clean git working tree. " +
      "On first deploy, the app is auto-created with the given name. " +
      "On subsequent deploys, a new version is added. " +
      "If the app has a backend, provide the backend entry point.",
    guidance:
      "Deploy a built web app with versioning. Requires a clean git working tree — commit changes first. On first deploy, the app is auto-created. On subsequent deploys, a new version is added. Deployed apps are accessible at /apps/{slug}/ with automatic SPA routing.",
    parameters: Type.Object({
      name: Type.String({
        description: "Human-readable app name (e.g. 'Todo App'). Used to derive the URL slug.",
      }),
      slug: Type.Optional(
        Type.String({
          description: "URL-safe slug (e.g. 'todo-app'). Auto-derived from name if not provided.",
        }),
      ),
      buildDir: Type.String({
        description:
          "Absolute path to the build output directory in the sandbox (e.g. /workspace/my-app/dist)",
      }),
      backendEntry: Type.Optional(
        Type.String({
          description:
            "Path to backend entry file (e.g. /workspace/my-app/server/index.ts). " +
            "When provided, the backend is bundled and deployed alongside the frontend.",
        }),
      ),
    }),
    execute: async ({ name, slug: providedSlug, buildDir, backendEntry }) => {
      const appSlug = providedSlug || slugify(name);

      // Check git working tree is clean
      const gitStatusResult = await provider.exec("git status --porcelain", {
        timeout: 10_000,
        cwd: buildDir.split("/dist")[0], // Navigate to project root
      });
      if (gitStatusResult.exitCode !== 0) {
        return errorResult(`Failed to check git status: ${gitStatusResult.stderr}`);
      }
      if (gitStatusResult.stdout.trim().length > 0) {
        return errorResult(
          "Uncommitted changes detected. Please commit your changes before deploying.\n\n" +
            `Dirty files:\n${gitStatusResult.stdout.trim()}`,
        );
      }

      // Read HEAD commit hash and message
      const headResult = await provider.exec('git rev-parse HEAD && git log -1 --format="%s"', {
        timeout: 10_000,
        cwd: buildDir.split("/dist")[0],
      });
      if (headResult.exitCode !== 0) {
        return errorResult(`Failed to read git HEAD: ${headResult.stderr}`);
      }
      const [commitHash, ...messageParts] = headResult.stdout.trim().split("\n");
      const commitMessage = messageParts.join("\n").trim() || null;

      // Validate build directory exists
      const checkResult = await provider.exec(`test -d "${buildDir}" && echo "OK"`, {
        timeout: 10_000,
      });
      if (!checkResult.stdout.includes("OK")) {
        return errorResult(`Build directory "${buildDir}" does not exist. Build the app first.`);
      }

      // List all files in build directory
      const listResult = await provider.exec(
        `find "${buildDir}" -type f | sed "s|^${buildDir}/||"`,
        { timeout: 30_000 },
      );
      if (listResult.exitCode !== 0) {
        return errorResult(`Error listing files in "${buildDir}": ${listResult.stderr}`);
      }

      const files = listResult.stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

      if (files.length === 0) {
        return errorResult(`Build directory "${buildDir}" contains no files.`);
      }

      // Auto-create app if it doesn't exist
      let app = appStore.getBySlug(appSlug);
      if (!app) {
        try {
          app = appStore.create(name, appSlug);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("UNIQUE constraint")) {
            return errorResult(`Slug "${appSlug}" is already taken. Provide a different slug.`);
          }
          throw e;
        }
      }

      // Generate deploy ID and create version path
      const deployId = crypto.randomUUID().slice(0, 8);
      const versionNum = app.currentVersion + 1;
      const deployPath = `/workspace/apps/${appSlug}/.deploys/v${versionNum}`;

      // Copy build output to deploy path
      const copyResult = await provider.exec(
        `mkdir -p "${deployPath}" && cp -r "${buildDir}/." "${deployPath}/"`,
        { timeout: 60_000 },
      );
      if (copyResult.exitCode !== 0) {
        return errorResult(`Error copying build to deploy path: ${copyResult.stderr}`);
      }

      // Bundle and store backend if provided
      let hasBackend = false;
      if (backendEntry && backend) {
        const backendResult = await bundleAndStoreBackend(provider, backendEntry, deployPath);
        if (backendResult.error) {
          return `Frontend deployed but backend failed: ${backendResult.error}`;
        }
        hasBackend = true;
      }

      // Write CURRENT file
      const currentPath = `/workspace/apps/${appSlug}/.deploys/CURRENT`;
      await provider.exec(`echo "${versionNum}" > "${currentPath}"`, { timeout: 10_000 });

      // Register version in SQL
      appStore.addVersion(app.id, {
        deployId,
        commitHash,
        message: commitMessage,
        files,
        hasBackend,
      });

      // Build deploy URL
      const deployUrl = `/apps/${appSlug}/`;

      // Broadcast updated app list and deploy event
      broadcastAppList();
      context.broadcast("deploy_complete", {
        appSlug,
        deployId,
        version: versionNum,
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
              `App: ${name} (${appSlug})\n` +
              `Version: v${versionNum}\n` +
              `Commit: ${commitHash.slice(0, 7)} — ${commitMessage ?? "(no message)"}\n` +
              `URL: ${deployUrl}\n` +
              `Files: ${files.length} assets` +
              (hasBackend ? "\nBackend: deployed (API available at /api/*)" : ""),
          },
        ],
        details: {
          appSlug,
          deployId,
          version: versionNum,
          commitHash,
          commitMessage,
          url: deployUrl,
          files,
          hasBackend,
        },
      };
    },
  });
}

function errorResult(text: string) {
  return `Error: ${text}`;
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

  const sourceFiles: Record<string, string> = {};
  for (const absPath of filePaths) {
    const relPath = absPath.slice(sourceDir.length + 1);
    const readResult = await provider.exec(`cat "${absPath}"`, { timeout: 10_000 });
    if (readResult.exitCode === 0) {
      sourceFiles[relPath] = readResult.stdout;
    }
  }

  if (!sourceFiles[entryRelative]) {
    return { error: `Entry point "${entryRelative}" not found in backend source files` };
  }

  const { createWorker } = await import("@cloudflare/worker-bundler");
  let bundle: { mainModule: string; modules: unknown };
  try {
    const result = await createWorker({ files: sourceFiles, entryPoint: entryRelative });
    bundle = { mainModule: result.mainModule, modules: result.modules };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `Backend bundling failed: ${message}` };
  }

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
