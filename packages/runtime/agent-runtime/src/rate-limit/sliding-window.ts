import type { SqlStore } from "../storage/types.js";
import type { RateLimiter } from "./types.js";

/** Window duration in milliseconds for the perMinute bucket. */
const MINUTE_MS = 60_000;
/** Window duration in milliseconds for the perHour bucket. */
const HOUR_MS = 60 * 60_000;

type BucketRow = { window_start: number; count: number };
type WindowKind = "minute" | "hour";

/**
 * SQL-backed sliding-window rate limiter.
 *
 * **Atomicity model.** The limiter runs inside a Durable Object whose
 * execution is single-threaded per DO instance, and `SqlStore.exec` is
 * synchronous. The critical section `consume` performs — read both buckets,
 * decide allow/deny, then write both buckets — contains **no `await`
 * points**, so two concurrent `consume` calls inside the same DO always
 * serialize: one runs to completion before the next starts. There is no
 * TOCTOU window and `blockConcurrencyWhile` is not required at this layer.
 *
 * Persistence is a single table keyed by `(bucket_key, window_kind)`. Each
 * row stores the current window start (ms since epoch) and the count
 * consumed in that window. The window slides: if the stored `window_start`
 * has fallen fully behind `now`, the effective count resets to zero.
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly sql: SqlStore;
  private readonly now: () => number;
  private initialized = false;

  constructor(sql: SqlStore, now: () => number = Date.now) {
    this.sql = sql;
    this.now = now;
  }

  private ensureSchema(): void {
    if (this.initialized) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        bucket_key TEXT NOT NULL,
        window_kind TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (bucket_key, window_kind)
      )
    `);
    this.initialized = true;
  }

  consume(opts: {
    key: string;
    perMinute: number;
    perHour?: number;
  }): Promise<{ allowed: boolean; reason?: string }> {
    this.ensureSchema();
    const now = this.now();

    // --- Begin critical section (synchronous; no awaits). ---
    const minuteRow = this.readBucket(opts.key, "minute");
    const hourRow = opts.perHour !== undefined ? this.readBucket(opts.key, "hour") : null;

    const minuteStart = this.windowStart(minuteRow, now, MINUTE_MS);
    const minuteCount = minuteRow && minuteRow.window_start === minuteStart ? minuteRow.count : 0;

    let hourStart = 0;
    let hourCount = 0;
    if (opts.perHour !== undefined) {
      hourStart = this.windowStart(hourRow, now, HOUR_MS);
      hourCount = hourRow && hourRow.window_start === hourStart ? hourRow.count : 0;
    }

    // Per-minute checked first so its reason wins when both are at limit —
    // callers care about the smaller window because it recovers fastest.
    if (minuteCount >= opts.perMinute) {
      return Promise.resolve({ allowed: false, reason: "perMinute limit exceeded" });
    }
    if (opts.perHour !== undefined && hourCount >= opts.perHour) {
      return Promise.resolve({ allowed: false, reason: "perHour limit exceeded" });
    }

    this.writeBucket(opts.key, "minute", !!minuteRow, minuteStart, minuteCount + 1);
    if (opts.perHour !== undefined) {
      this.writeBucket(opts.key, "hour", !!hourRow, hourStart, hourCount + 1);
    }
    // --- End critical section. ---

    return Promise.resolve({ allowed: true });
  }

  private readBucket(key: string, kind: WindowKind): BucketRow | null {
    const row = this.sql
      .exec<BucketRow>(
        "SELECT window_start, count FROM rate_limit_buckets WHERE bucket_key = ? AND window_kind = ?",
        key,
        kind,
      )
      .one();
    return row ?? null;
  }

  private writeBucket(
    key: string,
    kind: WindowKind,
    rowExists: boolean,
    windowStart: number,
    count: number,
  ): void {
    if (rowExists) {
      this.sql.exec(
        "UPDATE rate_limit_buckets SET window_start = ?, count = ? WHERE bucket_key = ? AND window_kind = ?",
        windowStart,
        count,
        key,
        kind,
      );
    } else {
      this.sql.exec(
        "INSERT INTO rate_limit_buckets (bucket_key, window_kind, window_start, count) VALUES (?, ?, ?, ?)",
        key,
        kind,
        windowStart,
        count,
      );
    }
  }

  /**
   * Compute the effective window_start for a bucket row at `now`, rolling
   * the window forward if the stored window has fallen fully behind.
   */
  private windowStart(row: BucketRow | null, now: number, windowMs: number): number {
    if (!row) return now;
    const age = now - row.window_start;
    if (age >= windowMs) return now;
    return row.window_start;
  }
}
