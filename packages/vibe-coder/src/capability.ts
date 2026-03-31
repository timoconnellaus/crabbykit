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
      const basePath = options.previewBasePath ?? `/preview/${context.agentId}/`;
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createShowPreviewTool(options.provider, context, basePath),
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
          // Verify this session owns the preview
          if (context.storage) {
            const preview = await context.storage.get<{ port: number; sessionId: string }>(
              "preview",
            );
            if (!preview || preview.sessionId !== ctx.sessionId) {
              return { text: "No active preview for this session." };
            }
          }

          // Clean up server-side state (same as hide_preview tool)
          if (options.provider.clearDevPort) {
            await options.provider.clearDevPort();
          }
          if (context.storage) {
            await context.storage.delete("preview");
          }

          // Broadcast to this session's clients
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
      "You have live preview capabilities for web development.\n\n" +
        "Workflow:\n" +
        "1. Scaffold a Vite project: mkdir, npm init -y, npm install vite react react-dom @vitejs/plugin-react /opt/sandbox/claw-vite-plugin\n" +
        "2. IMPORTANT: Always include clawForCloudflare() in vite.config.ts plugins:\n" +
        '   import { clawForCloudflare } from "@claw-for-cloudflare/vite-plugin";\n' +
        "   export default defineConfig({ plugins: [react(), clawForCloudflare()] });\n" +
        "   This configures the preview proxy, HMR, and console capture automatically.\n" +
        '3. Add scripts to package.json: "dev": "vite"\n' +
        "4. Start the dev server (via exec with background=true): npm run dev\n" +
        "5. Call show_preview with port 3000 (the plugin default)\n" +
        "6. The user will see the app in a live iframe\n\n" +
        "Use get_console_logs to check for errors when debugging. " +
        "Call hide_preview when done.",
    ],

    hooks: {
      afterToolExecution: async (event, ctx) => {
        // When the sandbox de-elevates, close the preview if this session owns it
        if (event.toolName === "de_elevate") {
          const preview = await ctx.storage.get<{ port: number; sessionId: string }>("preview");
          if (preview && preview.sessionId === ctx.sessionId) {
            if (options.provider.clearDevPort) {
              await options.provider.clearDevPort();
            }
            await ctx.storage.delete("preview");
            ctx.broadcast?.("preview_close", {});
          }
        }
      },

      onConnect: async (ctx) => {
        const preview = await ctx.storage.get<{ port: number; sessionId: string }>("preview");

        if (!preview || preview.sessionId !== ctx.sessionId) {
          // This session doesn't own the preview — tell this client to close
          // but don't touch storage or provider (another session may own it)
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
            const basePath = options.previewBasePath ?? `/preview/${ctx.agentId}/`;
            await options.provider.setDevPort(preview.port, basePath);
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
