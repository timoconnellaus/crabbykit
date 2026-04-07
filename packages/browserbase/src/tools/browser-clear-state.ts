import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SessionManager } from "../session-manager.js";

export function createBrowserClearStateTool(
  sessionManager: SessionManager,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_clear_state",
    description:
      "Clear saved browser state (cookies, login sessions). " +
      "Optionally clear only for a specific domain.",
    parameters: Type.Object({
      domain: Type.Optional(
        Type.String({
          description: 'Domain to clear cookies for (e.g. "github.com"). Omit to clear all.',
        }),
      ),
    }),
    execute: async ({ domain }) => {
      try {
        await sessionManager.clearState(domain);

        const scope = domain ? `cookies for ${domain}` : "all browser state";
        return {
          content: [
            {
              type: "text" as const,
              text: `Cleared ${scope}. Next browser_open will start fresh${domain ? ` for ${domain}` : ""}.`,
            },
          ],
          details: { domain: domain ?? null },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error clearing state: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: null,
        };
      }
    },
  });
}
