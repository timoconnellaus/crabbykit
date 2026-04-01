import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import type { Modules } from "@cloudflare/worker-bundler";
import { createWorker } from "@cloudflare/worker-bundler";
import type { BackendOptions } from "../types.js";

/** Key used to store the current backend version in capability storage. */
const BACKEND_VERSION_KEY = "backend:version";

/**
 * Generate a wrapper module that injects the backend ID into DB calls.
 *
 * The wrapper imports the user's app module and intercepts `env.DB` so that
 * `env.DB.exec(sql, params)` transparently passes the backend ID to DbService.
 * This way the app code doesn't need to know about the backend ID.
 */
function generateWrapperModule(userMainModule: string, backendId: string): string {
  return `
import userApp from "./${userMainModule}";

const BACKEND_ID = ${JSON.stringify(backendId)};

function wrapDb(rawDb) {
  return {
    exec(sql, params = []) {
      return rawDb.exec(BACKEND_ID, sql, params);
    },
    batch(statements) {
      return rawDb.batch(BACKEND_ID, statements);
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const wrappedEnv = { ...env, DB: wrapDb(env.__DB_SERVICE) };
    const target = userApp.default || userApp;
    return target.fetch(request, wrappedEnv, ctx);
  }
};
`.trim();
}

/**
 * Collect source files from the container by listing and reading them.
 * Returns a map of relative paths to file contents.
 */
async function collectFiles(
  provider: SandboxProvider,
  sourceDir: string,
): Promise<Record<string, string>> {
  const listResult = await provider.exec(
    `find "${sourceDir}" -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.json" \\) | head -100`,
    { timeout: 15_000 },
  );

  if (listResult.exitCode !== 0 || !listResult.stdout.trim()) {
    throw new Error(`Failed to list files in ${sourceDir}: ${listResult.stderr}`);
  }

  const filePaths = listResult.stdout
    .trim()
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  const files: Record<string, string> = {};
  for (const absPath of filePaths) {
    const relPath = absPath.slice(sourceDir.length + 1);
    const readResult = await provider.exec(`cat "${absPath}"`, { timeout: 10_000 });
    if (readResult.exitCode === 0) {
      files[relPath] = readResult.stdout;
    }
  }

  return files;
}

export function createStartBackendTool(
  provider: SandboxProvider,
  context: AgentContext,
  backend: BackendOptions,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "start_backend",
    description:
      "Bundle and start (or restart) the backend server. " +
      "Reads the Hono server source from the sandbox, bundles it, and loads it as a dynamic worker " +
      "with a SQLite database backed by a Durable Object. Call this after writing or changing backend code. " +
      "The backend serves requests at /api/* relative to the preview URL.",
    parameters: Type.Object({
      entryPoint: Type.String({
        description:
          "Path to the backend entry file in the sandbox (e.g. /mnt/r2/my-app/server/index.ts)",
      }),
      backendId: Type.Optional(
        Type.String({
          description:
            "Unique ID for this backend's database. Different IDs get separate SQLite databases. " +
            "Defaults to the app directory name. Use a consistent ID to preserve data across restarts.",
        }),
      ),
      sourceDir: Type.Optional(
        Type.String({
          description:
            "Directory containing all backend source files. Defaults to the directory of entryPoint.",
        }),
      ),
    }),
    execute: async ({ entryPoint, backendId: backendIdArg, sourceDir: sourceDirArg }) => {
      const sourceDir = sourceDirArg ?? entryPoint.slice(0, entryPoint.lastIndexOf("/"));
      const entryRelative = entryPoint.slice(sourceDir.length + 1);

      // Derive backend ID from path if not provided
      const backendId =
        backendIdArg ?? `${context.agentId}:${sourceDir.split("/").filter(Boolean).pop() ?? "default"}`;

      // Verify entry point exists
      const checkResult = await provider.exec(`test -f "${entryPoint}" && echo "OK"`, {
        timeout: 10_000,
      });
      if (!checkResult.stdout.includes("OK")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Entry point "${entryPoint}" does not exist.`,
            },
          ],
          details: null,
        };
      }

      // Collect source files from the container
      let files: Record<string, string>;
      try {
        files = await collectFiles(provider, sourceDir);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error collecting backend source files: ${message}`,
            },
          ],
          details: null,
        };
      }

      if (!files[entryRelative]) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Entry point "${entryRelative}" not found in collected files. Found: ${Object.keys(files).join(", ")}`,
            },
          ],
          details: null,
        };
      }

      // Bundle the user's app code
      let userMainModule: string;
      let modules: Modules;
      try {
        const result = await createWorker({
          files,
          entryPoint: entryRelative,
        });
        userMainModule = result.mainModule;
        modules = result.modules;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error bundling backend: ${message}`,
            },
          ],
          details: null,
        };
      }

      // Generate a wrapper module that injects the backend ID into DB calls.
      // The wrapper is the actual mainModule; the user's app is imported from it.
      const wrapperCode = generateWrapperModule(userMainModule, backendId);
      modules["__claw_wrapper.js"] = wrapperCode;

      // Increment version for cache busting
      const currentVersion = (await context.storage?.get<number>(BACKEND_VERSION_KEY)) ?? 0;
      const newVersion = currentVersion + 1;

      // Load the bundled worker via WorkerLoader.
      // env.__DB_SERVICE is the raw DbService; the wrapper creates env.DB
      // with the backend ID baked in so app code just calls env.DB.exec(sql).
      const loaderKey = `backend/${backendId}/v${newVersion}`;
      backend.loader.get(loaderKey, async () => ({
        compatibilityDate: "2025-03-01",
        mainModule: "__claw_wrapper.js",
        modules,
        env: {
          __DB_SERVICE: backend.dbService,
        },
      }));

      // Persist state (bundle stored so the API proxy can reconstruct on cache miss)
      if (context.storage) {
        await context.storage.put(BACKEND_VERSION_KEY, newVersion);
        await context.storage.put("backend:loaderKey", loaderKey);
        await context.storage.put("backend:backendId", backendId);
        await context.storage.put("backend:bundle", {
          mainModule: "__claw_wrapper.js",
          modules,
        });
      }

      // Broadcast backend_started event
      context.broadcast("backend_started", {
        version: newVersion,
        backendId,
        loaderKey,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Backend started (v${newVersion}, backend ID: ${backendId}). ` +
              `The API is now available at /api/* relative to the preview URL. ` +
              `Bundled ${Object.keys(files).length} source files. ` +
              `The database is a Durable Object with SQLite — data persists across restarts with the same backend ID.`,
          },
        ],
        details: {
          version: newVersion,
          backendId,
          loaderKey,
          files: Object.keys(files),
        },
      };
    },
  });
}
