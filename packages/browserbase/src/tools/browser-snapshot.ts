import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SessionManager } from "../session-manager.js";
import { formatAXTree } from "../snapshot.js";
import type { AXNode } from "../types.js";

export function createBrowserSnapshotTool(
  sessionManager: SessionManager,
  context: AgentContext,
  onActivity?: () => Promise<void>,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_snapshot",
    description:
      "Get an accessibility tree snapshot of the current page. " +
      "Interactive elements are labeled with refs (e.g. [ref=e1]) " +
      "that you can use with browser_click and browser_type.",
    parameters: Type.Object({
      interactive: Type.Optional(
        Type.Boolean({
          description: "Only show interactive elements (buttons, links, inputs). Default: false",
        }),
      ),
    }),
    execute: async ({ interactive }) => {
      const cdp = sessionManager.getCDP(context.sessionId);
      if (!cdp) {
        return "No browser is open. Use browser_open first.";
      }

      try {
        // Reset idle timer on activity
        if (onActivity) await onActivity();

        // Get accessibility tree
        const result = await cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");

        // Get current URL and title
        const urlResult = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: "window.location.href",
        });
        const titleResult = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: "document.title",
        });

        const url = urlResult?.result?.value ?? "unknown";
        const title = titleResult?.result?.value ?? "unknown";

        // Format the tree
        const { tree, refs } = formatAXTree(result.nodes, { interactive: interactive ?? false });

        // Store refs for click/type operations
        sessionManager.setRefs(context.sessionId, refs);

        const header = `URL: ${url}\nTitle: ${title}\n\n`;

        return {
          content: [{ type: "text" as const, text: header + tree }],
          details: { url, title, refCount: Object.keys(refs).length },
        };
      } catch (err) {
        return `Error taking snapshot: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
