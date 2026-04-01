import { describe, expect, it } from "vitest";
import type { CostEntry } from "../cost.js";
import { getCumulativeCost, persistCost, resetCost } from "../cost.js";

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

const baseCost: CostEntry = {
  model: "anthropic/claude-sonnet-4",
  amount: 0.05,
  currency: "USD",
  promptTokens: 100,
  completionTokens: 50,
  timestamp: "2026-04-01T00:00:00.000Z",
};

describe("getCumulativeCost", () => {
  it("returns 0 when no cost stored", async () => {
    const storage = createMapStorage();
    expect(await getCumulativeCost(storage)).toBe(0);
  });
});

describe("persistCost", () => {
  it("persists cost and returns new total", async () => {
    const storage = createMapStorage();
    const total = await persistCost(storage, baseCost);
    expect(total).toBe(0.05);
    expect(await getCumulativeCost(storage)).toBe(0.05);
  });

  it("accumulates costs", async () => {
    const storage = createMapStorage();
    await persistCost(storage, baseCost);
    const total = await persistCost(storage, { ...baseCost, amount: 0.1 });
    expect(total).toBeCloseTo(0.15);
  });

  it("keeps a log capped at 1000 entries", async () => {
    const storage = createMapStorage();
    for (let i = 0; i < 1005; i++) {
      await persistCost(storage, { ...baseCost, amount: 0.001 });
    }
    const log = await storage.get<CostEntry[]>("costLog");
    expect(log).toHaveLength(1000);
  });
});

describe("resetCost", () => {
  it("resets cumulative cost to 0", async () => {
    const storage = createMapStorage();
    await persistCost(storage, baseCost);
    await resetCost(storage);
    expect(await getCumulativeCost(storage)).toBe(0);
  });
});
