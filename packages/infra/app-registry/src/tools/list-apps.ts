import type { AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { AppStore } from "../app-store.js";

export function createListAppsTool(
  appStore: AppStore,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast
): AgentTool<any> {
  return defineTool({
    name: "list_apps",
    description: "List all deployed apps with their current version and status.",
    guidance:
      "Show all deployed apps with their current version, status, and commit metadata. Use this to check what's deployed before making changes.",
    parameters: Type.Object({}),
    execute: async () => {
      const apps = appStore.list();

      if (apps.length === 0) {
        return "No apps deployed yet.";
      }

      const lines = apps.map((app) => {
        const latest = appStore.getLatestVersion(app.id);
        const commitInfo = latest
          ? ` (${latest.commitHash.slice(0, 7)} — ${latest.message ?? "no message"})`
          : "";
        return (
          `- ${app.name} [${app.slug}] v${app.currentVersion}${commitInfo}\n` +
          `  URL: /apps/${app.slug}/` +
          (app.hasBackend ? " (full-stack)" : "")
        );
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Deployed apps (${apps.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
        details: { apps },
      };
    },
  });
}
