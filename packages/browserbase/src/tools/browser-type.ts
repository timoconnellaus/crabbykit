import type { AgentContext, AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { SessionManager } from "../session-manager.js";
import { resolveRef } from "../snapshot.js";

export function createBrowserTypeTool(
  sessionManager: SessionManager,
  context: AgentContext,
  onActivity?: () => Promise<void>,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
): AgentTool<any> {
  return defineTool({
    name: "browser_type",
    description:
      "Type text into an element identified by a snapshot ref. " +
      "The element will be clicked first to focus it.",
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref from snapshot (e.g. "e5")' }),
      text: Type.String({ description: "Text to type" }),
      pressEnter: Type.Optional(
        Type.Boolean({ description: "Press Enter after typing. Default: false" }),
      ),
    }),
    execute: async ({ ref, text, pressEnter }) => {
      const cdp = sessionManager.getCDP(context.sessionId);
      if (!cdp) {
        return "No browser is open. Use browser_open first.";
      }

      const refs = sessionManager.getRefs(context.sessionId);
      if (!refs) {
        return "No snapshot available. Use browser_snapshot first.";
      }

      const resolved = resolveRef(refs, ref);
      if (!resolved) {
        return `Unknown ref "${ref}". Available refs: ${Object.keys(refs).join(", ")}.`;
      }

      try {
        // Reset idle timer on activity
        if (onActivity) await onActivity();

        // Focus the element by clicking it
        if (resolved.backendDOMNodeId !== undefined) {
          await cdp.send("DOM.focus", { backendNodeId: resolved.backendDOMNodeId });
        }

        // Type the text
        await cdp.send("Input.insertText", { text });

        // Optional Enter
        if (pressEnter) {
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        }

        const action = pressEnter ? `Typed "${text}" and pressed Enter` : `Typed "${text}"`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${action} into ${resolved.name ? `"${resolved.name}"` : `element ${ref}`}.`,
            },
          ],
          details: { ref, text, pressEnter: pressEnter ?? false },
        };
      } catch (err) {
        return `Error typing into "${ref}": ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
