import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineCommand } from "@claw-for-cloudflare/agent-runtime";
import { BrowserbaseClient } from "./browserbase-client.js";
import { SessionManager } from "./session-manager.js";
import { createBrowserOpenTool } from "./tools/browser-open.js";
import { createBrowserNavigateTool } from "./tools/browser-navigate.js";
import { createBrowserSnapshotTool } from "./tools/browser-snapshot.js";
import { createBrowserScreenshotTool } from "./tools/browser-screenshot.js";
import { createBrowserClickTool } from "./tools/browser-click.js";
import { createBrowserTypeTool } from "./tools/browser-type.js";
import { createBrowserCloseTool } from "./tools/browser-close.js";
import { createBrowserClearStateTool } from "./tools/browser-clear-state.js";
import type { BrowserbaseOptions } from "./types.js";

/**
 * Create a browserbase capability that provides browser automation tools.
 *
 * Tools provided:
 * - `browser_open` — Open a browser and optionally navigate to a URL
 * - `browser_navigate` — Navigate to a URL
 * - `browser_snapshot` — Get accessibility tree with element refs
 * - `browser_screenshot` — Capture a screenshot
 * - `browser_click` — Click an element by ref
 * - `browser_type` — Type text into an element by ref
 * - `browser_close` — Close the browser, save state
 * - `browser_clear_state` — Clear saved cookies/state
 */
export function browserbase(options: BrowserbaseOptions): Capability {
  const bbClient = new BrowserbaseClient(options.apiKey);

  // SessionManager is shared across all sessions within this agent's DO.
  // It's created lazily per capability instance (one per agent DO).
  let sessionManager: SessionManager | null = null;

  function getSessionManager(context: AgentContext): SessionManager {
    if (!sessionManager && context.storage) {
      sessionManager = new SessionManager(bbClient, context.storage, options);
    }
    if (!sessionManager) {
      throw new Error("Browserbase capability requires capability storage.");
    }
    return sessionManager;
  }

  return {
    id: "browserbase",
    name: "Browserbase",
    description: "Browser automation via Browserbase. Browse the web, fill forms, extract data.",

    tools: (context: AgentContext) => {
      const sm = getSessionManager(context);
      // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires cast when building heterogeneous arrays
      const tools: any[] = [
        createBrowserOpenTool(sm, context),
        createBrowserNavigateTool(sm, context),
        createBrowserSnapshotTool(sm, context),
        createBrowserScreenshotTool(sm, context),
        createBrowserClickTool(sm, context),
        createBrowserTypeTool(sm, context),
        createBrowserCloseTool(sm, context, options.perMinuteCostUsd),
        createBrowserClearStateTool(sm),
      ];
      return tools;
    },

    commands: (context: AgentContext) => {
      const sm = getSessionManager(context);
      return [
        defineCommand({
          name: "close_browser",
          description: "Close the browser (triggered by the user via the UI close button).",
          execute: async (_args, ctx) => {
            try {
              const { durationMinutes } = await sm.close(ctx.sessionId);

              // Emit cost
              const rate = options.perMinuteCostUsd ?? 0.002;
              context.emitCost({
                capabilityId: "browserbase",
                toolName: "close_browser",
                amount: durationMinutes * rate,
                currency: "USD",
                detail: `Browser session: ${durationMinutes} min`,
              });

              context.broadcast("browser_close", {});

              // Append entry so agent knows user closed browser
              ctx.sessionStore.appendEntry(ctx.sessionId, {
                type: "custom",
                data: {
                  customType: "notification",
                  role: "user",
                  content: "[The user closed the browser panel]",
                },
              });

              return { text: "Browser closed." };
            } catch {
              return { text: "No active browser to close." };
            }
          },
        }),
      ];
    },

    hooks: {
      onConnect: async (ctx) => {
        if (!ctx.broadcast) return;
        const sm = getSessionManager(ctx as unknown as AgentContext);
        const active = await sm.getActive(ctx.sessionId);

        if (active) {
          // Session has an active browser — try to get fresh debug URLs and re-broadcast
          try {
            const debugUrls = await bbClient.getDebugUrls(active.browserbaseId);
            const pageUrl = debugUrls.pages[0]?.url ?? "";
            ctx.broadcast("browser_open", {
              debuggerFullscreenUrl: debugUrls.debuggerFullscreenUrl,
              pageUrl,
            });
          } catch {
            // Browser session may have expired — clean up
            await sm.close(ctx.sessionId).catch(() => {});
            ctx.broadcast("browser_close", {});
          }
        }
      },
    },

    dispose: async () => {
      // Nothing to dispose — CDP connections are cleaned up per-session
      sessionManager = null;
    },
  };
}
