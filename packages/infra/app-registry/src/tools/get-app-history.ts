import type { AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { AppStore } from "../app-store.js";

export function createGetAppHistoryTool(
  appStore: AppStore,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast
): AgentTool<any> {
  return defineTool({
    name: "get_app_history",
    description: "Get the version history for a deployed app.",
    guidance:
      "View the full version history for a deployed app including commit info, file counts, and deployment timestamps. Use this before rollback to identify the target version.",
    parameters: Type.Object({
      slug: Type.String({ description: "The app slug (e.g. 'todo-app')" }),
    }),
    execute: async ({ slug }) => {
      const app = appStore.getBySlug(slug);
      if (!app) {
        return `Error: App "${slug}" not found.`;
      }

      const versions = appStore.getVersions(app.id);

      if (versions.length === 0) {
        return `${app.name} (${app.slug}) — no versions deployed yet.`;
      }

      const lines = versions.map((v) => {
        const current = v.version === app.currentVersion ? " ← LIVE" : "";
        return (
          `v${v.version}  ${v.commitHash.slice(0, 7)}  ${v.message ?? "(no message)"}  ` +
          `${v.files.length} files  ${v.deployedAt}${current}`
        );
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${app.name} (${app.slug}) — ${versions.length} versions:\n\n` + lines.join("\n"),
          },
        ],
        details: { app, versions },
      };
    },
  });
}
