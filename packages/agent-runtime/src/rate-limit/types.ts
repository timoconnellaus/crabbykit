/**
 * Runtime rate limiter interface exposed on `AgentContext` and
 * `CapabilityHttpContext`.
 *
 * The runtime owns the single blessed implementation; capabilities (channels
 * in particular) must call `consume` rather than implementing their own
 * rate-limit counters.
 *
 * @see SlidingWindowRateLimiter for the shared implementation.
 */
export interface RateLimiter {
  /**
   * Attempt to consume one unit from the bucket identified by `key`.
   *
   * Both `perMinute` and (optionally) `perHour` buckets are read, incremented,
   * and written in a single atomic critical section. If either bucket is at
   * its limit, `allowed` is `false` and `reason` identifies the violating
   * bucket.
   *
   * @example
   * ```ts
   * const { allowed, reason } = await ctx.rateLimit.consume({
   *   key: `telegram:@alice`,
   *   perMinute: 10,
   *   perHour: 100,
   * });
   * if (!allowed) {
   *   // reason === "perMinute limit exceeded" | "perHour limit exceeded"
   * }
   * ```
   */
  consume(opts: {
    /** Caller-supplied bucket key. MUST be unique per logical limit. */
    key: string;
    /** Per-minute limit (required). */
    perMinute: number;
    /** Optional per-hour limit. When present, consume requires BOTH buckets to pass. */
    perHour?: number;
  }): Promise<{ allowed: boolean; reason?: string }>;
}
