import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineCommand } from "@claw-for-cloudflare/agent-runtime";
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
        createShowPreviewTool(options.provider, context, options.previewBasePath),
        createHidePreviewTool(options.provider, context),
        createGetConsoleLogsTool(context),
      ];
      return tools;
    },

    commands: (context: AgentContext) => [
      defineCommand({
        name: "close_preview",
        description: "Close the live preview (triggered by the user via the UI close button).",
        execute: async (_args, ctx) => {
          // Clean up server-side state (same as hide_preview tool)
          if (options.provider.clearDevPort) {
            await options.provider.clearDevPort();
          }
          if (context.storage) {
            await context.storage.delete("preview");
          }

          // Broadcast to all clients so any other tabs close the preview
          context.broadcast("preview_close", {});

          // Append a session entry so the agent knows the user closed the preview
          ctx.sessionStore.appendEntry(ctx.sessionId, {
            type: "custom",
            data: {
              customType: "notification",
              role: "user",
              content: "[The user closed the live preview]",
            },
          });

          return { text: "Preview closed." };
        },
      }),
    ],

    promptSections: () => [
      "You have live preview capabilities for web development. " +
        "Workflow: scaffold the project, start a dev server (via exec with background=true), " +
        "then call show_preview with the dev server port. " +
        "The user will see the app in a live iframe. " +
        "Use get_console_logs to check for errors when debugging. " +
        "Call hide_preview when done.",
    ],

    hooks: {
      onConnect: async (ctx) => {
        const preview = await ctx.storage.get<{ port: number; sessionId: string }>("preview");

        if (!preview || preview.sessionId !== ctx.sessionId) {
          // No preview for this session — clean up any orphaned state and close
          if (preview) {
            if (options.provider.clearDevPort) {
              await options.provider.clearDevPort();
            }
            await ctx.storage.delete("preview");
          }
          ctx.broadcast?.("preview_close", {});
          return;
        }

        // This session owns the preview — verify container and re-establish
        try {
          const health = await options.provider.health();
          if (!health.ready) {
            throw new Error("Container not ready");
          }

          if (options.provider.setDevPort) {
            await options.provider.setDevPort(preview.port, options.previewBasePath);
          }

          ctx.broadcast?.("preview_open", { port: preview.port });
        } catch {
          console.warn("[vibe-coder] Stale preview detected on connect — clearing");
          await ctx.storage.delete("preview");
          ctx.broadcast?.("preview_close", {});
        }
      },
    },
  };
}
