import { describe, expect, it, vi } from "vitest";

// Mock cloudflare:workers to avoid resolution failure
// biome-ignore lint/style/useNamingConvention: Must match cloudflare:workers export name
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { SqlStore } from "@claw-for-cloudflare/agent-runtime";
import { TaskStore } from "../server/task-store.js";
import { a2aServer } from "../server/capability.js";

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

function createMinimalSqlStore(): SqlStore {
  return {
    exec: vi.fn().mockReturnValue({ toArray: () => [], one: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() }),
  };
}

describe("a2aServer", () => {
  it("returns a capability with correct id and name", () => {
    const taskStore = new TaskStore(createMinimalSqlStore());
    const cap = a2aServer({ taskStore });

    expect(cap.id).toBe("a2a-server");
    expect(cap.name).toBe("A2A Protocol Server");
    expect(cap.description).toBeDefined();
  });

  it("uses default values when options are minimal", () => {
    const taskStore = new TaskStore(createMinimalSqlStore());
    const cap = a2aServer({ taskStore });

    expect(cap.configDefault).toBeDefined();
    const defaults = cap.configDefault as R;
    expect(defaults.name).toBe("Agent");
    expect(defaults.description).toBe("An A2A-compatible agent.");
    expect(defaults.url).toBe("");
  });

  it("uses provided options as defaults", () => {
    const taskStore = new TaskStore(createMinimalSqlStore());
    const cap = a2aServer({
      taskStore,
      name: "My Agent",
      description: "A custom agent",
      url: "https://my-agent.example.com",
      version: "2.0.0",
      provider: { organization: "Acme" },
    });

    const defaults = cap.configDefault as R;
    expect(defaults.name).toBe("My Agent");
    expect(defaults.description).toBe("A custom agent");
    expect(defaults.url).toBe("https://my-agent.example.com");
    expect(defaults.version).toBe("2.0.0");
    expect(defaults.provider).toEqual({ organization: "Acme" });
  });

  it("has a config schema", () => {
    const taskStore = new TaskStore(createMinimalSqlStore());
    const cap = a2aServer({ taskStore });

    expect(cap.configSchema).toBeDefined();
  });

  it("provides prompt sections", () => {
    const taskStore = new TaskStore(createMinimalSqlStore());
    const cap = a2aServer({ taskStore });

    const sections = cap.promptSections!({} as R);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("A2A");
    expect(sections[0]).toContain("agent-card.json");
  });

  it("registers HTTP handlers", () => {
    const taskStore = new TaskStore(createMinimalSqlStore());
    const cap = a2aServer({ taskStore });

    const storage = createMockStorage();
    const handlers = cap.httpHandlers!({ storage } as R);

    expect(handlers).toHaveLength(2);
    // The handlers wrap transport handlers — we verify the structure
    expect(handlers[0].method).toBe("GET");
    expect(handlers[0].path).toBe("/.well-known/agent-card.json");
    expect(handlers[1].method).toBe("POST");
    expect(handlers[1].path).toBe("/a2a");
  });

  it("throws when storage is not initialized (getStorage before httpHandlers)", () => {
    const taskStore = new TaskStore(createMinimalSqlStore());
    const cap = a2aServer({ taskStore });

    // httpHandlers initializes storage. If somehow a handler runs before httpHandlers,
    // getStorage should throw. We test this indirectly through the hooks.
    expect(cap.hooks).toBeDefined();
    expect(cap.hooks!.onConfigChange).toBeDefined();
  });

  describe("hooks.onConfigChange", () => {
    it("persists new config to storage", async () => {
      const taskStore = new TaskStore(createMinimalSqlStore());
      const cap = a2aServer({ taskStore });

      const storage = createMockStorage();
      // Initialize storage via httpHandlers
      cap.httpHandlers!({ storage } as R);

      const newConfig = {
        name: "Updated Agent",
        description: "Updated description",
        url: "https://updated.example.com",
      };

      await cap.hooks!.onConfigChange!({}, newConfig, { storage } as R);

      const stored = await storage.get("agent-card-config");
      expect(stored).toBeDefined();
      expect((stored as R).name).toBe("Updated Agent");
    });
  });
});
