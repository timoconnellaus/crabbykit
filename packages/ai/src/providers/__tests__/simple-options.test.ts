import { describe, expect, it } from "vitest";
import type { Api, Model } from "../../types.js";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "../simple-options.js";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

describe("buildBaseOptions", () => {
  it("uses options.maxTokens when provided", () => {
    const model = makeModel({ maxTokens: 16384 });
    const result = buildBaseOptions(model, { maxTokens: 4096 });
    expect(result.maxTokens).toBe(4096);
  });

  it("defaults maxTokens to min(model.maxTokens, 32000)", () => {
    const smallModel = makeModel({ maxTokens: 8192 });
    expect(buildBaseOptions(smallModel).maxTokens).toBe(8192);

    const largeModel = makeModel({ maxTokens: 200000 });
    expect(buildBaseOptions(largeModel).maxTokens).toBe(32000);
  });

  it("apiKey param takes precedence over options.apiKey", () => {
    const model = makeModel();
    const result = buildBaseOptions(model, { apiKey: "options-key" }, "param-key");
    expect(result.apiKey).toBe("param-key");
  });

  it("falls back to options.apiKey when param is not provided", () => {
    const model = makeModel();
    const result = buildBaseOptions(model, { apiKey: "options-key" });
    expect(result.apiKey).toBe("options-key");
  });

  it("passes through all optional fields", () => {
    const model = makeModel();
    const controller = new AbortController();
    const onPayload = () => undefined;
    const result = buildBaseOptions(model, {
      temperature: 0.7,
      maxTokens: 1000,
      signal: controller.signal,
      apiKey: "key",
      cacheRetention: "long",
      sessionId: "sess-1",
      headers: { "X-Custom": "value" },
      onPayload,
      maxRetryDelayMs: 5000,
      metadata: { userId: "u1" },
    });

    expect(result.temperature).toBe(0.7);
    expect(result.maxTokens).toBe(1000);
    expect(result.signal).toBe(controller.signal);
    expect(result.apiKey).toBe("key");
    expect(result.cacheRetention).toBe("long");
    expect(result.sessionId).toBe("sess-1");
    expect(result.headers).toEqual({ "X-Custom": "value" });
    expect(result.onPayload).toBe(onPayload);
    expect(result.maxRetryDelayMs).toBe(5000);
    expect(result.metadata).toEqual({ userId: "u1" });
  });
});

describe("clampReasoning", () => {
  it('clamps "xhigh" to "high"', () => {
    expect(clampReasoning("xhigh")).toBe("high");
  });

  it('passes "high" through unchanged', () => {
    expect(clampReasoning("high")).toBe("high");
  });

  it("returns undefined for undefined", () => {
    expect(clampReasoning(undefined)).toBeUndefined();
  });

  it('passes "medium" through unchanged', () => {
    expect(clampReasoning("medium")).toBe("medium");
  });

  it('passes "minimal" through unchanged', () => {
    expect(clampReasoning("minimal")).toBe("minimal");
  });

  it('passes "low" through unchanged', () => {
    expect(clampReasoning("low")).toBe("low");
  });
});

describe("adjustMaxTokensForThinking", () => {
  it("uses default budgets", () => {
    // medium default budget = 8192
    const result = adjustMaxTokensForThinking(4096, 100000, "medium");
    expect(result.maxTokens).toBe(4096 + 8192);
    expect(result.thinkingBudget).toBe(8192);
  });

  it("uses correct budget for each level", () => {
    expect(adjustMaxTokensForThinking(4096, 100000, "minimal").thinkingBudget).toBe(1024);
    expect(adjustMaxTokensForThinking(4096, 100000, "low").thinkingBudget).toBe(2048);
    expect(adjustMaxTokensForThinking(4096, 100000, "medium").thinkingBudget).toBe(8192);
    expect(adjustMaxTokensForThinking(4096, 100000, "high").thinkingBudget).toBe(16384);
  });

  it("custom budgets override defaults", () => {
    const result = adjustMaxTokensForThinking(4096, 100000, "medium", { medium: 2000 });
    expect(result.maxTokens).toBe(4096 + 2000);
    expect(result.thinkingBudget).toBe(2000);
  });

  it("caps maxTokens at modelMaxTokens", () => {
    const result = adjustMaxTokensForThinking(4096, 5000, "high");
    // base(4096) + budget(16384) = 20480, capped to 5000
    expect(result.maxTokens).toBe(5000);
  });

  it("reduces thinkingBudget when maxTokens is small", () => {
    // modelMax = 2000, budget = 8192 (medium), base = 4096
    // maxTokens = min(4096 + 8192, 2000) = 2000
    // maxTokens(2000) <= thinkingBudget(8192), so budget = max(0, 2000 - 1024) = 976
    const result = adjustMaxTokensForThinking(4096, 2000, "medium");
    expect(result.maxTokens).toBe(2000);
    expect(result.thinkingBudget).toBe(976);
  });

  it("reduces thinkingBudget to 0 when maxTokens is very small", () => {
    // modelMax = 500, budget = 8192 (medium), base = 4096
    // maxTokens = min(4096 + 8192, 500) = 500
    // maxTokens(500) <= thinkingBudget(8192), so budget = max(0, 500 - 1024) = 0
    const result = adjustMaxTokensForThinking(4096, 500, "medium");
    expect(result.maxTokens).toBe(500);
    expect(result.thinkingBudget).toBe(0);
  });

  it('clamps "xhigh" to "high" (budget 16384)', () => {
    const result = adjustMaxTokensForThinking(4096, 100000, "xhigh");
    expect(result.maxTokens).toBe(4096 + 16384);
    expect(result.thinkingBudget).toBe(16384);
  });
});
