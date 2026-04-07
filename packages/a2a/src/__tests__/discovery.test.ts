import { describe, expect, it, vi } from "vitest";
import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { fetchAgentCard, getAgentCard } from "../client/discovery.js";
import type { AgentCard } from "../types.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper
type R = any;

const MOCK_CARD: AgentCard = {
  name: "Remote Agent",
  description: "A remote agent",
  url: "https://remote.example.com",
  version: "1.0.0",
  protocolVersion: "1.0",
  capabilities: { streaming: true },
  skills: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
};

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

describe("fetchAgentCard", () => {
  it("fetches agent card from well-known URL", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(MOCK_CARD), { status: 200 }));

    const card = await fetchAgentCard("https://remote.example.com", mockFetch as R);

    expect(card.name).toBe("Remote Agent");
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://remote.example.com/.well-known/agent-card.json");
    expect(init.headers.Accept).toBe("application/json");
  });

  it("handles URL with trailing slash", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(MOCK_CARD), { status: 200 }));

    await fetchAgentCard("https://remote.example.com/", mockFetch as R);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://remote.example.com/.well-known/agent-card.json");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));

    await expect(fetchAgentCard("https://remote.example.com", mockFetch as R)).rejects.toThrow(
      "Failed to fetch agent card",
    );
  });
});

describe("getAgentCard", () => {
  it("fetches and caches agent card", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(MOCK_CARD), { status: 200 }));
    const storage = createMockStorage();

    const card = await getAgentCard("https://remote.example.com", mockFetch as R, storage);

    expect(card.name).toBe("Remote Agent");
    expect(mockFetch).toHaveBeenCalledOnce();

    // Second call should use cache
    const card2 = await getAgentCard("https://remote.example.com", mockFetch as R, storage);
    expect(card2.name).toBe("Remote Agent");
    expect(mockFetch).toHaveBeenCalledOnce(); // Not called again
  });

  it("refetches when cache is expired", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(MOCK_CARD), { status: 200 }));
    const storage = createMockStorage();

    // Pre-populate with an expired cache entry
    await storage.put("card:https://remote.example.com", {
      card: { ...MOCK_CARD, name: "Old Agent" },
      fetchedAt: Date.now() - 600_000, // 10 minutes ago
    });

    // Use default TTL of 300s
    const card = await getAgentCard("https://remote.example.com", mockFetch as R, storage);

    // Should have fetched fresh
    expect(card.name).toBe("Remote Agent");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("uses cached card within TTL", async () => {
    const mockFetch = vi.fn();
    const storage = createMockStorage();

    // Pre-populate with a fresh cache entry
    await storage.put("card:https://remote.example.com", {
      card: { ...MOCK_CARD, name: "Cached Agent" },
      fetchedAt: Date.now() - 10_000, // 10 seconds ago
    });

    const card = await getAgentCard("https://remote.example.com", mockFetch as R, storage);

    expect(card.name).toBe("Cached Agent");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("respects custom TTL", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(MOCK_CARD), { status: 200 }));
    const storage = createMockStorage();

    // Pre-populate with a cache entry 2 seconds old
    await storage.put("card:https://remote.example.com", {
      card: { ...MOCK_CARD, name: "Cached Agent" },
      fetchedAt: Date.now() - 2_000,
    });

    // Use TTL of 1 second — cache should be expired
    const card = await getAgentCard("https://remote.example.com", mockFetch as R, storage, 1);

    expect(card.name).toBe("Remote Agent");
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
