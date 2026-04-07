import { describe, expect, it } from "vitest";
import type { Api, Model, Usage } from "../types.js";
import {
  calculateCost,
  getModel,
  getModels,
  getProviders,
  modelsAreEqual,
  supportsXhigh,
} from "../models.js";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

describe("calculateCost", () => {
  it("correctly calculates input/output/cacheRead/cacheWrite costs from per-million-token rates", () => {
    const model = makeModel({
      cost: { input: 3, output: 15, cacheRead: 1.5, cacheWrite: 3.75 },
    });
    const usage = makeUsage({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 100,
    });

    const cost = calculateCost(model, usage);

    expect(cost.input).toBeCloseTo(0.003); // 3/1M * 1000
    expect(cost.output).toBeCloseTo(0.0075); // 15/1M * 500
    expect(cost.cacheRead).toBeCloseTo(0.003); // 1.5/1M * 2000
    expect(cost.cacheWrite).toBeCloseTo(0.000375); // 3.75/1M * 100
    expect(cost.total).toBeCloseTo(0.003 + 0.0075 + 0.003 + 0.000375);
  });

  it("zero usage produces zero cost", () => {
    const model = makeModel({
      cost: { input: 10, output: 30, cacheRead: 5, cacheWrite: 7 },
    });
    const usage = makeUsage();

    const cost = calculateCost(model, usage);

    expect(cost.input).toBe(0);
    expect(cost.output).toBe(0);
    expect(cost.cacheRead).toBe(0);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBe(0);
  });

  it("mutates usage.cost in place and returns it", () => {
    const model = makeModel({
      cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
    });
    const usage = makeUsage({ input: 1000000, output: 1000000 });

    const result = calculateCost(model, usage);

    expect(result).toBe(usage.cost);
    expect(usage.cost.input).toBe(2);
    expect(usage.cost.output).toBe(4);
    expect(usage.cost.total).toBe(6);
  });
});

describe("supportsXhigh", () => {
  it.each([
    "gpt-5.2",
    "gpt-5.2-mini",
    "some-gpt-5.2-variant",
  ])("returns true for model ID containing gpt-5.2: %s", (id) => {
    expect(supportsXhigh(makeModel({ id }))).toBe(true);
  });

  it.each(["gpt-5.3", "gpt-5.4"])("returns true for model ID containing %s", (id) => {
    expect(supportsXhigh(makeModel({ id }))).toBe(true);
  });

  it.each([
    "claude-opus-4-6",
    "claude-opus-4.6",
    "anthropic/opus-4-6",
    "opus-4.6-1m",
  ])("returns true for model ID containing opus-4-6 or opus-4.6: %s", (id) => {
    expect(supportsXhigh(makeModel({ id }))).toBe(true);
  });

  it.each([
    "gpt-4o",
    "gpt-4o-mini",
    "claude-3-sonnet",
    "claude-3.5-sonnet",
    "gpt-5.1",
  ])("returns false for model ID: %s", (id) => {
    expect(supportsXhigh(makeModel({ id }))).toBe(false);
  });
});

describe("modelsAreEqual", () => {
  it("returns true when id and provider match", () => {
    const a = makeModel({ id: "gpt-4o", provider: "openai" });
    const b = makeModel({ id: "gpt-4o", provider: "openai" });
    expect(modelsAreEqual(a, b)).toBe(true);
  });

  it("returns false when id differs", () => {
    const a = makeModel({ id: "gpt-4o", provider: "openai" });
    const b = makeModel({ id: "gpt-4o-mini", provider: "openai" });
    expect(modelsAreEqual(a, b)).toBe(false);
  });

  it("returns false when provider differs", () => {
    const a = makeModel({ id: "gpt-4o", provider: "openai" });
    const b = makeModel({ id: "gpt-4o", provider: "openrouter" });
    expect(modelsAreEqual(a, b)).toBe(false);
  });

  it("returns false when a is null", () => {
    expect(modelsAreEqual(null, makeModel())).toBe(false);
  });

  it("returns false when a is undefined", () => {
    expect(modelsAreEqual(undefined, makeModel())).toBe(false);
  });

  it("returns false when b is null", () => {
    expect(modelsAreEqual(makeModel(), null)).toBe(false);
  });

  it("returns false when b is undefined", () => {
    expect(modelsAreEqual(makeModel(), undefined)).toBe(false);
  });
});

describe("getModel", () => {
  it("returns a model for a known provider and modelId", () => {
    const model = getModel("openrouter", "ai21/jamba-large-1.7");
    expect(model).toBeDefined();
    expect(model.id).toBe("ai21/jamba-large-1.7");
    expect(model.provider).toBe("openrouter");
    expect(model.api).toBe("openai-completions");
  });

  it("returns undefined for unknown modelId", () => {
    const model = getModel("openrouter", "nonexistent/model" as any);
    expect(model).toBeUndefined();
  });
});

describe("getProviders", () => {
  it("returns an array of known provider strings", () => {
    const providers = getProviders();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
  });

  it("includes openai and openrouter", () => {
    const providers = getProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("openrouter");
  });
});

describe("getModels", () => {
  it("returns array of models for a known provider", () => {
    const models = getModels("openrouter");
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.provider).toBe("openrouter");
    }
  });

  it("returns empty array for unknown provider", () => {
    const models = getModels("nonexistent-provider" as any);
    expect(models).toEqual([]);
  });
});
