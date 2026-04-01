import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeToken } from "../auth.js";
import { getCumulativeCost } from "../cost.js";
import { createChatCompletionsHandler } from "../proxy-handler.js";
import type { AiProxyOptions } from "../types.js";

function createMapStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => map.delete(key),
    list: async <T>(_prefix?: string) => new Map<string, T>(),
  };
}

function createMockCtx(storage = createMapStorage()) {
  return {
    sessionStore: {} as never,
    storage,
    broadcastToAll: vi.fn(),
    sendPrompt: vi.fn(),
  };
}

const baseOptions: AiProxyOptions = {
  apiKey: "test-openrouter-key",
  workerUrl: "http://localhost:5173",
  provider: {
    start: vi.fn(),
    stop: vi.fn(),
    health: vi.fn(),
    exec: vi.fn(),
  },
};

function makeRequest(body: Record<string, unknown>, token: string) {
  return new Request("https://agent.test/ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("createChatCompletionsHandler", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects unauthenticated requests", async () => {
    const handler = createChatCompletionsHandler(baseOptions);
    const ctx = createMockCtx();
    const req = new Request("https://agent.test/ai/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    const res = await handler(req, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON body", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");
    const handler = createChatCompletionsHandler(baseOptions);
    const ctx = createMockCtx(storage);
    const req = new Request("https://agent.test/ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: "not json",
    });
    const res = await handler(req, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects request without model", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");
    const handler = createChatCompletionsHandler(baseOptions);
    const ctx = createMockCtx(storage);
    const req = makeRequest({ messages: [] }, "test-token");
    const res = await handler(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("model is required");
  });

  it("rejects disallowed model when allowedModels is set", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");
    const handler = createChatCompletionsHandler({
      ...baseOptions,
      allowedModels: ["openai/gpt-4o"],
    });
    const ctx = createMockCtx(storage);
    const req = makeRequest({ model: "anthropic/claude-opus-4", messages: [] }, "test-token");
    const res = await handler(req, ctx);
    expect(res.status).toBe(403);
  });

  it("rejects blocked model", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");
    const handler = createChatCompletionsHandler({
      ...baseOptions,
      blockedModels: ["expensive/model"],
    });
    const ctx = createMockCtx(storage);
    const req = makeRequest({ model: "expensive/model", messages: [] }, "test-token");
    const res = await handler(req, ctx);
    expect(res.status).toBe(403);
  });

  it("enforces cost cap", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");
    // Pre-set cumulative cost above cap
    await storage.put("totalCost", 5.0);
    const handler = createChatCompletionsHandler({
      ...baseOptions,
      sessionCostCap: 1.0,
    });
    const ctx = createMockCtx(storage);
    const req = makeRequest(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
      "test-token",
    );
    const res = await handler(req, ctx);
    expect(res.status).toBe(429);
  });

  it("proxies non-streaming request and tracks cost", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");

    // Mock fetch to OpenRouter
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-123",
          choices: [{ message: { content: "Hello!" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-openrouter-cost": "0.0025",
          },
        },
      ),
    );

    const handler = createChatCompletionsHandler(baseOptions);
    const ctx = createMockCtx(storage);
    const req = makeRequest(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
      "test-token",
    );
    const res = await handler(req, ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("Hello!");

    // Cost should be persisted
    expect(await getCumulativeCost(storage)).toBe(0.0025);

    // Cost event should be broadcast
    expect(ctx.broadcastToAll).toHaveBeenCalledWith(
      "cost_event",
      expect.objectContaining({
        capabilityId: "ai-proxy",
        amount: 0.0025,
      }),
    );

    // Verify upstream request had the API key
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-openrouter-key",
        }),
      }),
    );
  });

  it("passes upstream errors through", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );

    const handler = createChatCompletionsHandler(baseOptions);
    const ctx = createMockCtx(storage);
    const req = makeRequest(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
      "test-token",
    );
    const res = await handler(req, ctx);
    expect(res.status).toBe(429);
  });

  it("handles fetch failure gracefully", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const handler = createChatCompletionsHandler(baseOptions);
    const ctx = createMockCtx(storage);
    const req = makeRequest(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
      "test-token",
    );
    const res = await handler(req, ctx);
    expect(res.status).toBe(502);
  });

  it("allows model from allowedModels list", async () => {
    const storage = createMapStorage();
    await storeToken(storage, "test-token");

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const handler = createChatCompletionsHandler({
      ...baseOptions,
      allowedModels: ["openai/gpt-4o"],
    });
    const ctx = createMockCtx(storage);
    const req = makeRequest(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
      "test-token",
    );
    const res = await handler(req, ctx);
    expect(res.status).toBe(200);
  });
});
