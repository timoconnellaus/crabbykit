/**
 * `SpineHost` — the contract the host DO implements to receive bridged
 * calls from `SpineService`.
 *
 * Lives in `agent-runtime` rather than `bundle-host` because the DO
 * (`AgentDO` in this package) is the structural implementation of the
 * interface. Keeping the contract next to the implementation means a
 * drift-free type-level assertion can live in `agent-do.ts`:
 *
 *   const _spineHostCheck: (x: AgentDO<any>) => SpineHost = (x) => x;
 *
 * `bundle-host/src/services/spine-service.ts` imports this interface
 * to constrain the shape of its RPC callbacks without creating a
 * direct runtime edge from `bundle-host` into `agent-runtime` for
 * values — only a type-level one. Specifically, `SpineService` types
 * its DO stub as `DurableObjectStub<SpineHost>`, which requires the
 * interface to extend `Rpc.DurableObjectBranded` — the runtime brand
 * Cloudflare Workers types use to tag shapes that can be proxied
 * across the DO RPC boundary. `AgentDO` extends `DurableObject`,
 * which applies this brand on the implementation side; the brand in
 * the interface declaration is what lets the stub type narrow to the
 * spine methods at the call site.
 *
 * Every method takes a `SpineCaller` context as its first argument —
 * a plain `{aid, sid, nonce}` object constructed by `SpineService`
 * from a verified capability token. Budget enforcement lives on the
 * DO side (`AgentRuntime.spineBudget`) and uses `caller.nonce` as the
 * per-turn accumulator key, so every spine method can increment the
 * per-turn budget atomically with the work it performs.
 */

/**
 * Trusted caller context passed to every `SpineHost` method.
 *
 * Constructed by `SpineService` from a verified capability token
 * payload after signature and TTL checks pass. Consumers of
 * `SpineHost` methods trust this context because any holder of a
 * `DurableObjectNamespace<AgentDO>` binding is already privileged
 * code (the bundle isolate cannot structured-clone a DO namespace
 * binding and so cannot call these methods at all).
 *
 * The DO does NOT re-verify the fields on this object; their
 * integrity is the caller's responsibility. See the `SpineService.verify`
 * docstring for the full trust chain.
 */
export interface SpineCaller {
  /** Verified agent id (from token payload `aid`). */
  readonly aid: string;
  /**
   * Verified session id (from token payload `sid`). May be empty for
   * agent-scoped methods such as `spineCreateSession` / `spineListSessions`
   * that do not bind to a specific session.
   */
  readonly sid: string;
  /**
   * Verified nonce (from token payload `nonce`). Used as the per-turn
   * budget accumulator key — every spine call made with the same nonce
   * counts against the same per-turn budget.
   */
  readonly nonce: string;
}

export interface SpineHost extends Rpc.DurableObjectBranded {
  // Session store (sync on DO side)
  spineAppendEntry(sessionId: string, entry: unknown): unknown;
  spineGetEntries(sessionId: string, options?: unknown): unknown[];
  spineGetSession(sessionId: string): unknown;
  spineCreateSession(init?: unknown): unknown;
  spineListSessions(filter?: unknown): unknown[];
  spineBuildContext(sessionId: string): unknown;
  spineGetCompactionCheckpoint(sessionId: string): unknown;

  // KV store (async on DO side)
  spineKvGet(capabilityId: string, key: string): Promise<unknown>;
  spineKvPut(capabilityId: string, key: string, value: unknown, options?: unknown): Promise<void>;
  spineKvDelete(capabilityId: string, key: string): Promise<void>;
  spineKvList(capabilityId: string, prefix?: string): Promise<unknown[]>;

  // Scheduler
  spineScheduleCreate(schedule: unknown): Promise<unknown>;
  spineScheduleUpdate(scheduleId: string, patch: unknown): Promise<void>;
  spineScheduleDelete(scheduleId: string): Promise<void>;
  spineScheduleList(): Promise<unknown[]>;
  spineAlarmSet(timestamp: number): Promise<void>;

  // Transport (sync broadcast on DO side)
  spineBroadcast(sessionId: string, event: unknown): void;
  spineBroadcastGlobal(event: unknown): void;

  // Cost emission
  spineEmitCost(sessionId: string, costEvent: unknown): void;
}
