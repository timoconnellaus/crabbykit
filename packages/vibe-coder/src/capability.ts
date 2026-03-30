import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { createGetConsoleLogsTool } from "./tools/get-console-logs.js";
import { createHidePreviewTool } from "./tools/hide-preview.js";
import { createShowPreviewTool } from "./tools/show-preview.js";
import type { VibeCoderOptions } from "./types.js";

/**
 * Create a vibe-coder capability that provides live app preview and console log tools.
 *
 * Tools provided:
 * - `show_preview` — Open a live preview iframe for a dev server port
 * - `hide_preview` — Close the preview iframe
 * - `get_console_logs` — Retrieve console logs from the preview iframe
 */
export function vibeCoder(options: VibeCoderOptions): Capability {
  return {
    id: "vibe-coder",
    name: "Vibe Coder",
    description: "Live app preview with console log capture for iterative web development.",

    tools: (context: AgentContext) => {
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createShowPreviewTool(options.provider, context),
        createHidePreviewTool(options.provider, context),
        createGetConsoleLogsTool(context),
      ];
      return tools;
    },

    promptSections: () => [
      "You have live preview capabilities for web development. " +
        "Workflow: scaffold the project, start a dev server (via start_process), " +
        "then call show_preview with the dev server port. " +
        "The user will see the app in a live iframe. " +
        "Use get_console_logs to check for errors when debugging. " +
        "Call hide_preview when done.",
    ],

    hooks: {
      onConnect: async (ctx) => {
        const port = await ctx.storage.get<number>("previewPort");

        if (!port) {
          // No active preview — broadcast closed state for reconnecting clients
          ctx.broadcast?.("preview_close", {});
          return;
        }

        // Verify the container is still running
        try {
          const health = await options.provider.health();
          if (!health.ready) {
            throw new Error("Container not ready");
          }

          // Re-establish the dev port proxy
          if (options.provider.setDevPort) {
            await options.provider.setDevPort(port);
          }

          // Notify reconnecting client to open the preview
          ctx.broadcast?.("preview_open", { port });
        } catch {
          // Container is dead — clear stale preview state
          console.warn("[vibe-coder] Stale preview detected on connect — clearing");
          await ctx.storage.delete("previewPort");
          ctx.broadcast?.("preview_close", {});
        }
      },
    },
  };
}
