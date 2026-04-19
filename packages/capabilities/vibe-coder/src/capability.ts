import type { AgentContext, AnyAgentTool, Capability } from "@crabbykit/agent-runtime";
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
      const tools: AnyAgentTool[] = [
        createShowPreviewTool(options.provider, context, basePath),
        createHidePreviewTool(options.provider, context),
        createGetConsoleLogsTool(context),
      ];
      return tools;
    },

    hooks: {
      afterToolExecution: async (event, ctx) => {
        // When the sandbox elevates, inject CLAW_DB_BACKEND_ID so the
        // container-db client library can include it in requests automatically.
        if (event.toolName === "elevate" && !event.isError && options.backend) {
          const backendId = `${ctx.agentId}:default`;
          try {
            await options.provider.start({
              envVars: { CLAW_DB_BACKEND_ID: backendId },
            });
          } catch (err) {
            console.warn("[vibe-coder] Failed to inject CLAW_DB_BACKEND_ID:", err);
          }
        }

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
