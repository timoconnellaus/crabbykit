import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import type { AppStore } from "../app-store.js";

export function createRollbackAppTool(
  provider: SandboxProvider,
  context: AgentContext,
  appStore: AppStore,
  broadcastAppList: () => void,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast
): AgentTool<any> {
  return defineTool({
    name: "rollback_app",
    description: "Rollback a deployed app to a previous version.",
    guidance:
      "Revert a deployed app to a previous version. Use get_app_history first to see available versions and their commit info.",
    parameters: Type.Object({
      slug: Type.String({ description: "The app slug (e.g. 'todo-app')" }),
      version: Type.Number({ description: "The version number to rollback to" }),
    }),
    execute: async ({ slug, version }) => {
      const app = appStore.getBySlug(slug);
      if (!app) {
        return {
          content: [{ type: "text" as const, text: `Error: App "${slug}" not found.` }],
          details: null,
        };
      }

      const targetVersion = appStore.getVersion(app.id, version);
      if (!targetVersion) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Version ${version} does not exist for app "${slug}".`,
            },
          ],
          details: null,
        };
      }

      // Update CURRENT file
      const currentPath = `/workspace/apps/${slug}/.deploys/CURRENT`;
      await provider.exec(`echo "${version}" > "${currentPath}"`, { timeout: 10_000 });

      // Update SQL
      appStore.update(app.id, {
        currentVersion: version,
        hasBackend: targetVersion.hasBackend,
      });

      // Broadcast updated list
      broadcastAppList();

      context.broadcast("app_rollback", {
        appSlug: slug,
        version,
        commitHash: targetVersion.commitHash,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Rolled back ${app.name} to v${version}\n` +
              `Commit: ${targetVersion.commitHash.slice(0, 7)} — ${targetVersion.message ?? "(no message)"}`,
          },
        ],
        details: { app: app.slug, version, commitHash: targetVersion.commitHash },
      };
    },
  });
}
