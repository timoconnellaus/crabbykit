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
   * that do not bind to a specific session. `null` encodes a session-less
   * dispatch path (e.g. `/dispose`); session-scoped spine methods in
   * SpineService call `requireSession(caller)` and throw
   * `ERR_SESSION_REQUIRED` before the DO method is invoked, so DO-side
   * handlers never observe `null` for session-scoped methods — they may
   * still observe empty string for the agent-scoped methods above.
   */
  readonly sid: string | null;
  /**
   * Verified nonce (from token payload `nonce`). Used as the per-turn
   * budget accumulator key — every spine call made with the same nonce
   * counts against the same per-turn budget.
   */
  readonly nonce: string;
}

export interface SpineHost extends Rpc.DurableObjectBranded {
  // Session store
  //
  // Every method is async so the implementation can uniformly route its
  // body through `AgentRuntime.withSpineBudget(...)` — the budget check
  // happens atomically with the work, and the call pattern matches the
  // KV / scheduler methods which were already async. Methods whose
  // underlying subsystem is synchronous (SessionStore) simply resolve
  // with the sync result.
  spineAppendEntry(caller: SpineCaller, entry: unknown): Promise<unknown>;
  spineGetEntries(caller: SpineCaller, options?: unknown): Promise<unknown[]>;
  spineGetSession(caller: SpineCaller): Promise<unknown>;
  spineCreateSession(caller: SpineCaller, init?: unknown): Promise<unknown>;
  spineListSessions(caller: SpineCaller, filter?: unknown): Promise<unknown[]>;
  spineBuildContext(caller: SpineCaller): Promise<unknown>;
  spineGetCompactionCheckpoint(caller: SpineCaller): Promise<unknown>;

  // KV store
  spineKvGet(caller: SpineCaller, capabilityId: string, key: string): Promise<unknown>;
  spineKvPut(
    caller: SpineCaller,
    capabilityId: string,
    key: string,
    value: unknown,
    options?: unknown,
  ): Promise<void>;
  spineKvDelete(caller: SpineCaller, capabilityId: string, key: string): Promise<void>;
  spineKvList(caller: SpineCaller, capabilityId: string, prefix?: string): Promise<unknown[]>;

  // Scheduler
  spineScheduleCreate(caller: SpineCaller, schedule: unknown): Promise<unknown>;
  spineScheduleUpdate(caller: SpineCaller, scheduleId: string, patch: unknown): Promise<void>;
  spineScheduleDelete(caller: SpineCaller, scheduleId: string): Promise<void>;
  spineScheduleList(caller: SpineCaller): Promise<unknown[]>;
  spineAlarmSet(caller: SpineCaller, timestamp: number): Promise<void>;

  // Transport (broadcast)
  spineBroadcast(caller: SpineCaller, event: unknown): Promise<void>;
  spineBroadcastGlobal(caller: SpineCaller, event: unknown): Promise<void>;

  // Cost emission
  spineEmitCost(caller: SpineCaller, costEvent: unknown): Promise<void>;

  // Hook bridge — bundle-originated tool execution + inference events
  //
  // `spineRecordToolExecution` runs the host's `afterToolExecutionHooks`
  // chain against a bundle-originated tool event; observer-only, awaited so
  // per-turn ordering matches the static path.
  //
  // `spineProcessBeforeInference` threads the messages array through the
  // host's `beforeInferenceHooks` chain and returns the final (possibly
  // mutated) array. Bundle SDK MUST use the returned array as input to the
  // model call — see `openspec/changes/bundle-shape-2-rollout/design.md`
  // Decision 5.
  //
  // `spineProcessBeforeToolExecution` runs the host's
  // `beforeToolExecutionHooks` chain against a bundle-originated tool
  // event before the tool executes. Returns `{ block: true, reason }` if
  // any hook vetoed the execution (first blocker wins), otherwise
  // `undefined`. Bundle SDK MUST honor the block and skip tool execution.
  spineRecordToolExecution(caller: SpineCaller, event: unknown): Promise<void>;
  spineProcessBeforeInference(caller: SpineCaller, messages: unknown[]): Promise<unknown[]>;
  spineProcessBeforeToolExecution(caller: SpineCaller, event: unknown): Promise<unknown>;

  // Bundle inspection (Phase 1)
  //
  // `spineRecordBundlePromptSections` writes the bundle's per-turn
  // rendered `PromptSection[]` snapshot to a version-keyed cache
  // (`bundle:prompt-sections:<sessionId>:v=<bundleVersionId>`). Called
  // once per inference iteration from `runBundleTurn` so the inspection
  // panel can show what the model sees on the bundle path.
  //
  // `spineGetBundlePromptSections` reads the snapshot for the
  // requested version (defaulting to the host's active bundle version
  // when omitted). Returns `[]` for cold sessions or stale-version
  // queries. Wrapped through the new `"inspection"` budget category
  // so heavy inspection traffic does not starve hot-path budgets.
  spineRecordBundlePromptSections(
    caller: SpineCaller,
    sessionId: string,
    sections: unknown[],
    bundleVersionId: string,
  ): Promise<void>;
  spineGetBundlePromptSections(
    caller: SpineCaller,
    sessionId: string,
    bundleVersionId?: string,
  ): Promise<unknown[]>;
}
