import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { BrowserbaseClient } from "./browserbase-client.js";
import { CDPClient } from "./cdp-client.js";
import { mergeCookies } from "./cookie-merge.js";
import type {
  ActiveSession,
  BrowserbaseDebugUrls,
  BrowserbaseOptions,
  BrowserState,
  Cookie,
  RefMap,
} from "./types.js";

export const BROWSER_STATE_KEY = "browser:state";
export const ACTIVE_PREFIX = "browser:active:";

/** Result of opening a browser session. */
export interface OpenResult {
  browserbaseId: string;
  connectUrl: string;
  debugUrls: BrowserbaseDebugUrls;
  cdp: CDPClient;
}

/**
 * Manages Browserbase session lifecycle, state persistence, and context arbitration.
 *
 * - Tracks active browser sessions per chat session
 * - Decides whether to use Browserbase Context (single session) or manual cookie injection (parallel)
 * - Saves/restores cookies to/from capability KV storage
 * - Merges cookies on close for parallel session support
 */
/**
 * Holds in-memory CDP connections and ref maps that must survive
 * capability cache clearing (agent_end). These are outbound WebSockets
 * to Browserbase — not DO-scoped I/O — so they're safe to cache at
 * module level across capability recreations.
 */
export interface SessionManagerState {
  cdpClients: Map<string, CDPClient>;
  refMaps: Map<string, RefMap>;
}

export class SessionManager {
  private readonly bbClient: BrowserbaseClient;
  private readonly storage: CapabilityStorage;
  private readonly options: BrowserbaseOptions;

  /** In-memory map of active CDP clients per chat session. */
  private cdpClients: Map<string, CDPClient>;
  /** In-memory ref maps per chat session (from latest snapshot). */
  private refMaps: Map<string, RefMap>;

  constructor(
    bbClient: BrowserbaseClient,
    storage: CapabilityStorage,
    options: BrowserbaseOptions,
    sharedState?: SessionManagerState,
  ) {
    this.bbClient = bbClient;
    this.storage = storage;
    this.options = options;
    this.cdpClients = sharedState?.cdpClients ?? new Map();
    this.refMaps = sharedState?.refMaps ?? new Map();
  }

  /** Open a browser session for the given chat session. */
  async open(sessionId: string, url?: string): Promise<OpenResult> {
    // Check if this chat session already has an active browser
    const existing = await this.storage.get<ActiveSession>(`${ACTIVE_PREFIX}${sessionId}`);
    if (existing) {
      throw new Error("Browser is already open for this session. Close it first.");
    }

    // Count active sessions to decide context usage
    const activeCount = await this.countActiveSessions();
    const useContext = activeCount === 0 && !!this.options.contextId;

    // Create Browserbase session
    const bbSession = await this.bbClient.createSession({
      projectId: this.options.projectId,
      browserSettings: useContext
        ? { context: { id: this.options.contextId!, persist: true } }
        : undefined,
    });

    // Connect via CDP and attach to a page target (Browserbase connects at browser level)
    const cdp = new CDPClient();
    await cdp.connect(bbSession.connectUrl);
    await cdp.attachToPage();
    this.cdpClients.set(sessionId, cdp);

    // Enable required CDP domains (now routed through the page session)
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");

    // Restore cookies if not using BB Context (context auto-restores)
    if (!useContext) {
      const state = await this.storage.get<BrowserState>(BROWSER_STATE_KEY);
      if (state?.cookies.length) {
        await cdp.send("Network.setCookies", { cookies: state.cookies });
      }
    }

    // Navigate if URL provided, otherwise use last known URL
    const targetUrl = url ?? (await this.getLastUrl()) ?? "about:blank";
    if (targetUrl !== "about:blank") {
      await cdp.send("Page.navigate", { url: targetUrl });
      await this.waitForLoad(cdp);
    }

    // Get live view URLs
    const debugUrls = await this.bbClient.getDebugUrls(bbSession.id);

    // Track as active (include connectUrl for reconnection after capability cache clear)
    const active: ActiveSession = {
      browserbaseId: bbSession.id,
      connectUrl: bbSession.connectUrl,
      usedContext: useContext,
      startedAt: new Date().toISOString(),
    };
    await this.storage.put(`${ACTIVE_PREFIX}${sessionId}`, active);

    return {
      browserbaseId: bbSession.id,
      connectUrl: bbSession.connectUrl,
      debugUrls,
      cdp,
    };
  }

  /** Close the browser session for the given chat session. */
  async close(sessionId: string): Promise<{ durationMinutes: number }> {
    const active = await this.storage.get<ActiveSession>(`${ACTIVE_PREFIX}${sessionId}`);
    if (!active) {
      throw new Error("No active browser session for this chat session.");
    }

    const cdp = this.cdpClients.get(sessionId);

    // Extract and save cookies
    if (cdp?.isConnected) {
      try {
        const cookieResult = await cdp.send<{ cookies: Cookie[] }>("Network.getCookies");
        const currentUrl = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: "window.location.href",
        });

        const stored = (await this.storage.get<BrowserState>(BROWSER_STATE_KEY)) ?? {
          cookies: [],
          savedAt: "",
        };
        const merged = mergeCookies(stored.cookies, cookieResult.cookies);

        await this.storage.put(BROWSER_STATE_KEY, {
          cookies: merged,
          lastUrl: currentUrl?.result?.value ?? stored.lastUrl,
          savedAt: new Date().toISOString(),
        } satisfies BrowserState);
      } catch {
        // Best-effort — CDP might already be disconnected
      }

      cdp.close();
    }

    this.cdpClients.delete(sessionId);
    this.refMaps.delete(sessionId);

    // Release Browserbase session
    try {
      await this.bbClient.releaseSession(active.browserbaseId);
    } catch {
      // Best-effort — session might have already expired
    }

    // Clean up tracking
    await this.storage.delete(`${ACTIVE_PREFIX}${sessionId}`);

    // Calculate duration
    const startMs = new Date(active.startedAt).getTime();
    const durationMinutes = Math.ceil((Date.now() - startMs) / 60_000);

    return { durationMinutes };
  }

  /** Get the CDP client for a chat session (if active). */
  getCDP(sessionId: string): CDPClient | undefined {
    return this.cdpClients.get(sessionId);
  }

  /**
   * Get the CDP client, reconnecting if needed.
   *
   * The capability cache is cleared between turns (on agent_end), which
   * destroys the in-memory CDP client. But the Browserbase session is still
   * running. This method checks KV for an active session and reconnects.
   */
  async ensureCDP(sessionId: string): Promise<CDPClient | undefined> {
    const existing = this.cdpClients.get(sessionId);
    if (existing?.isConnected) return existing;

    // Check KV for an active session we can reconnect to
    const active = await this.storage.get<ActiveSession>(`${ACTIVE_PREFIX}${sessionId}`);
    if (!active?.connectUrl) return undefined;

    try {
      const cdp = new CDPClient();
      await cdp.connect(active.connectUrl);
      await cdp.attachToPage();
      await cdp.send("Page.enable");
      await cdp.send("Network.enable");
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      this.cdpClients.set(sessionId, cdp);
      return cdp;
    } catch {
      // Connection failed — session may have expired
      return undefined;
    }
  }

  /** Store the latest snapshot ref map for a chat session. */
  setRefs(sessionId: string, refs: RefMap): void {
    this.refMaps.set(sessionId, refs);
  }

  /** Get the latest snapshot ref map for a chat session. */
  getRefs(sessionId: string): RefMap | undefined {
    return this.refMaps.get(sessionId);
  }

  /** Check if a chat session has an active browser. */
  async isActive(sessionId: string): Promise<boolean> {
    const active = await this.storage.get<ActiveSession>(`${ACTIVE_PREFIX}${sessionId}`);
    return active !== null && active !== undefined;
  }

  /** Get the active session info for a chat session. */
  async getActive(sessionId: string): Promise<ActiveSession | null> {
    return (await this.storage.get<ActiveSession>(`${ACTIVE_PREFIX}${sessionId}`)) ?? null;
  }

  /** Clear all stored browser state (cookies). */
  async clearState(domain?: string): Promise<void> {
    if (!domain) {
      await this.storage.delete(BROWSER_STATE_KEY);
      return;
    }

    const state = await this.storage.get<BrowserState>(BROWSER_STATE_KEY);
    if (!state) return;

    const filtered = state.cookies.filter((c) => !c.domain.endsWith(domain));
    await this.storage.put(BROWSER_STATE_KEY, {
      ...state,
      cookies: filtered,
      savedAt: new Date().toISOString(),
    });
  }

  /**
   * List all active browser sessions from KV storage.
   * Returns entries as [chatSessionId, ActiveSession] pairs.
   */
  async listActiveSessions(): Promise<[string, ActiveSession][]> {
    const entries = await this.storage.list(ACTIVE_PREFIX);
    const result: [string, ActiveSession][] = [];
    for (const [key, value] of entries) {
      const chatSessionId = key.slice(ACTIVE_PREFIX.length);
      result.push([chatSessionId, value as ActiveSession]);
    }
    return result;
  }

  /**
   * Recover orphaned browser sessions — sessions tracked in KV but with no
   * in-memory CDP client. This happens after DO hibernation or crash.
   *
   * Returns the list of recovered (closed) session IDs with their durations.
   */
  async recoverOrphans(): Promise<{ sessionId: string; durationMinutes: number }[]> {
    const actives = await this.listActiveSessions();
    const recovered: { sessionId: string; durationMinutes: number }[] = [];

    for (const [chatSessionId, active] of actives) {
      // If we have a live CDP client, this session is fine
      if (this.cdpClients.has(chatSessionId)) continue;

      // Orphaned — release the Browserbase session and clean up
      try {
        await this.bbClient.releaseSession(active.browserbaseId);
      } catch {
        // Best-effort — session might have already expired on Browserbase's side
      }

      await this.storage.delete(`${ACTIVE_PREFIX}${chatSessionId}`);
      this.refMaps.delete(chatSessionId);

      const startMs = new Date(active.startedAt).getTime();
      const durationMinutes = Math.ceil((Date.now() - startMs) / 60_000);
      recovered.push({ sessionId: chatSessionId, durationMinutes });
    }

    return recovered;
  }

  private async getLastUrl(): Promise<string | undefined> {
    const state = await this.storage.get<BrowserState>(BROWSER_STATE_KEY);
    return state?.lastUrl;
  }

  private async countActiveSessions(): Promise<number> {
    const entries = await this.storage.list(ACTIVE_PREFIX);
    return entries.size;
  }

  private async waitForLoad(cdp: CDPClient, timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cdp.off("Page.loadEventFired", handler);
        resolve(); // Resolve even on timeout — page may have loaded enough
      }, timeoutMs);

      const handler = () => {
        clearTimeout(timer);
        cdp.off("Page.loadEventFired", handler);
        resolve();
      };

      cdp.on("Page.loadEventFired", handler);
    });
  }
}
