import { describe, expect, it } from "vitest";
import { expiresAtFromDuration, intervalToCron, nextFireTime, validateCron } from "../cron.js";

describe("expiresAtFromDuration", () => {
  it("computes expiry from minutes", () => {
    const from = new Date("2026-03-27T10:00:00Z");
    const expires = expiresAtFromDuration("15m", from);
    expect(expires.toISOString()).toBe("2026-03-27T10:15:00.000Z");
  });

  it("computes expiry from hours", () => {
    const from = new Date("2026-03-27T10:00:00Z");
    const expires = expiresAtFromDuration("3h", from);
    expect(expires.toISOString()).toBe("2026-03-27T13:00:00.000Z");
  });

  it("computes expiry from days", () => {
    const from = new Date("2026-03-27T10:00:00Z");
    const expires = expiresAtFromDuration("7d", from);
    expect(expires.toISOString()).toBe("2026-04-03T10:00:00.000Z");
  });

  it("throws for invalid duration", () => {
    expect(() => expiresAtFromDuration("abc")).toThrow("Invalid duration");
    expect(() => expiresAtFromDuration("30s")).toThrow("Invalid duration");
  });
});

describe("intervalToCron", () => {
  it("converts minute intervals", () => {
    expect(intervalToCron("30m")).toBe("*/30 * * * *");
    expect(intervalToCron("5m")).toBe("*/5 * * * *");
    expect(intervalToCron("1m")).toBe("*/1 * * * *");
  });

  it("converts hour intervals", () => {
    expect(intervalToCron("2h")).toBe("0 */2 * * *");
    expect(intervalToCron("1h")).toBe("0 */1 * * *");
    expect(intervalToCron("12h")).toBe("0 */12 * * *");
  });

  it("throws for invalid intervals", () => {
    expect(() => intervalToCron("abc")).toThrow("Invalid interval");
    expect(() => intervalToCron("30s")).toThrow("Invalid interval");
    expect(() => intervalToCron("0m")).toThrow("Minute interval must be between");
    expect(() => intervalToCron("60m")).toThrow("Minute interval must be between");
    expect(() => intervalToCron("0h")).toThrow("Hour interval must be between");
    expect(() => intervalToCron("24h")).toThrow("Hour interval must be between");
  });
});

describe("validateCron", () => {
  it("accepts valid cron expressions", () => {
    expect(validateCron("*/30 * * * *")).toBe(true);
    expect(validateCron("0 9 * * MON-FRI")).toBe(true);
    expect(validateCron("0 0 1 * *")).toBe(true);
  });

  it("accepts interval shorthands", () => {
    expect(validateCron("30m")).toBe(true);
    expect(validateCron("2h")).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(validateCron("not-a-cron")).toBe(false);
    expect(validateCron("99 99 99 99 99")).toBe(false);
  });
});

describe("nextFireTime", () => {
  it("computes next fire time from a cron expression", () => {
    const from = new Date("2026-03-27T10:00:00Z");
    const next = nextFireTime("*/30 * * * *", from);

    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getMinutes() % 30).toBe(0);
  });

  it("computes next fire time from an interval shorthand", () => {
    const from = new Date("2026-03-27T10:00:00Z");
    const next = nextFireTime("2h", from);

    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it("returns a future date when called without from", () => {
    const before = new Date();
    const next = nextFireTime("*/5 * * * *");

    expect(next.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("throws for invalid cron", () => {
    expect(() => nextFireTime("garbage")).toThrow();
  });

  it("evaluates cron fields in a specific timezone", () => {
    // 2026-03-27T10:00:00Z = 2026-03-27T06:00:00 EDT (America/New_York, UTC-4 in March)
    const from = new Date("2026-03-27T10:00:00Z");

    // "0 9 * * *" = 9:00 AM in the given timezone
    // In New York (UTC-4): 9:00 AM EDT = 13:00 UTC
    const next = nextFireTime("0 9 * * *", from, "America/New_York");

    expect(next.getUTCHours()).toBe(13); // 9 AM EDT = 13:00 UTC
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("handles timezone vs UTC producing different results", () => {
    // 2026-03-27T23:30:00Z = 2026-03-28T08:30:00 JST (Asia/Tokyo, always UTC+9)
    const from = new Date("2026-03-27T23:30:00Z");

    // "0 9 * * *" = 9:00 AM in timezone
    // In Tokyo it's already March 28 08:30, so next 9:00 JST = March 28 00:00 UTC
    const nextTokyo = nextFireTime("0 9 * * *", from, "Asia/Tokyo");
    expect(nextTokyo.getUTCDate()).toBe(28);
    expect(nextTokyo.getUTCHours()).toBe(0); // 9 AM JST = 00:00 UTC

    // Without timezone (UTC): 23:30 UTC, next 9:00 UTC = March 28 09:00 UTC
    const nextUtc = nextFireTime("0 9 * * *", from);
    expect(nextUtc.getUTCDate()).toBe(28);
    expect(nextUtc.getUTCHours()).toBe(9);
  });
});
