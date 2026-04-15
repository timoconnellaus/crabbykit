import { describe, expect, it } from "vitest";
import { READBACK_DELAYS } from "../types.js";

describe("KV readback verification", () => {
  it("polling schedule has 7 steps", () => {
    expect(READBACK_DELAYS).toHaveLength(7);
  });

  it("delays increase monotonically", () => {
    for (let i = 1; i < READBACK_DELAYS.length; i++) {
      expect(READBACK_DELAYS[i]).toBeGreaterThanOrEqual(READBACK_DELAYS[i - 1]);
    }
  });

  it("total polling time is ~5s", () => {
    const total = READBACK_DELAYS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(4000);
    expect(total).toBeLessThan(6000);
  });

  it("first delay is short for fast reads", () => {
    expect(READBACK_DELAYS[0]).toBe(50);
  });

  it("last delay is capped at 2s", () => {
    expect(READBACK_DELAYS[READBACK_DELAYS.length - 1]).toBe(2000);
  });

  describe("simulated readback scenarios", () => {
    async function simulateReadback(
      visibleAfterMs: number | null,
    ): Promise<{ success: boolean; attempts: number; elapsedMs: number }> {
      let elapsed = 0;
      let attempts = 0;

      for (const delay of READBACK_DELAYS) {
        elapsed += delay;
        attempts++;

        if (visibleAfterMs !== null && elapsed >= visibleAfterMs) {
          return { success: true, attempts, elapsedMs: elapsed };
        }
      }

      return { success: false, attempts, elapsedMs: elapsed };
    }

    it("succeeds on first poll when KV is immediate", async () => {
      const result = await simulateReadback(0);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it("succeeds after ~300ms lag", async () => {
      const result = await simulateReadback(300);
      expect(result.success).toBe(true);
      expect(result.attempts).toBeLessThanOrEqual(4); // 50+100+200 = 350ms
    });

    it("succeeds after ~2s lag", async () => {
      const result = await simulateReadback(2000);
      expect(result.success).toBe(true);
      expect(result.attempts).toBeLessThanOrEqual(6);
    });

    it("fails when bytes never become visible", async () => {
      const result = await simulateReadback(null);
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(7);
    });
  });
});
