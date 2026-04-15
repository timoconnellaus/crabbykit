import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetTracker } from "../budget-tracker.js";

describe("BudgetTracker", () => {
  it("allows calls within budget", () => {
    const tracker = new BudgetTracker({
      maxSqlOps: 3,
      maxKvOps: 2,
      maxBroadcasts: 5,
      maxAlarms: 1,
    });

    expect(() => tracker.check("nonce-1", "sql")).not.toThrow();
    expect(() => tracker.check("nonce-1", "sql")).not.toThrow();
    expect(() => tracker.check("nonce-1", "sql")).not.toThrow();
  });

  it("throws BudgetExceededError when limit reached", () => {
    const tracker = new BudgetTracker({
      maxSqlOps: 2,
      maxKvOps: 1,
      maxBroadcasts: 1,
      maxAlarms: 1,
    });

    tracker.check("nonce-1", "sql");
    tracker.check("nonce-1", "sql");

    expect(() => tracker.check("nonce-1", "sql")).toThrow(BudgetExceededError);
  });

  it("tracks categories independently", () => {
    const tracker = new BudgetTracker({
      maxSqlOps: 1,
      maxKvOps: 1,
      maxBroadcasts: 1,
      maxAlarms: 1,
    });

    tracker.check("nonce-1", "sql");
    tracker.check("nonce-1", "kv");
    tracker.check("nonce-1", "broadcast");
    tracker.check("nonce-1", "alarm");

    // Each at limit
    expect(() => tracker.check("nonce-1", "sql")).toThrow(BudgetExceededError);
    expect(() => tracker.check("nonce-1", "kv")).toThrow(BudgetExceededError);
    expect(() => tracker.check("nonce-1", "broadcast")).toThrow(BudgetExceededError);
    expect(() => tracker.check("nonce-1", "alarm")).toThrow(BudgetExceededError);
  });

  it("tracks nonces independently", () => {
    const tracker = new BudgetTracker({
      maxSqlOps: 1,
      maxKvOps: 1,
      maxBroadcasts: 1,
      maxAlarms: 1,
    });

    tracker.check("nonce-1", "sql");
    expect(() => tracker.check("nonce-1", "sql")).toThrow();

    // Different nonce has its own budget
    expect(() => tracker.check("nonce-2", "sql")).not.toThrow();
  });

  it("cleanup removes counters for a nonce", () => {
    const tracker = new BudgetTracker({
      maxSqlOps: 1,
      maxKvOps: 1,
      maxBroadcasts: 1,
      maxAlarms: 1,
    });

    tracker.check("nonce-1", "sql");
    expect(() => tracker.check("nonce-1", "sql")).toThrow();

    tracker.cleanup("nonce-1");

    // After cleanup, budget is reset for that nonce
    expect(() => tracker.check("nonce-1", "sql")).not.toThrow();
  });

  it("uses default budget when no config provided", () => {
    const tracker = new BudgetTracker();

    // Default: 100 SQL ops
    for (let i = 0; i < 100; i++) {
      tracker.check("nonce-1", "sql");
    }
    expect(() => tracker.check("nonce-1", "sql")).toThrow(BudgetExceededError);
  });

  it("error message includes category and limit", () => {
    const tracker = new BudgetTracker({
      maxSqlOps: 5,
      maxKvOps: 1,
      maxBroadcasts: 1,
      maxAlarms: 1,
    });

    for (let i = 0; i < 5; i++) tracker.check("n", "sql");

    try {
      tracker.check("n", "sql");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as BudgetExceededError).message).toContain("sql");
      expect((e as BudgetExceededError).message).toContain("5");
      expect((e as BudgetExceededError).code).toBe("ERR_BUDGET_EXCEEDED");
    }
  });

  describe("parallel call simulation", () => {
    it("concurrent checks on same nonce are serialized by JS event loop", () => {
      const tracker = new BudgetTracker({
        maxSqlOps: 3,
        maxKvOps: 1,
        maxBroadcasts: 1,
        maxAlarms: 1,
      });

      // Simulate "parallel" — in JS, these execute sequentially
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        try {
          tracker.check("nonce-1", "sql");
          results.push(true);
        } catch {
          results.push(false);
        }
      }

      expect(results).toEqual([true, true, true, false, false]);
    });
  });
});
