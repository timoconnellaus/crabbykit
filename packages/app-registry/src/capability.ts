import type { Capability, CapabilityHookContext } from "@claw-for-cloudflare/agent-runtime";
import { AppStore } from "./app-store.js";
import { createDeleteAppTool } from "./tools/delete-app.js";
import { createDeployAppTool } from "./tools/deploy-app.js";
import { createGetAppHistoryTool } from "./tools/get-app-history.js";
import { createListAppsTool } from "./tools/list-apps.js";
import { createRollbackAppTool } from "./tools/rollback-app.js";
import type { AppRegistryOptions } from "./types.js";

/**
 * Build the app list payload for broadcasting to clients.
 */
function buildAppListPayload(appStore: AppStore): Record<string, unknown> {
  const apps = appStore.list();
  return {
    apps: apps.map((app) => {
      const latest = appStore.getLatestVersion(app.id);
      return {
        id: app.id,
        name: app.name,
        slug: app.slug,
        currentVersion: app.currentVersion,
        hasBackend: app.hasBackend,
        lastDeployedAt: latest?.deployedAt ?? app.createdAt,
        commitHash: latest?.commitHash ?? "",
        commitMessage: latest?.message ?? null,
      };
    }),
  };
}

/**
 * Create an app-registry capability that manages named app lifecycle.
 *
 * Tools provided:
 * - `deploy_app` — Deploy a built app with git-based versioning
 * - `list_apps` — List all registered apps
 * - `get_app_history` — Get version history for an app
 * - `rollback_app` — Rollback to a previous version
 * - `delete_app` — Remove an app and all versions
 *
 * Broadcasts app list as a `"app_list"` custom event on connect and after mutations.
 */
export function appRegistry(options: AppRegistryOptions): Capability {
  const appStore = new AppStore(options.sql);

  return {
    id: "app-registry",
    name: "App Registry",
    description: "Named app lifecycle management with versioned deployments.",

    tools: (context) => {
      const broadcastList = () => {
        context.broadcastToAll("app_list", buildAppListPayload(appStore));
      };

      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createDeployAppTool(options.provider, context, appStore, broadcastList, options.backend),
        createListAppsTool(appStore),
        createGetAppHistoryTool(appStore),
        createRollbackAppTool(options.provider, context, appStore, broadcastList),
        createDeleteAppTool(options.provider, context, appStore, broadcastList),
      ];

      return tools;
    },

    promptSections: (_context) => [
      "You can deploy web apps with versioning. Use deploy_app to deploy a built app " +
        "(requires a clean git working tree — commit your changes first). " +
        "Use list_apps to see all deployed apps, get_app_history for version history, " +
        "rollback_app to revert to a previous version, and delete_app to remove an app.\n\n" +
        "Deployed apps are accessible at /apps/{slug}/ with automatic SPA routing.",
    ],

    hooks: {
      onConnect: async (ctx: CapabilityHookContext) => {
        ctx.broadcast?.("app_list", buildAppListPayload(appStore));
      },
    },
  };
}
