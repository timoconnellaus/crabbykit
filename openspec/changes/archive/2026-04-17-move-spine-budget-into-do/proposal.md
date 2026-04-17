## Why

Spine budget enforcement — the only per-turn DoS protection between a bundle and the host DO — is structurally unreliable under the current architecture.

`SpineService` is a `WorkerEntrypoint`. Its `BudgetTracker` is an instance field:

```ts
// packages/runtime/bundle-host/src/services/spine-service.ts
export class SpineService extends WorkerEntrypoint<SpineEnv> {
  private readonly budget: BudgetTracker;
  // ...
}
```

The tracker accumulates per-turn call counts keyed by the token's `nonce`. Every spine method calls `this.budget.check(nonce, category)` before executing, which increments the counter and throws `ERR_BUDGET_EXCEEDED` if the nonce's counter crosses the cap.

Cloudflare Workers' `WorkerEntrypoint` lifecycle does **not** guarantee instance persistence across service-binding RPC invocations. A single bundle turn makes many spine calls (each event broadcast, each entry append, each state read, each cost emit — often dozens per turn). Under CF's stateless worker model, these calls can land in freshly-constructed `SpineService` instances, each with an empty `BudgetTracker`. Under instance reuse (warm paths, same isolate), state persists; under instance recycling (cold starts, concurrent requests hashed to different instances, isolate lifecycle events), state is lost.

What this means in practice:

- **Budget enforcement is best-effort, not guaranteed.** A bundle issues 1000 spine operations when the per-turn cap is 100. If the instance is warm across all 1000 calls, the 101st correctly errors out. If the instance recycles even once — which can happen under load or after any CF-internal isolate event — the fresh instance sees a counter of zero and accepts more. The per-turn cap devolves into a "per-instance cap", which is effectively "per-lucky-clustering-of-calls cap".
- **The protection the cap was supposed to provide (bounded RPC fanout per turn, preventing a compromised or buggy bundle from issuing unlimited spine calls) is not actually delivered.** The defense exists in code but not in semantics.

This has been a latent issue since SpineService was introduced. It surfaced during the `switch-spine-bridge-to-direct-rpc` review when the question "where should budget state live" came up. That proposal deliberately did not touch the state location because the scope was already substantial and the latent bug deserves dedicated review. This proposal fixes it.

**The fix**: move `BudgetTracker` out of `SpineService` and into `AgentRuntime`. `AgentRuntime` lives inside an Agent Durable Object, which has guaranteed stable per-agent state for the full duration of any in-flight turn. A DO does not recycle mid-turn. In-memory state on `AgentRuntime` survives across all spine calls within a turn, and across all turns the DO serves for its lifetime. Budget enforcement becomes authoritative, not best-effort.

The change is narrow in scope and touches exactly two packages (`agent-runtime`, `bundle-host`). The security model at the bundle-facing boundary is unchanged. The capability token model, HKDF subkey scheme, signature verification, and TTL enforcement are untouched. Only the location of the per-turn accumulator moves.

This proposal does **not** move `NonceTracker` into the DO. SpineService's current production path does not use NonceTracker at all — nonce-based replay protection was intentionally disabled there because a single per-turn token carries the bundle through many spine RPCs and a single-use nonce would cap a turn at exactly one call. The in-code docstring on `SpineService.verify` explains this:

> Replay protection is intentionally NOT enforced here: a single per-turn token carries the bundle through many SpineService RPCs, and a single-use nonce would cap a turn at exactly one spine op. The budget tracker (keyed by nonce) caps total calls per turn; the token's `exp` (default 60s) bounds the reuse window; `globalOutbound: null` on the bundle isolate prevents token exfiltration.

Given that posture, the only state that needs to be reliable is the budget accumulator. `NonceTracker` remains where it is (exported from `bundle-token` as a general-purpose utility, used in tests and available for callers that want real nonce-keyed replay protection).

## What Changes

- **`BudgetTracker` moves from `SpineService` to `AgentRuntime`.** The existing class (`packages/runtime/bundle-host/src/budget-tracker.ts`) stays in its current file for now — its implementation does not change. What changes is where the instance lives: `AgentRuntime<TEnv>` grows a private `spineBudget: BudgetTracker` field, constructed in the runtime's constructor alongside the other per-agent state (`sessionAgents`, `capabilitiesCache`, etc.).
- **`BudgetTracker` remains importable from `bundle-host`** (for tests and for any future consumer that needs the class). The import path is unchanged; the instance lifetime changes. A separate discussion could move the class source file into `agent-runtime`, but that is a cosmetic relocation and is explicitly deferred — the class is small, its home in `bundle-host/src/budget-tracker.ts` was chosen when the tracker lived in SpineService, and nothing about this proposal needs to change its source location. If the class is later orphaned from `bundle-host`, it can be moved in a separate follow-up.
- **`SpineHost` method signatures gain a trusted caller context.** Every spine method currently takes `(sessionId, ...args)` as parameters, with the caller (SpineService) having already verified the token and extracted the sessionId. In the new model, the caller also passes the nonce (for budget accounting) as part of a typed `SpineCaller` context object:
  ```ts
  export interface SpineCaller {
    /** Verified agent id. */
    aid: string;
    /** Verified session id (may be empty for agent-scoped methods like createSession / listSessions). */
    sid: string;
    /** Verified nonce from the token payload; used by the budget tracker. */
    nonce: string;
  }
  
  export interface SpineHost extends Rpc.DurableObjectBranded {
    spineAppendEntry(caller: SpineCaller, entry: unknown): Promise<SessionEntry>;
    spineGetEntries(caller: SpineCaller, options?: unknown): Promise<SessionEntry[]>;
    // ... every spine method gains the SpineCaller first arg
  }
  ```
- **`AgentRuntime.spine*` methods check the budget internally.** Each method begins with `this.spineBudget.check(caller.nonce, category)` before executing. If the check throws, the method throws the same `SpineError` (`ERR_BUDGET_EXCEEDED`) it would have thrown inside SpineService previously. Control flow is identical; only the location shifted.
- **Budget category per method is declared at the method call-site.** `spineAppendEntry` passes `'sql'`, `spineKvGet` passes `'kv'`, `spineScheduleCreate` passes `'alarm'`, `spineBroadcast` passes `'broadcast'`, etc. This matches the current per-method categories in SpineService. A utility helper on AgentRuntime centralizes the check:
  ```ts
  private async withSpineBudget<T>(
    caller: SpineCaller,
    category: SpineBudgetCategory,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.spineBudget.check(caller.nonce, category);
    return await fn();
  }
  ```
  Each spine method wraps its body with `withSpineBudget`. Forgetting the wrapper is a reviewable mistake that tests should catch.
- **`SpineService` methods simplify.** Each method still verifies the token (signature + TTL, stateless crypto — fine in a fresh instance) and extracts `{ aid, sid, nonce }`. It then forwards to the DO with a `SpineCaller` object instead of just `sid`:
  ```ts
  async appendEntry(token: string, entry: unknown): Promise<unknown> {
    const { aid, sid, nonce } = await this.verify(token);
    try {
      return await this.getHost(aid).spineAppendEntry({ aid, sid, nonce }, entry);
    } catch (err) {
      throw this.sanitize(err);
    }
  }
  ```
  The `this.budget.check(nonce, category)` line inside each SpineService method is deleted. The BudgetTracker field on SpineService is deleted. The SpineEnv type's `SPINE_BUDGET?: SpineBudgetConfig` binding migrates to the DO's env path (read by AgentRuntime at construction).
- **`SpineService` no longer holds a `BudgetTracker` instance.** The class becomes stateless with respect to per-turn accounting — its only remaining state is the HKDF subkey cache (for signature verification), which is pure crypto and does not need persistence.
- **`SpineBudgetConfig` and `SpineBudgetCategory` move (or re-export) into `agent-runtime`.** `AgentRuntime` needs to read the budget config at construction, so the config type needs to be reachable from the runtime's public API. The simplest path: re-export from `agent-runtime` (which already re-exports `SpineHost` from the previous proposal). The actual type definition can stay in `bundle-host/src/budget-tracker.ts` and be imported from there, since both `bundle-host` and `agent-runtime` are in the `runtime/` bucket and circular dependency doesn't apply (`bundle-host` depends on `agent-runtime`, not the other way around). Alternatively, move the type definition to `agent-runtime` and have `bundle-host` import it. Pick whichever minimizes import churn — probably leave the type in `bundle-host` and just import it into `agent-runtime` via a new `import type` edge.
- **Wrangler binding migration**: if the host worker declares a `SPINE_BUDGET` binding or similar, it moves from SpineService's consumer declaration to the AgentDO worker's env. In practice, both are the same worker (the host), so the binding already reaches both. No `wrangler.jsonc` changes are expected. Audit and confirm in Phase 1.
- **Tests updated**: the existing SpineService budget tests (in `bundle-host/src/__tests__/`) are rewritten to invoke the methods through a DO stub (with real per-agent AgentRuntime state) rather than constructing SpineService with a mock env. Equivalent scenarios — "budget exceeded at the configured cap, correct category, correct error shape" — are preserved. New scenarios are added to verify:
  - Multi-call accumulation: 100 calls against a cap of 100 all succeed; the 101st fails.
  - Instance-recycle simulation: the test harness simulates two SpineService instantiations during one turn (which under the old architecture would have reset the budget). Under the new architecture, the DO's state persists across the two SpineService instances and the cap is still enforced across the combined call count.
  - Per-nonce isolation: a second turn with a new nonce starts with a fresh budget. Turn A exhausting its cap does not affect turn B.
  - Per-agent isolation: an unrelated agent's DO has an independent budget; turn A exhausting agent X's cap does not affect agent Y.
- **The instance-recycle simulation test is the load-bearing one** — it's the test that would have caught the bug if it had existed under the old architecture. The test constructs the SpineService twice against the same DO, verifies that budget state accumulates in the DO across the two SpineService lifetimes. Under the old code, this test fails (or rather, it can't even be written because the state is per-SpineService). Under the new code, it passes.

## Capabilities

### Modified Capabilities

- **`agent-bundles`** — gains a new security invariant around budget enforcement authority, and a modified spine method signature shape. The public bundle-facing contract (`env.SPINE.methodName(token, args)` via service binding) does not change — bundle authors see exactly the same surface. What changes internally:
  - `SpineHost` methods take a `SpineCaller` context object as first argument instead of a bare `sessionId` string.
  - Budget enforcement state (the `BudgetTracker` instance) lives in `AgentRuntime` (per-agent, durable for the DO lifetime) rather than `SpineService` (per-WorkerEntrypoint-instance, not guaranteed across calls).
  - Budget enforcement is now authoritative: if a bundle's per-turn call count exceeds the configured category cap, the `(N+1)`-th call deterministically fails with `ERR_BUDGET_EXCEEDED` regardless of how SpineService instances are recycled across the turn.

### Added Capabilities

None.

### Removed Capabilities

None. `SpineService`'s private `BudgetTracker` field is removed, but its contribution (per-turn RPC budget enforcement) is preserved — relocated, not deleted.

## Impact

- **Modified packages**:
  - `packages/runtime/agent-runtime/` — gains a private `spineBudget: BudgetTracker` field on `AgentRuntime<TEnv>`, a private `withSpineBudget` helper, updates to every `spine*` method to run the budget check, updates to the `SpineHost` interface to accept `SpineCaller` as first argument, updates to AgentDO forwarders. Also gains a re-export of `SpineBudgetConfig` (if the type stays in `bundle-host`). The runtime's constructor reads the budget config from its env.
  - `packages/runtime/bundle-host/` — `SpineService` methods simplify to "verify token, forward caller context to DO, sanitize errors". The `budget: BudgetTracker` field is deleted. Every `this.budget.check(...)` line is deleted. The `SpineEnv.SPINE_BUDGET` binding is deleted. The SpineService constructor no longer instantiates a BudgetTracker.
- **Unchanged packages**:
  - `packages/runtime/bundle-token/` — unchanged. The `NonceTracker` class stays exported as a general-purpose utility. Token verification logic unchanged. HKDF subkey derivation unchanged.
  - `packages/runtime/bundle-sdk/` — unchanged. Bundle-side spine clients already speak the service-binding RPC shape to SpineService, and SpineService's external interface (methods named `appendEntry`, `kvGet`, etc., taking a token as first argument) is unchanged.
  - `packages/capabilities/tavily-web-search/` — unchanged. Tavily calls `env.SPINE.emitCost(token, event)` via service binding. The internal implementation of `SpineService.emitCost` changes, but its external shape does not.
  - `packages/runtime/bundle-registry/` — unchanged.
- **Test changes**:
  - `packages/runtime/bundle-host/src/__tests__/spine-service.test.ts` (and any other SpineService unit tests) — rewrite budget-exceeded scenarios to drive them through a real `AgentRuntime` / DO stub pair rather than mocking the BudgetTracker in-instance.
  - `packages/runtime/agent-runtime/test/integration/spine-host.test.ts` — add budget enforcement scenarios that exercise each category (sql, kv, alarm, broadcast) through the DO's direct method surface.
  - New scenario: **instance-recycle simulation**. The test harness constructs two independent SpineService instances against the same DO, routes the first N spine calls through instance A and the next N through instance B, confirms the budget cap is still honored across the combined call count. Load-bearing.
  - `packages/runtime/bundle-host/src/__tests__/budget-tracker.test.ts` — the class's unit tests stay as they are. BudgetTracker's implementation is unchanged; only its owner moves.
- **Wire-format changes at the spine bridge**: `SpineCaller` replaces `sessionId: string` as the first argument on every spine method. Structured-clone-safe (it's a plain object of strings). Tests need updating to match the new method call signature.
- **No wire-format changes at the bundle boundary**: bundle authors call `env.SPINE.appendEntry(token, entry)` — same as before. SpineService does the token verification and constructs the `SpineCaller`. Bundle SDK is unchanged.
- **No security regression**: the bundle still cannot forge identity (the token is still HMAC-signed with a host-side secret). SpineService still verifies the token signature before doing anything with it. The `SpineCaller` context is trusted because it is constructed exclusively from verified token payload fields inside SpineService — a compromised SpineService could in theory forge a caller context, but the trust model has always assumed SpineService is on the trusted-worker side of the isolate boundary. A compromised SpineService can also just call DO methods directly; the caller context is not a new attack surface.
- **Security improvement**: under the old model, a bundle whose spine calls happened to land on recycled SpineService instances could issue more calls than the cap allowed. Under the new model, the cap is deterministic. This is a strict improvement.
- **Interface change is load-bearing but small**: `SpineHost` gains a first-argument type. Every consumer that imports the interface (`bundle-host` SpineService, `agent-runtime` AgentRuntime, `agent-runtime` AgentDO forwarders, `agent-runtime/test/integration/spine-host.test.ts`) updates once. The compile-time `SpineHost` satisfaction assertion added in `switch-spine-bridge-to-direct-rpc` will break until every consumer is updated — this is a feature, not a bug, because it forces the migration to be atomic.
- **Out of scope**:
  - Moving `NonceTracker` into the DO. NonceTracker is not in the production spine path; SpineService deliberately does not use it for replay protection (see above). Adding real nonce-keyed replay protection to the spine path would be a distinct behavioral change with its own design questions (e.g., does a single token get to make N calls? does each call consume a fresh nonce? what's the session-level vs turn-level scope?). Out of scope; separate proposal if ever needed.
  - Moving `BudgetTracker` source file from `bundle-host` to `agent-runtime`. Cosmetic, deferrable. If the file ends up orphaned from its original package after this proposal lands, a trivial follow-up can relocate it.
  - Changing the budget category names, default caps, or enforcement semantics. The current categories (`sql`, `kv`, `alarm`, `broadcast`) and their caps are preserved byte-identically. Only the location of the accumulator changes.
  - Changing SpineService's signature verification logic, HKDF subkey derivation, or error sanitization. All preserved.
  - Changing the capability token payload format, TTL, mint process, or any cryptographic property.
  - Changing `LlmService` or `TavilyService` beyond the implicit effect that their `env.SPINE.emitCost(token, event)` calls now route through a slightly different SpineService that no longer tracks budget in-memory. The wire format from LlmService/Tavily's perspective is unchanged.
  - Auditing the WorkerEntrypoint instance lifecycle documentation for Cloudflare Workers. This proposal assumes the worst case (instances don't persist reliably) and fixes the architecture accordingly. If documentation confirms instances DO persist reliably under all conditions, this proposal is still a correctness improvement (fewer assumptions about platform guarantees, more explicit about where state lives).
- **Ordering**: this proposal should land after `switch-spine-bridge-to-direct-rpc` has settled. Both touch the same files (`spine-service.ts`, `agent-runtime.ts`, `spine-host.ts`) and sequencing avoids merge conflicts. Waiting for any other proposal is not required.
- **Risk profile**: low. The change is confined to two packages, the implementation is mechanical (move state location, change interface shape, update call sites), the tests are a direct extension of what already exists, and the security model is clarified rather than changed. The interface shape change is the widest-reaching part; TypeScript will surface every stale call site as a compile error, so coverage of update sites is complete by construction.
