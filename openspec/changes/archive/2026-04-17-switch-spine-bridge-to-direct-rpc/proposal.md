## Why

SpineService currently bridges bundle RPC calls back to the host `AgentDO` via HTTP-style routing. For every spine method (`appendEntry`, `kvGet`, `broadcast`, `emitCost`, etc.), SpineService constructs a `Request` with a path like `https://internal/spine/appendEntry`, calls `host.fetch(request)` on the DurableObjectStub, and the DO routes the path through a large `handleSpineRequest` switch statement. The switch parses the JSON body, calls the underlying sessionStore / transport / kvStore method, serializes the result back to JSON, and returns a `Response`.

This design is a workaround that outlived its reason. It was the right call when SpineService was written — DO-to-DO RPC via method calls had rough edges, and the HTTP route was the most reliable escape hatch. It is no longer the right call, and it carries four concrete costs that are visible in the codebase today:

1. **The `SpineHost` interface cannot be structurally satisfied by `AgentDO`.** In the `split-agent-bundle-host-and-sdk` proposal just landed (Phase 5), the task list asked for a compile-time type-level assertion: `const _check: SpineHost = new AgentDO(...)`. The subagent implementing it discovered this assertion does not compile, because `AgentDO` implements the *routes* (`handleSpineRequest` switch cases), not the *methods* (`spineAppendEntry`, `spineKvGet`, etc.). The interface is unenforced at compile time. Any drift between `SpineHost` and `handleSpineRequest` goes undetected until a bundle actually exercises the drifting call path at runtime. A migration followed by a typo in a route string produces no compile error and no test failure — just a 404 at runtime on the specific call.

2. **Seven `SpineHost` methods currently return `501 Not Implemented`.** `spineGetCompactionCheckpoint`, `spineScheduleCreate`, `spineScheduleUpdate`, `spineScheduleDelete`, `spineScheduleList`, `spineAlarmSet`, and a couple of others are declared on the SpineService WorkerEntrypoint, declared on the `SpineHost` interface, forwarded by SpineService to the DO via `host.fetch`, and then refused by `handleSpineRequest` with a `501` response. A bundle calling these methods today gets a runtime error. This is a silent feature gap that the interface width hides. A structurally-satisfied interface would have made this impossible — the DO could not omit a method that `SpineHost` requires.

3. **Per-turn cost is non-trivial.** Every spine call today pays: `JSON.stringify` of args → `new Request` allocation → URL parsing → `host.fetch` dispatch → route match in `handleSpineRequest` → `await request.json()` → method call → `JSON.stringify` of result → `new Response` allocation → `await res.json()` on the caller side. This overhead is paid on a per-spine-call basis, and a single bundle turn makes many spine calls (each event broadcast, each entry append, each state read, each cost emit). On the critical path, every turn.

4. **Error and type fidelity.** JSON round-trips lose type information. Dates become strings. `undefined` becomes absent. Stack traces disappear. Error classes become generic `Error`. The serialization is also a place where the wire shape of SessionEntry or event payloads can drift from the TypeScript types silently, because `JSON.parse` returns `unknown` and the consuming side re-narrows with `as` casts.

All four costs are fixable with one change: replace HTTP-style routing with direct method calls on the DurableObjectStub. Cloudflare Workers DO RPC supports public methods on DO classes; arguments and return values are passed via structured clone across the isolate boundary. This is the native mechanism. Adopting it lets us delete `handleSpineRequest` entirely, make `AgentDO` structurally satisfy `SpineHost`, implement the seven missing methods (because the interface now forces us to), and eliminate the per-call serialization overhead.

This proposal does **not** touch the outer boundary — the bundle isolate still calls SpineService via service-binding RPC, unchanged. Only the *inner* bridge — from SpineService to AgentDO — flips from HTTP routing to direct method calls. One internal mechanism, replaced in place.

## What Changes

- **Add public methods on `AgentRuntime` matching the `SpineHost` interface.** The methods `spineAppendEntry`, `spineGetEntries`, `spineGetSession`, `spineCreateSession`, `spineListSessions`, `spineBuildContext`, `spineGetCompactionCheckpoint`, `spineKvGet`, `spineKvPut`, `spineKvDelete`, `spineKvList`, `spineScheduleCreate`, `spineScheduleUpdate`, `spineScheduleDelete`, `spineScheduleList`, `spineAlarmSet`, `spineBroadcast`, `spineBroadcastGlobal`, and `spineEmitCost` become real methods on `AgentRuntime<TEnv>`. Each method contains the logic currently inside the corresponding `case "/spine/X"` branch in `handleSpineRequest` — no new logic, just extraction.
- **Implement the seven currently-501 methods for real.** `spineGetCompactionCheckpoint`, `spineScheduleCreate`, `spineScheduleUpdate`, `spineScheduleDelete`, `spineScheduleList`, `spineAlarmSet`, and any others currently returning `501 Not Implemented`. Each calls into the existing `sessionStore` / `scheduleStore` / `scheduler` / `compaction` subsystem the runtime already owns. These subsystems already have public APIs for this functionality — the spine methods are thin wrappers, not new logic.
- **`AgentDO<TEnv>` exposes the same methods publicly.** The standard AgentRuntime → AgentDO delegation pattern (via `createDelegatingRuntime`) forwards each method structurally. No new plumbing in `createDelegatingRuntime` — the delegating runtime wires any public method on the host, and the spine methods become public methods. `AgentDO` structurally satisfies `SpineHost` after this change.
- **Add a compile-time assertion that `AgentDO` satisfies `SpineHost`.** A module-level `const _spineHostCheck: SpineHost = {} as unknown as AgentDO<Env>` (or equivalent idiom — the exact form is flexible as long as it triggers a TypeScript error if `AgentDO` drifts away from the interface). Lives in `packages/runtime/agent-runtime/src/agent-do.ts` (or a dedicated `spine-host-check.ts` file if it's cleaner). If this line fails to compile, the build fails — drift is caught at the point of introduction, not at runtime.
- **`SpineService` methods become direct-call shims.** Each method in `packages/runtime/bundle-host/src/services/spine-service.ts` is rewritten from:
  ```ts
  async appendEntry(token: string, entry: unknown): Promise<unknown> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");
    try {
      const host = this.getHost(aid);
      const res = await host.fetch(
        new Request("https://internal/spine/appendEntry", {
          method: "POST",
          body: JSON.stringify({ sessionId: sid, entry }),
        }),
      );
      return res.json();
    } catch (err) {
      throw this.sanitize(err);
    }
  }
  ```
  to:
  ```ts
  async appendEntry(token: string, entry: unknown): Promise<unknown> {
    const { aid, sid, nonce } = await this.verify(token);
    this.budget.check(nonce, "sql");
    try {
      const host = this.getHost(aid);
      return await host.spineAppendEntry(sid, entry);
    } catch (err) {
      throw this.sanitize(err);
    }
  }
  ```
  The identity derivation from the verified token, the budget check, and the error sanitization all stay in place — those are load-bearing security invariants. Only the dispatch mechanism changes.
- **Delete `handleSpineRequest` from `AgentRuntime`.** The large switch statement in `packages/runtime/agent-runtime/src/agent-runtime.ts` goes away entirely. The fetch dispatcher in `AgentRuntime.fetch` no longer has a `if (url.pathname.startsWith("/spine/"))` branch — that routing tier is gone.
- **Delete the `/spine/*` route match in `AgentRuntime.fetch`.** Check the full fetch handler for any other conditional that depends on `/spine/*` paths and remove them.
- **Rewrite the direct-surface integration tests.** `packages/runtime/agent-runtime/test/integration/spine-host.test.ts` exists explicitly to exercise the DO's `/spine/*` HTTP routes directly (bypassing the service binding). It is the canonical test that would break when the routes disappear. Rewrite it to call the new direct methods on a DurableObjectStub — same test intent (verify AgentDO correctly implements each SpineHost method), new mechanism (method calls, not HTTP posts). The test becomes smaller and clearer because `postJson(stub, path, body)` helper disappears.
- **Update `bundle-spine-bridge.test.ts`.** The full bundle → SpineService → AgentDO integration test. The outer call (bundle → SpineService) is unchanged because it remains a service-binding RPC. The inner call (SpineService → AgentDO) is now a direct method call. Any fetch-based mock in this test gets replaced with the equivalent method stub.
- **LlmService and Tavily service cost-emission path is unaffected.** LlmService and TavilyService call `env.SPINE.emitCost(token, event)` — that's a service-binding RPC to SpineService, not to AgentDO. SpineService.emitCost internally calls AgentDO, and that internal call is what this proposal rewrites. From the LlmService / Tavily perspective, nothing changes — same method signature, same service binding, same behavior.
- **Budget tracker semantics stay identical.** The per-turn budget categories (`sql`, `kv`, `alarm`, `broadcast`) are checked inside SpineService *before* the host call. Moving from HTTP to method calls does not affect when or how the budget is enforced. Same code path, same decisions, same errors on exceeded budget.
- **Capability token verification stays identical.** SpineService still verifies the incoming token on every call, still derives `(agentId, sessionId, nonce)` from the verified payload, still rejects mismatched or expired or replayed tokens. The security boundary is unchanged — a bundle still cannot forge identity, still cannot bypass the token, still cannot pass `sessionId` as a caller-supplied argument. The HKDF subkey model, nonce tracker, and TTL enforcement are unchanged.
- **Error sanitization stays identical.** SpineService still wraps DO-originated errors in a sanitized `SpineError` before returning to the bundle. The only difference is that the error now originates as a thrown exception from a method call rather than an HTTP 500 response — the sanitizer already handles both cases (the current implementation has a `try { const res = await host.fetch(...); return res.json() } catch (err) { throw this.sanitize(err) }` pattern, and the catch already catches any error type).
- **Update `handleSpineRequest`-related unit tests in `bundle-host`.** Any test in `bundle-host/src/__tests__/` that asserts on the HTTP bridge behavior (e.g., that SpineService constructs a specific Request URL, or that a specific route is called) gets updated to assert on the method-call shape instead. These are typically mock-based tests — replace `mockFetch` with `mockHost.spineX.toHaveBeenCalledWith(...)`.

## Capabilities

### Modified Capabilities

- **`agent-bundles`** — the existing bundle-brain-override capability. The spine bridge mechanism (HTTP routing vs direct RPC) is an implementation detail of the SpineService → AgentDO hop. The public contract (bundle calls `env.SPINE.methodName(token, args)` via service binding) does not change. What changes is an internal spec requirement: the existing requirement "`AgentDO` SHALL structurally satisfy `SpineHost`" (currently aspirational and unenforced) becomes a compile-time guarantee enforced by a type-level assertion. Additionally, the spec gains a new requirement: seven currently-501 methods become real, and bundles calling them receive correct results instead of an error.

### Added Capabilities

None. This is a refinement of existing capabilities, not a new one.

### Removed Capabilities

None. No capability is removed. The `/spine/*` HTTP routes on the DO are removed, but they were a private implementation detail; no capability-level behavior is deleted.

## Impact

- **Modified packages**:
  - `packages/runtime/agent-runtime/` — gains ~19 new public methods on `AgentRuntime<TEnv>`, deletes `handleSpineRequest` and the `/spine/*` route match in `fetch`, adds the compile-time `SpineHost` satisfaction assertion. Seven previously-not-implemented methods (compaction checkpoint, schedule create/update/delete/list, alarmSet) become real.
  - `packages/runtime/bundle-host/` — every method in `src/services/spine-service.ts` is rewritten to call `host.spineX(...)` directly instead of `host.fetch(...)`. ~19 methods, each shrinking by ~5 lines. Token verification, budget check, error sanitization stay in place.
- **Unchanged packages**:
  - `packages/runtime/bundle-sdk/` — the bundle-side spine clients are completely unchanged. They still make service-binding RPC calls to SpineService. The wire format of those calls does not change.
  - `packages/runtime/bundle-token/` — unchanged. Token verification and HKDF subkey derivation are untouched.
  - `packages/capabilities/tavily-web-search/` — unchanged. Tavily still calls `env.SPINE.emitCost(token, event)` via service binding. The internal implementation of `SpineService.emitCost` changes, but its external shape does not.
- **Test changes**:
  - `packages/runtime/agent-runtime/test/integration/spine-host.test.ts` — rewritten to use direct method calls on a DO stub. Same scenarios, new invocation pattern. The `postJson(stub, path, body)` helper becomes obsolete and is deleted.
  - `packages/runtime/agent-runtime/test/integration/bundle-spine-bridge.test.ts` — the end-to-end test. Its outer layer (bundle → SpineService) stays; its inner layer (SpineService → DO) changes to method calls. Any mock that intercepts `host.fetch` for spine routes is replaced with a method mock.
  - `packages/runtime/bundle-host/src/__tests__/*` — unit tests for SpineService that assert on request construction are rewritten to assert on method call arguments.
  - New scenarios added for the seven previously-501 methods, verifying they now work end-to-end.
- **Type-safety win**: after this change, `AgentDO` structurally satisfies `SpineHost`. A future edit that removes or renames a spine method breaks the build immediately, at the point of the edit, with a clear TypeScript error. This is the first-class form of the drift protection that P2's aspirational assertion couldn't provide.
- **Performance win**: per-spine-call overhead drops from "JSON round-trip + Request/Response allocation + URL parsing + switch dispatch" to "structured-clone RPC dispatch + method call". The exact magnitude depends on workload and is not the primary motivation (the correctness and type-safety wins are), but it is non-zero and the change is on the per-turn critical path. A before-and-after benchmark on a representative turn is part of the verification.
- **Serialization semantics change**: DO RPC uses structured clone, not JSON. This means:
  - `Date` objects round-trip as `Date` (previously would have become ISO strings on the wire and had to be re-parsed).
  - `undefined` properties survive (previously stripped by `JSON.stringify`).
  - `Map` and `Set` round-trip natively.
  - `Uint8Array` and other binary data round-trip natively.
  - Functions, class instances, and non-serializable values fail the structured clone with a clear error.
  - No current spine method passes dates, maps, sets, or binary data in arguments or return values at the time of this writing. The change is functionally a no-op for the current schema, and a quality-of-life improvement if any spine method ever grows a non-string-round-trip-safe argument.
- **Error handling**: thrown exceptions from AgentRuntime methods propagate back to SpineService as real exceptions (with stack traces and error types) instead of serialized HTTP 500 responses. SpineService's error sanitizer still runs, still returns a sanitized `SpineError` to the bundle — but internally, logging and debugging benefit from real stack traces.
- **Out of scope**:
  - Modifying the LlmService → AgentDO path or the TavilyService → AgentDO path beyond the emitCost indirection through SpineService. LlmService and Tavily do not call AgentDO directly; they call SpineService. No change needed on their side.
  - Changing the bundle → SpineService boundary (outer RPC). That is already native service-binding RPC and works correctly.
  - Changing the bundle → LlmService or bundle → Tavily boundaries. Those are also service-binding RPC and unaffected.
  - Adding new spine methods beyond those already declared in `SpineHost`. The seven currently-501 methods get implementations because the interface demands them, but the interface itself is not widened.
  - Changing the capability token model, HKDF subkey scheme, budget tracker categories, or any security invariant. All preserved byte-identical.
  - Generalizing the direct-method-call pattern to a second service (no second SpineService-like exists today; if one is added later, it can follow this pattern from the start).
- **Approval gate**: this proposal can land at any point after `split-agent-bundle-host-and-sdk` is merged. It has no ordering dependency on other in-flight proposals. It does not block or unblock the shape-2 capability rollout, the A2A first-class promotion, or any other roadmap item.
- **Risk profile**: low. The change is internal to two packages. The test surface is comprehensive (integration tests exercise every spine method end-to-end). The security boundary is unchanged. The performance change is a strict win. The type-safety change converts a runtime failure mode into a compile-time error. The only non-trivial verification is the bench measurement, which is informational rather than gating.
