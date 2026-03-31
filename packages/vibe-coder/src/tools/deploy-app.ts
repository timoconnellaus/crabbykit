import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

/** Metadata persisted per deployment. */
export interface DeployMetadata {
  deployId: string;
  files: string[];
  deployedAt: string;
  buildDir: string;
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
      "The app must already be built before calling this tool.",
    parameters: Type.Object({
      buildDir: Type.String({
        description:
          "Absolute path to the build output directory in the sandbox (e.g. /mnt/r2/my-app/dist)",
      }),
    }),
    execute: async ({ buildDir }) => {
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

      // Persist deploy metadata in capability storage
      const metadata: DeployMetadata = {
        deployId,
        files,
        deployedAt: new Date().toISOString(),
        buildDir,
      };

      if (context.storage) {
        await context.storage.put(`deploy:${deployId}`, metadata);
      }

      // Build the deploy URL
      const namespace = storage.namespace();
      const deployUrl = `/deploy/${namespace}/${deployId}/`;

      // Broadcast deploy_complete event
      context.broadcast("deploy_complete", { deployId, url: deployUrl, files });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `App deployed successfully!\n\n` +
              `Deploy ID: ${deployId}\n` +
              `URL: ${deployUrl}\n` +
              `Files: ${files.length} assets`,
          },
        ],
        details: { deployId, url: deployUrl, files, deployedAt: metadata.deployedAt },
      };
    },
  });
}
