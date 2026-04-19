import type { AgentContext, AgentTool } from "@crabbykit/agent-runtime";
import { defineTool, Type } from "@crabbykit/agent-runtime";
import type { SessionManager } from "../session-manager.js";

export function createBrowserNavigateTool(
  sessionManager: SessionManager,
  context: AgentContext,
  onActivity?: () => Promise<void>,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_navigate",
    description: "Navigate the browser to a URL.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
    }),
    execute: async ({ url }) => {
      const cdp = sessionManager.getCDP(context.sessionId);
      if (!cdp) {
        return "No browser is open. Use browser_open first.";
      }

      try {
        // Reset idle timer on activity
        if (onActivity) await onActivity();

        await cdp.send("Page.navigate", { url });
        // Wait for page load
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            cdp.off("Page.loadEventFired", handler);
            resolve();
          }, 10_000);
          const handler = () => {
            clearTimeout(timer);
            cdp.off("Page.loadEventFired", handler);
            resolve();
          };
          cdp.on("Page.loadEventFired", handler);
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Navigated to ${url}. Use browser_snapshot to see the page content.`,
            },
          ],
          details: { url },
        };
      } catch (err) {
        return `Error navigating: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
