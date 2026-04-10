import { describe, expect, it, vi } from "vitest";
import { createModelsHandler } from "../models-handler.js";
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
    broadcastState: vi.fn(),
    rateLimit: { consume: vi.fn().mockResolvedValue({ allowed: true }) },
    sendPrompt: vi.fn(),
  };
}

const baseOptions: AiProxyOptions = {
  apiKey: "test-key",
};

describe("createModelsHandler", () => {
  it("returns empty list when no allowedModels", async () => {
    const handler = createModelsHandler(baseOptions);
    const ctx = createMockCtx();
    const req = new Request("https://agent.test/ai/v1/models");
    const res = await handler(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });

  it("returns allowedModels in OpenAI format", async () => {
    const handler = createModelsHandler({
      ...baseOptions,
      allowedModels: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
    });
    const ctx = createMockCtx();
    const req = new Request("https://agent.test/ai/v1/models");
    const res = await handler(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; owned_by: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("anthropic/claude-sonnet-4");
    expect(body.data[0].owned_by).toBe("anthropic");
    expect(body.data[1].id).toBe("openai/gpt-4o");
    expect(body.data[1].owned_by).toBe("openai");
  });
});
