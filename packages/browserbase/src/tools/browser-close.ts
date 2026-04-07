import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SessionManager } from "../session-manager.js";

/** Default per-minute cost in USD ($0.12/hr = $0.002/min). */
const DEFAULT_PER_MINUTE_COST_USD = 0.002;

export function createBrowserCloseTool(
  sessionManager: SessionManager,
  context: AgentContext,
  perMinuteCostUsd?: number,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_close",
    description: "Close the browser. Saves cookies and state for next time.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const { durationMinutes } = await sessionManager.close(context.sessionId);

        // Emit cost
        const rate = perMinuteCostUsd ?? DEFAULT_PER_MINUTE_COST_USD;
        const amount = durationMinutes * rate;
        context.emitCost({
          capabilityId: "browserbase",
          toolName: "browser_close",
          amount,
          currency: "USD",
          detail: `Browser session: ${durationMinutes} min`,
        });

        // Broadcast to UI
        context.broadcast("browser_close", {});

        return {
          content: [
            {
              type: "text" as const,
              text: `Browser closed. Session lasted ${durationMinutes} minute${durationMinutes === 1 ? "" : "s"}. Cookies saved for next time.`,
            },
          ],
          details: { durationMinutes, cost: amount },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error closing browser: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: null,
        };
      }
    },
  });
}
