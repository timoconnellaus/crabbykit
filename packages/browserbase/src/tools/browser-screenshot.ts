import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SessionManager } from "../session-manager.js";

export function createBrowserScreenshotTool(
  sessionManager: SessionManager,
  context: AgentContext,
  onActivity?: () => Promise<void>,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_screenshot",
    description: "Capture a screenshot of the current page.",
    parameters: Type.Object({
      fullPage: Type.Optional(
        Type.Boolean({ description: "Capture the full scrollable page. Default: false" }),
      ),
    }),
    execute: async ({ fullPage }) => {
      const cdp = sessionManager.getCDP(context.sessionId);
      if (!cdp) {
        return {
          content: [{ type: "text" as const, text: "No browser is open. Use browser_open first." }],
          details: null,
        };
      }

      try {
        // Reset idle timer on activity
        if (onActivity) await onActivity();

        const params: Record<string, unknown> = { format: "png" };
        if (fullPage) {
          // Get full page dimensions
          const metrics = await cdp.send<{
            contentSize: { width: number; height: number };
          }>("Page.getLayoutMetrics");

          if (metrics?.contentSize) {
            params.clip = {
              x: 0,
              y: 0,
              width: metrics.contentSize.width,
              height: metrics.contentSize.height,
              scale: 1,
            };
            params.captureBeyondViewport = true;
          }
        }

        const result = await cdp.send<{ data: string }>("Page.captureScreenshot", params);

        return {
          content: [
            {
              type: "image" as const,
              data: result.data,
              mimeType: "image/png",
            },
          ],
          details: { fullPage: fullPage ?? false },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error taking screenshot: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: null,
        };
      }
    },
  });
}
