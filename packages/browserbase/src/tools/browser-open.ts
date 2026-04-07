import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SessionManager } from "../session-manager.js";
import type { BrowserbaseClient } from "../browserbase-client.js";

export function createBrowserOpenTool(
  sessionManager: SessionManager,
  context: AgentContext,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_open",
    description:
      "Open a browser and optionally navigate to a URL. " +
      "The browser appears as a live view in the user's interface. " +
      "Use browser_snapshot after opening to see the page content.",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({ description: "URL to navigate to (e.g. https://example.com)" }),
      ),
    }),
    execute: async ({ url }) => {
      try {
        const result = await sessionManager.open(context.sessionId, url);

        // Broadcast to UI
        const pageUrl = result.debugUrls.pages[0]?.url ?? url ?? "about:blank";
        context.broadcast("browser_open", {
          debuggerFullscreenUrl: result.debugUrls.debuggerFullscreenUrl,
          pageUrl,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Browser opened${url ? ` and navigated to ${url}` : ""}. The user can see the browser in their interface. Use browser_snapshot to see the page content and interact with elements.`,
            },
          ],
          details: { browserbaseId: result.browserbaseId, pageUrl },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error opening browser: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: null,
        };
      }
    },
  });
}
