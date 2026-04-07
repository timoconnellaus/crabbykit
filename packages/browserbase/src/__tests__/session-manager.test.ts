import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../session-manager.js";
import type { BrowserbaseClient } from "../browserbase-client.js";
import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { BrowserbaseOptions, ActiveSession, BrowserState } from "../types.js";

/** In-memory capability storage mock. */
function createMockStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
    async list<T>(prefix?: string): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}

/** Mock CDP client that records sent commands. */
class MockCDPClient {
  connected = true;
  sentCommands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  responses = new Map<string, unknown>();
  eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  get isConnected() {
    return this.connected;
  }

  async connect(_url: string) {
    this.connected = true;
  }

  async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sentCommands.push({ method, params });
    return (this.responses.get(method) ?? {}) as T;
  }

  on(method: string, handler: (params: Record<string, unknown>) => void) {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
    // Auto-fire load event for tests
    if (method === "Page.loadEventFired") {
      setTimeout(() => handler({}), 5);
    }
  }

  off(method: string, handler: (params: Record<string, unknown>) => void) {
    this.eventHandlers.get(method)?.delete(handler);
  }

  close() {
    this.connected = false;
  }
}

function createMockBBClient(): BrowserbaseClient {
  return {
    createSession: vi.fn().mockResolvedValue({
      id: "bb-sess-1",
      connectUrl: "wss://connect.browserbase.com/bb-sess-1",
      status: "RUNNING",
      projectId: "proj-1",
      expiresAt: "2026-04-02T13:00:00Z",
      createdAt: "2026-04-02T12:00:00Z",
    }),
    getDebugUrls: vi.fn().mockResolvedValue({
      debuggerUrl: "https://debug.bb.com/bb-sess-1",
      debuggerFullscreenUrl: "https://debug.bb.com/bb-sess-1/fullscreen",
      wsUrl: "wss://debug.bb.com/bb-sess-1",
      pages: [
        {
          id: "page-1",
          debuggerUrl: "",
          debuggerFullscreenUrl: "",
          faviconUrl: "",
          title: "Example",
          url: "https://example.com",
        },
      ],
    }),
    releaseSession: vi.fn().mockResolvedValue(undefined),
    createContext: vi.fn().mockResolvedValue("ctx-1"),
  } as unknown as BrowserbaseClient;
}

const TEST_OPTIONS: BrowserbaseOptions = {
  apiKey: "test-key",
  projectId: "test-proj",
  contextId: "test-ctx",
};

describe("SessionManager", () => {
  let storage: CapabilityStorage;
  let bbClient: ReturnType<typeof createMockBBClient>;
  let sm: SessionManager;

  // Patch CDPClient constructor to return mock
  let mockCDP: MockCDPClient;

  beforeEach(async () => {
    storage = createMockStorage();
    bbClient = createMockBBClient();
    sm = new SessionManager(bbClient as unknown as BrowserbaseClient, storage, TEST_OPTIONS);

    // Inject mock CDP via prototype override
    mockCDP = new MockCDPClient();
    mockCDP.responses.set("Network.getCookies", {
      cookies: [{ name: "test", value: "val", domain: "example.com", path: "/", expires: -1 }],
    });
    mockCDP.responses.set("Runtime.evaluate", { result: { value: "https://example.com" } });

    // Override CDPClient import - we'll test via the public API
    // by calling open() which creates its own CDP internally.
    // For unit tests, we test the behavior through storage state.
  });

  describe("open", () => {
    it("throws if session already has active browser", async () => {
      await storage.put("browser:active:session-1", {
        browserbaseId: "bb-old",
        connectUrl: "wss://connect.browserbase.com/bb-old",
        usedContext: false,
        startedAt: new Date().toISOString(),
      } satisfies ActiveSession);

      await expect(sm.open("session-1")).rejects.toThrow("already open");
    });
  });

  describe("clearState", () => {
    it("deletes all state when no domain specified", async () => {
      await storage.put("browser:state", {
        cookies: [{ name: "a", domain: "x.com" }],
        savedAt: new Date().toISOString(),
      });

      await sm.clearState();

      const state = await storage.get<BrowserState>("browser:state");
      expect(state).toBeUndefined();
    });

    it("removes only matching domain cookies", async () => {
      const baseCookie = { value: "v", size: 10, httpOnly: false, secure: false, session: true };
      await storage.put("browser:state", {
        cookies: [
          { ...baseCookie, name: "a", domain: "github.com", path: "/", expires: -1 },
          { ...baseCookie, name: "b", domain: "stripe.com", path: "/", expires: -1 },
        ],
        savedAt: new Date().toISOString(),
      } satisfies BrowserState);

      await sm.clearState("github.com");

      const state = await storage.get<BrowserState>("browser:state");
      expect(state?.cookies).toHaveLength(1);
      expect(state?.cookies[0].domain).toBe("stripe.com");
    });
  });

  describe("isActive", () => {
    it("returns false when no active session", async () => {
      expect(await sm.isActive("session-1")).toBe(false);
    });

    it("returns true when active session exists", async () => {
      await storage.put("browser:active:session-1", {
        browserbaseId: "bb-1",
        connectUrl: "wss://connect.browserbase.com/bb-1",
        usedContext: false,
        startedAt: new Date().toISOString(),
      } satisfies ActiveSession);

      expect(await sm.isActive("session-1")).toBe(true);
    });
  });

  describe("recoverOrphans", () => {
    it("returns empty when no active sessions", async () => {
      const recovered = await sm.recoverOrphans();
      expect(recovered).toEqual([]);
    });

    it("releases orphaned sessions with no CDP client", async () => {
      // Simulate orphan: KV entry exists but no in-memory CDP
      const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      await storage.put("browser:active:orphan-1", {
        browserbaseId: "bb-orphan-1",
        connectUrl: "wss://connect.browserbase.com/bb-orphan-1",
        usedContext: false,
        startedAt,
      } satisfies ActiveSession);

      const recovered = await sm.recoverOrphans();

      expect(recovered).toHaveLength(1);
      expect(recovered[0].sessionId).toBe("orphan-1");
      expect(recovered[0].durationMinutes).toBeGreaterThanOrEqual(5);
      expect(bbClient.releaseSession).toHaveBeenCalledWith("bb-orphan-1");

      // KV entry should be cleaned up
      const active = await storage.get("browser:active:orphan-1");
      expect(active).toBeUndefined();
    });

    it("recovers multiple orphaned sessions", async () => {
      const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      await storage.put("browser:active:orphan-a", {
        browserbaseId: "bb-a",
        connectUrl: "wss://connect.browserbase.com/bb-a",
        usedContext: false,
        startedAt,
      } satisfies ActiveSession);
      await storage.put("browser:active:orphan-b", {
        browserbaseId: "bb-b",
        connectUrl: "wss://connect.browserbase.com/bb-b",
        usedContext: false,
        startedAt,
      } satisfies ActiveSession);

      const recovered = await sm.recoverOrphans();

      expect(recovered).toHaveLength(2);
      expect(bbClient.releaseSession).toHaveBeenCalledTimes(2);
    });

    it("handles Browserbase API failure gracefully", async () => {
      await storage.put("browser:active:orphan-fail", {
        browserbaseId: "bb-fail",
        connectUrl: "wss://connect.browserbase.com/bb-fail",
        usedContext: false,
        startedAt: new Date().toISOString(),
      } satisfies ActiveSession);

      // Make releaseSession fail
      (bbClient.releaseSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("API error"),
      );

      // Should not throw — best-effort
      const recovered = await sm.recoverOrphans();
      expect(recovered).toHaveLength(1);

      // KV should still be cleaned up
      const active = await storage.get("browser:active:orphan-fail");
      expect(active).toBeUndefined();
    });
  });

  describe("refs", () => {
    it("stores and retrieves ref maps", () => {
      const refs = { e1: { nodeId: "1", backendDOMNodeId: 10, role: "button", name: "Submit" } };
      sm.setRefs("session-1", refs);
      expect(sm.getRefs("session-1")).toEqual(refs);
    });

    it("returns undefined for unknown session", () => {
      expect(sm.getRefs("unknown")).toBeUndefined();
    });
  });
});
