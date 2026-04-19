import type { AgentContext, AgentTool } from "@crabbykit/agent-runtime";
import { defineTool, Type } from "@crabbykit/agent-runtime";
import type { SandboxProvider } from "@crabbykit/sandbox";
import type { AppStore } from "../app-store.js";

export function createDeleteAppTool(
  provider: SandboxProvider,
  context: AgentContext,
  appStore: AppStore,
  broadcastAppList: () => void,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast
): AgentTool<any> {
  return defineTool({
    name: "delete_app",
    description: "Delete a deployed app and all its versions.",
    guidance:
      "Permanently delete a deployed app and all its versions from storage. This cannot be undone.",
    parameters: Type.Object({
      slug: Type.String({ description: "The app slug to delete (e.g. 'todo-app')" }),
    }),
    execute: async ({ slug }) => {
      const app = appStore.getBySlug(slug);
      if (!app) {
        return `Error: App "${slug}" not found.`;
      }

      // Clean up R2 artifacts
      await provider.exec(`rm -rf "/workspace/apps/${slug}"`, { timeout: 30_000 });

      // Remove from SQL
      appStore.delete(app.id);

      // Broadcast updated list
      broadcastAppList();

      context.broadcast("app_deleted", { appSlug: slug });

      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted app "${app.name}" (${slug}) and all ${app.currentVersion} versions.`,
          },
        ],
        details: { slug, name: app.name },
      };
    },
  });
}
