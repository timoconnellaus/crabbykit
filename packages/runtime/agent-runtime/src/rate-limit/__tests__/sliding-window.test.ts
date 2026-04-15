import { beforeEach, describe, expect, it } from "vitest";
import { createMockSqlStore } from "../../test-helpers/mock-sql-storage.js";
import { SlidingWindowRateLimiter } from "../sliding-window.js";

describe("SlidingWindowRateLimiter", () => {
  let limiter: SlidingWindowRateLimiter;
  let clock: { value: number };

  beforeEach(() => {
    clock = { value: 1_700_000_000_000 };
    limiter = new SlidingWindowRateLimiter(createMockSqlStore(), () => clock.value);
  });

  describe("basic consume", () => {
    it("allows under-limit calls", async () => {
      const r1 = await limiter.consume({ key: "k", perMinute: 3 });
      const r2 = await limiter.consume({ key: "k", perMinute: 3 });
      const r3 = await limiter.consume({ key: "k", perMinute: 3 });
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
    });

    it("denies at-limit calls with reason", async () => {
      await limiter.consume({ key: "k", perMinute: 2 });
      await limiter.consume({ key: "k", perMinute: 2 });
      const r3 = await limiter.consume({ key: "k", perMinute: 2 });
      expect(r3).toEqual({ allowed: false, reason: "perMinute limit exceeded" });
    });

    it("isolates buckets by key", async () => {
      await limiter.consume({ key: "a", perMinute: 1 });
      const deniedA = await limiter.consume({ key: "a", perMinute: 1 });
      const allowedB = await limiter.consume({ key: "b", perMinute: 1 });
      expect(deniedA.allowed).toBe(false);
      expect(allowedB.allowed).toBe(true);
    });
  });

  describe("multi-bucket", () => {
    it("denies when perHour is exhausted but perMinute is under limit", async () => {
      // Fill the hour bucket to 2 with 2 calls, then ensure the third call
      // (perHour limit 2) is denied with the perHour reason.
      await limiter.consume({ key: "k", perMinute: 10, perHour: 2 });
      await limiter.consume({ key: "k", perMinute: 10, perHour: 2 });
      const r3 = await limiter.consume({ key: "k", perMinute: 10, perHour: 2 });
      expect(r3).toEqual({ allowed: false, reason: "perHour limit exceeded" });
    });

    it("allows when both buckets are under limit", async () => {
      const r = await limiter.consume({ key: "k", perMinute: 10, perHour: 100 });
      expect(r).toEqual({ allowed: true });
    });

    it("denies when perMinute is exhausted even if perHour has room", async () => {
      await limiter.consume({ key: "k", perMinute: 1, perHour: 1000 });
      const r = await limiter.consume({ key: "k", perMinute: 1, perHour: 1000 });
      expect(r).toEqual({ allowed: false, reason: "perMinute limit exceeded" });
    });
  });

  describe("window slides", () => {
    it("resets the perMinute window after 60s have elapsed", async () => {
      await limiter.consume({ key: "k", perMinute: 1 });
      const denied = await limiter.consume({ key: "k", perMinute: 1 });
      expect(denied.allowed).toBe(false);

      clock.value += 60_001;
      const allowed = await limiter.consume({ key: "k", perMinute: 1 });
      expect(allowed).toEqual({ allowed: true });
    });

    it("resets the perHour window after 3600s have elapsed", async () => {
      await limiter.consume({ key: "k", perMinute: 10, perHour: 1 });
      const denied = await limiter.consume({ key: "k", perMinute: 10, perHour: 1 });
      expect(denied).toEqual({ allowed: false, reason: "perHour limit exceeded" });

      clock.value += 60 * 60_000 + 1;
      const allowed = await limiter.consume({ key: "k", perMinute: 10, perHour: 1 });
      expect(allowed).toEqual({ allowed: true });
    });
  });

  describe("concurrent consume race", () => {
    it("exactly one call wins when 20 parallel requests arrive at bucket limit minus 1", async () => {
      // Pre-consume 9/10 slots so the next call takes the bucket to its limit.
      for (let i = 0; i < 9; i++) {
        await limiter.consume({ key: "race", perMinute: 10 });
      }

      // 20 concurrent requests: exactly one should succeed (the 10th slot),
      // the other 19 should be denied.
      const results = await Promise.all(
        Array.from({ length: 20 }, () => limiter.consume({ key: "race", perMinute: 10 })),
      );
      const allowed = results.filter((r) => r.allowed).length;
      const denied = results.filter((r) => !r.allowed).length;
      expect(allowed).toBe(1);
      expect(denied).toBe(19);
    });
  });
});
