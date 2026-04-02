import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

export function createHidePreviewTool(
  provider: SandboxProvider,
  context: AgentContext,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "hide_preview",
    description: "Close the live preview iframe and stop proxying to the dev server.",
    guidance:
      "Close the live preview iframe and stop proxying traffic to the dev server. " +
      "Use this when the user is done reviewing the app or before switching to a different preview.",
    parameters: Type.Object({}),
    execute: async () => {
      // Verify this session owns the preview
      if (context.storage) {
        const preview = await context.storage.get<{ port: number; sessionId: string }>("preview");
        if (!preview || preview.sessionId !== context.sessionId) {
          return {
            content: [{ type: "text" as const, text: "No active preview for this session." }],
            details: null,
          };
        }
      }

      if (provider.clearDevPort) {
        await provider.clearDevPort();
      }

      // Clear persisted preview state
      if (context.storage) {
        await context.storage.delete("preview");
      }

      // Broadcast preview_close event to connected clients
      context.broadcast("preview_close", {});

      return {
        content: [
          {
            type: "text" as const,
            text: "Preview closed.",
          },
        ],
        details: null,
      };
    },
  });
}
