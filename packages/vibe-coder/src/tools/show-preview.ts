import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

export function createShowPreviewTool(
  provider: SandboxProvider,
  context: AgentContext,
  previewBasePath?: string,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "show_preview",
    description:
      "Open a live preview of the app running on the given port in the sandbox container. " +
      "The preview will appear as an iframe in the user's browser.",
    parameters: Type.Object({
      port: Type.Number({ description: "The port the dev server is running on (e.g. 5173)" }),
    }),
    execute: async ({ port }) => {
      if (!provider.setDevPort) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Sandbox provider does not support dev server proxying.",
            },
          ],
          details: null,
        };
      }

      await provider.setDevPort(port, previewBasePath);

      // Persist the preview with session ownership
      if (context.storage) {
        await context.storage.put("preview", { port, sessionId: context.sessionId });
      }

      // Broadcast preview_open event to connected clients
      context.broadcast("preview_open", { port, previewBasePath });

      return {
        content: [
          {
            type: "text" as const,
            text: `Preview opened for port ${port}. The user can now see the app in their browser.`,
          },
        ],
        details: { port },
      };
    },
  });
}
