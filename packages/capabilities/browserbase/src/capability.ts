import type { AgentContext, AnyAgentTool, Capability } from "@claw-for-cloudflare/agent-runtime";
import { BrowserbaseClient } from "./browserbase-client.js";
import type { SessionManagerState } from "./session-manager.js";
import { SessionManager } from "./session-manager.js";
import { cancelTimers, resetIdleTimer, setMaxTimer } from "./timer.js";
import { createBrowserClearStateTool } from "./tools/browser-clear-state.js";
import { createBrowserClickTool } from "./tools/browser-click.js";
import { createBrowserCloseTool } from "./tools/browser-close.js";
import { createBrowserNavigateTool } from "./tools/browser-navigate.js";
import { createBrowserOpenTool } from "./tools/browser-open.js";
import { createBrowserScreenshotTool } from "./tools/browser-screenshot.js";
import { createBrowserSnapshotTool } from "./tools/browser-snapshot.js";
import { createBrowserTypeTool } from "./tools/browser-type.js";
import type { BrowserbaseOptions } from "./types.js";

/** Seconds of inactivity before auto-closing the browser session. */
export const DEFAULT_IDLE_TIMEOUT = 300;

/** Maximum session duration in seconds. */
export const DEFAULT_MAX_DURATION = 1800;

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

/**
 * Module-level cache for CDP connections and ref maps. These are outbound
 * WebSockets to Browserbase — not DO-scoped I/O — so they're safe to share
 * across capability recreations within the same isolate.
 *
 * We cache the Maps, not the SessionManager itself, because SessionManager
 * holds CapabilityStorage (DO-scoped ActorCacheInterface) which can't be
 * accessed from a different DO in the same isolate.
 */
const sharedStateCache = new Map<string, SessionManagerState>();

export function browserbase(options: BrowserbaseOptions): Capability {
  const bbClient = new BrowserbaseClient(options.apiKey);
  const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
  const maxDuration = options.maxDuration ?? DEFAULT_MAX_DURATION;

  // SessionManager is recreated each turn (capability cache clear), but
  // its CDP connections are preserved via the shared state cache.
  let sessionManager: SessionManager | null = null;

  function getSessionManager(context: AgentContext): SessionManager {
    if (!sessionManager && context.storage) {
      // Get or create shared state (CDP connections + ref maps)
      const cacheKey = `${options.apiKey}:${options.projectId}:${context.agentId}`;
      let sharedState = sharedStateCache.get(cacheKey);
      if (!sharedState) {
        sharedState = { cdpClients: new Map(), refMaps: new Map() };
        sharedStateCache.set(cacheKey, sharedState);
      }
      sessionManager = new SessionManager(bbClient, context.storage, options, sharedState);
    }
    if (!sessionManager) {
      throw new Error("Browserbase capability requires capability storage.");
    }
    return sessionManager;
  }

  /**
   * Build the timer callback that auto-closes a browser session.
   * Captures the AgentContext for broadcasting (ScheduleCallbackContext lacks broadcast).
   */
  function buildTimeoutCallback(context: AgentContext, reason: "idle" | "max_duration") {
    return async () => {
      const sm = getSessionManager(context);
      try {
        const { durationMinutes } = await sm.close(context.sessionId);

        // Cancel the other timer (if idle fired, cancel max; if max fired, cancel idle)
        await cancelTimers(context.sessionId, context);

        // Emit cost
        const rate = options.perMinuteCostUsd ?? 0.002;
        context.emitCost({
          capabilityId: "browserbase",
          toolName: `browser_timeout_${reason}`,
          amount: durationMinutes * rate,
          currency: "USD",
          detail: `Browser auto-closed (${reason}): ${durationMinutes} min`,
        });

        // Broadcast timeout to UI so it can close the panel and show a message
        context.broadcast("browser_timeout", { reason });
        context.broadcast("browser_close", {});
      } catch {
        // Session may already be closed — ignore
      }
    };
  }

  return {
    id: "browserbase",
    name: "Browserbase",
    description: "Browser automation via Browserbase. Browse the web, fill forms, extract data.",

    tools: (context: AgentContext) => {
      const sm = getSessionManager(context);

      // Recover orphaned sessions (from DO hibernation/restart)
      // Fire-and-forget — don't block tool resolution
      sm.recoverOrphans()
        .then((recovered) => {
          for (const { sessionId, durationMinutes } of recovered) {
            const rate = options.perMinuteCostUsd ?? 0.002;
            context.emitCost({
              capabilityId: "browserbase",
              toolName: "browser_orphan_recovery",
              amount: durationMinutes * rate,
              currency: "USD",
              detail: `Orphaned browser session recovered: ${durationMinutes} min`,
            });
            context.broadcast("browser_close", {});
          }
        })
        .catch(() => {
          // Best-effort orphan recovery
        });

      // Timer integration callbacks
      const broadcastTimeout = () => {
        context.broadcast("browser_timeout", {
          expiresAt: Date.now() + idleTimeout * 1000,
          timeoutSeconds: idleTimeout,
        });
      };

      const onOpen = async () => {
        const idleCallback = buildTimeoutCallback(context, "idle");
        const maxCallback = buildTimeoutCallback(context, "max_duration");
        await resetIdleTimer(context.sessionId, context, idleTimeout, idleCallback);
        await setMaxTimer(context.sessionId, context, maxDuration, maxCallback);
        broadcastTimeout();
      };

      const onClose = async () => {
        await cancelTimers(context.sessionId, context);
      };

      const onActivity = async () => {
        // Reset idle timer on any browser tool use (callback preserved from initial set)
        try {
          await resetIdleTimer(context.sessionId, context, idleTimeout);
          broadcastTimeout();
        } catch {
          // Timer may not exist if browser isn't open — ignore
        }
      };

      const tools: AnyAgentTool[] = [
        createBrowserOpenTool(sm, context, onOpen),
        createBrowserNavigateTool(sm, context, onActivity),
        createBrowserSnapshotTool(sm, context, onActivity),
        createBrowserScreenshotTool(sm, context, onActivity),
        createBrowserClickTool(sm, context, onActivity),
        createBrowserTypeTool(sm, context, onActivity),
        createBrowserCloseTool(sm, context, options.perMinuteCostUsd, onClose),
        createBrowserClearStateTool(sm),
      ];
      return tools;
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
            // Broadcast timeout so UI shows the countdown
            // Use full idleTimeout since we can't query the scheduler's remaining time
            ctx.broadcast("browser_timeout", {
              expiresAt: Date.now() + idleTimeout * 1000,
              timeoutSeconds: idleTimeout,
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
      // Don't null sessionManager — it's cached at module level
      // to preserve CDP connections across capability cache clears.
      // It will be GC'd when the DO isolate is destroyed.
    },
  };
}
