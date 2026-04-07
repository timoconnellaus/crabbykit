import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SessionManager } from "../session-manager.js";
import { resolveRef } from "../snapshot.js";

export function createBrowserClickTool(
  sessionManager: SessionManager,
  context: AgentContext,
  onActivity?: () => Promise<void>,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_click",
    description:
      "Click an element identified by a snapshot ref (e.g. e3). " +
      "Use browser_snapshot first to get available refs.",
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref from snapshot (e.g. "e3")' }),
    }),
    execute: async ({ ref }) => {
      const cdp = sessionManager.getCDP(context.sessionId);
      if (!cdp) {
        return {
          content: [{ type: "text" as const, text: "No browser is open. Use browser_open first." }],
          details: null,
        };
      }

      const refs = sessionManager.getRefs(context.sessionId);
      if (!refs) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No snapshot available. Use browser_snapshot first to get element refs.",
            },
          ],
          details: null,
        };
      }

      const resolved = resolveRef(refs, ref);
      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown ref "${ref}". Available refs: ${Object.keys(refs).join(", ")}. Take a new snapshot if the page has changed.`,
            },
          ],
          details: null,
        };
      }

      try {
        // Reset idle timer on activity
        if (onActivity) await onActivity();

        // Resolve the backend DOM node to get coordinates
        if (resolved.backendDOMNodeId === undefined) {
          return {
            content: [
              { type: "text" as const, text: `Element "${ref}" has no DOM backing. Cannot click.` },
            ],
            details: null,
          };
        }

        // Resolve node to get the remote object
        const nodeResult = await cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", {
          backendNodeId: resolved.backendDOMNodeId,
        });

        // Get the content quads (bounding rectangles)
        const quadsResult = await cdp.send<{ quads: number[][] }>("DOM.getContentQuads", {
          backendNodeId: resolved.backendDOMNodeId,
        });

        if (!quadsResult.quads?.length) {
          // Fallback: scroll into view and retry
          if (nodeResult?.object?.objectId) {
            await cdp.send("DOM.scrollIntoViewIfNeeded", {
              backendNodeId: resolved.backendDOMNodeId,
            });
            const retryQuads = await cdp.send<{ quads: number[][] }>("DOM.getContentQuads", {
              backendNodeId: resolved.backendDOMNodeId,
            });
            if (!retryQuads.quads?.length) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Element "${ref}" has no visible bounds. It may be hidden.`,
                  },
                ],
                details: null,
              };
            }
            return await clickAtQuad(cdp, retryQuads.quads[0], ref, resolved.name);
          }
          return {
            content: [{ type: "text" as const, text: `Element "${ref}" has no visible bounds.` }],
            details: null,
          };
        }

        return await clickAtQuad(cdp, quadsResult.quads[0], ref, resolved.name);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error clicking "${ref}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: null,
        };
      }
    },
  });
}

async function clickAtQuad(
  cdp: { send: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  quad: number[],
  ref: string,
  name: string,
) {
  // Quad is [x1,y1, x2,y2, x3,y3, x4,y4] — compute center
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Clicked ${name ? `"${name}"` : `element ${ref}`} at (${Math.round(x)}, ${Math.round(y)}).`,
      },
    ],
    details: { ref, x: Math.round(x), y: Math.round(y) },
  };
}
