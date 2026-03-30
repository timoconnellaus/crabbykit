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
    parameters: Type.Object({}),
    execute: async () => {
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
