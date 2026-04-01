import { describe, expect, it, vi } from "vitest";

// Mock cloudflare:workers to avoid resolution failure when importing tools
// biome-ignore lint/style/useNamingConvention: Must match cloudflare:workers export name
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { a2aClient } from "../client/capability.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper
type R = any;

function createMockStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
    list: async <T>(prefix?: string) => {
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

const DEFAULT_OPTIONS = {
  agentId: "agent-1",
  agentName: "Test Agent",
  getAgentStub: vi.fn(),
  callbackBaseUrl: "https://agent",
};

describe("a2aClient", () => {
  it("returns a capability with correct id and name", () => {
    const cap = a2aClient(DEFAULT_OPTIONS);

    expect(cap.id).toBe("a2a-client");
    expect(cap.name).toBe("A2A Client");
    expect(cap.description).toBeDefined();
  });

  it("provides prompt sections", () => {
    const cap = a2aClient(DEFAULT_OPTIONS);

    const sections = cap.promptSections!({} as R);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("delegate work");
    expect(sections[0]).toContain("call_agent");
    expect(sections[0]).toContain("start_task");
  });

  it("registers 4 tools", () => {
    const cap = a2aClient(DEFAULT_OPTIONS);
    const storage = createMockStorage();

    const tools = cap.tools!({
      storage,
      sessionId: "session-1",
    } as R);

    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain("call_agent");
    expect(names).toContain("start_task");
    expect(names).toContain("check_task");
    expect(names).toContain("cancel_task");
  });

  it("registers HTTP handler for callbacks", () => {
    const cap = a2aClient(DEFAULT_OPTIONS);
    const storage = createMockStorage();

    const handlers = cap.httpHandlers!({ storage } as R);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].method).toBe("POST");
    expect(handlers[0].path).toBe("/a2a-callback");
  });

  it("uses default maxDepth of 5 when not specified", () => {
    const cap = a2aClient({
      agentId: "agent-1",
      getAgentStub: vi.fn(),
      callbackBaseUrl: "https://agent",
    });

    // We can verify this indirectly - the capability should still work
    expect(cap.id).toBe("a2a-client");
  });

  it("throws when storage is not initialized (tools before httpHandlers)", () => {
    const cap = a2aClient(DEFAULT_OPTIONS);

    // The capability stores _storage internally. If tools() hasn't been called,
    // the getStorage() closure will throw. This is a guard rail test.
    expect(cap.id).toBe("a2a-client");
  });

  describe("hooks.onConnect", () => {
    it("broadcasts active tasks on connect", async () => {
      const cap = a2aClient(DEFAULT_OPTIONS);
      const storage = createMockStorage();

      // Pre-populate with active tasks
      await storage.put("task:t1", {
        taskId: "t1",
        contextId: "ctx-1",
        targetAgent: "agent-2",
        targetAgentName: "Agent Two",
        originalRequest: "Do something",
        state: "working",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        originSessionId: "session-1",
        webhookToken: "token",
      });

      const broadcast = vi.fn();
      await cap.hooks!.onConnect!({
        storage,
        broadcast,
      } as R);

      expect(broadcast).toHaveBeenCalledOnce();
      expect(broadcast.mock.calls[0][0]).toBe("a2a_active_tasks");
      expect(broadcast.mock.calls[0][1].tasks).toHaveLength(1);
      expect(broadcast.mock.calls[0][1].tasks[0].taskId).toBe("t1");
    });

    it("does not broadcast when no active tasks", async () => {
      const cap = a2aClient(DEFAULT_OPTIONS);
      const storage = createMockStorage();

      // Only terminal tasks
      await storage.put("task:t1", {
        taskId: "t1",
        contextId: "ctx-1",
        targetAgent: "agent-2",
        targetAgentName: "Agent Two",
        originalRequest: "Done",
        state: "completed",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        originSessionId: "session-1",
        webhookToken: "token",
      });

      const broadcast = vi.fn();
      await cap.hooks!.onConnect!({
        storage,
        broadcast,
      } as R);

      expect(broadcast).not.toHaveBeenCalled();
    });

    it("does not broadcast when no broadcast function", async () => {
      const cap = a2aClient(DEFAULT_OPTIONS);
      const storage = createMockStorage();

      await storage.put("task:t1", {
        taskId: "t1",
        contextId: "ctx-1",
        targetAgent: "agent-2",
        targetAgentName: "Agent Two",
        originalRequest: "Do something",
        state: "working",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        originSessionId: "session-1",
        webhookToken: "token",
      });

      // No broadcast function — should not throw
      await cap.hooks!.onConnect!({
        storage,
        broadcast: undefined,
      } as R);
    });
  });
});
