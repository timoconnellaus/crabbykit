## 1. Phase 1 — Preflight and audit

- [x] 1.1 Confirm `switch-spine-bridge-to-direct-rpc` has landed. `AgentRuntime.spine*` methods exist; `SpineService` calls `host.spineX(...)` directly; `handleSpineRequest` is gone; the compile-time `_assertSpineHost` helper is present.
- [x] 1.2 Run `bun run typecheck` — clean baseline. PASS.
- [x] 1.3 Run `bun run test` — capture baseline for bundle-related packages. Note pre-existing flakes (`plan-mode.test.ts` `readFileSync` issue, miniflare flakes in bundle-registry/cloudflare-sandbox/e2e). These are pre-existing and not attributed to this change later.
- [x] 1.4 Audit `wrangler.jsonc` and `wrangler.test.jsonc` files across the repo for any `SPINE_BUDGET` binding declaration. Current expectation: none exist (it's an optional field on the TypeScript type but unused in practice). If found, update plan accordingly so the binding follows AgentRuntime's new construction path.
- [x] 1.5 `grep -rn "new BudgetTracker" packages/` — list all instantiation sites. Expect: the SpineService constructor (to be removed) and budget-tracker.test.ts (test-only, stays). If other sites exist, investigate before Phase 2 proceeds.
- [x] 1.6 `grep -rn "BudgetTracker\|SpineBudgetConfig\|SpineBudgetCategory" packages/` — list all type references. Map the import graph so Phase 2's import updates are complete.
- [x] 1.7 `grep -rn "SpineCaller\|spineCaller" packages/` — should return zero. This is a new type introduced by this proposal.
- [x] 1.8 Read the current `SpineHost` interface declaration in `packages/runtime/agent-runtime/src/spine-host.ts`. Note every method and its current signature. The interface change in Phase 3 will modify every method's first parameter.

## 2. Phase 2 — Add `SpineCaller` type and introduce the `BudgetTracker` field on `AgentRuntime`

- [x] 2.1 Open `packages/runtime/agent-runtime/src/spine-host.ts`. Add the `SpineCaller` interface declaration at the top of the file (or in a dedicated `spine-caller.ts` if it's cleaner):
  ```ts
  /**
   * Trusted caller context passed to every `SpineHost` method.
   * Constructed by `SpineService` from a verified capability token payload
   * after signature and TTL checks pass. Consumers of `SpineHost` methods
   * trust this context because any holder of a `DurableObjectNamespace<AgentDO>`
   * binding is already privileged code.
   */
  export interface SpineCaller {
    /** Verified agent id (from token payload `aid`). */
    readonly aid: string;
    /** Verified session id (from token payload `sid`). May be empty for agent-scoped methods. */
    readonly sid: string;
    /** Verified nonce (from token payload `nonce`). Used as the budget accumulator key. */
    readonly nonce: string;
  }
  ```
- [x] 2.2 Export `SpineCaller` from `packages/runtime/agent-runtime/src/index.ts`.
- [x] 2.3 Import `BudgetTracker` and `SpineBudgetConfig` from `@crabbykit/bundle-host` into `packages/runtime/agent-runtime/src/agent-runtime.ts` as runtime imports (not type-only — `AgentRuntime` needs to construct an instance). If the dep-direction lint protests about `agent-runtime → bundle-host`, add a narrow exception in `scripts/check-package-deps.ts` documented as "BudgetTracker class used by spine budget enforcement — see openspec move-spine-budget-into-do", OR relocate the BudgetTracker source file (see note in design.md — prefer the exception for now, defer the relocation).
- [x] 2.4 Add a private field on `AgentRuntime<TEnv>`: `private readonly spineBudget: BudgetTracker;`
- [x] 2.5 In the `AgentRuntime` constructor, instantiate the tracker: `this.spineBudget = new BudgetTracker(options.spineBudget);` — accepting the budget config via the `AgentRuntimeOptions` (or equivalent construction type). Add `spineBudget?: SpineBudgetConfig` to that options type.
- [x] 2.6 Decide how the budget config reaches `AgentRuntime` construction. Two options:
  - (a) Pass through via `AgentDO` → `AgentRuntime` wiring. `AgentDO` reads `env.SPINE_BUDGET` (if present) and passes it to the runtime.
  - (b) `AgentRuntime` reads its own env. Inconsistent with the existing pattern where adapters are passed in.
  
  Recommend (a). Add the pass-through in `packages/runtime/agent-runtime/src/agent-do.ts` — `AgentDO` construction reads `this.env.SPINE_BUDGET` (optional) and forwards to `AgentRuntime`.
- [x] 2.7 Add a private helper method on `AgentRuntime`:
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
  Or a synchronous variant if all the spine methods it wraps are sync. The existing spine methods have a mix — SQL ops are sync on SessionStore, KV ops are async. The helper accepts a sync or async `fn` via `await`ing the result.
- [x] 2.8 Run `bun run typecheck` — PASS. At this point the type exists, the tracker field exists, the helper exists, but no method uses them yet.
- [x] 2.9 Commit: "feat(agent-runtime): introduce SpineCaller type and per-DO BudgetTracker field"

## 3. Phase 3 — Change `SpineHost` interface to use `SpineCaller`

- [x] 3.1 Open `packages/runtime/agent-runtime/src/spine-host.ts`. For every method on the `SpineHost` interface, change the first parameter from `sessionId: string` (or equivalent) to `caller: SpineCaller`. For methods that don't take a session id today (like `spineCreateSession`, `spineListSessions`, `spineBroadcastGlobal`), they still gain `caller` as the first argument — the caller carries the aid which those methods need for routing anyway, and the nonce which they need for budget accounting.
- [x] 3.2 Full method list (18 methods based on the current spine surface after `switch-spine-bridge-to-direct-rpc`):
  - `spineAppendEntry(caller, entry) → SessionEntry`
  - `spineGetEntries(caller, options?) → SessionEntry[]`
  - `spineGetSession(caller) → Session | null`
  - `spineCreateSession(caller, init?) → Session`
  - `spineListSessions(caller, filter?) → Session[]`
  - `spineBuildContext(caller) → ContextBuild`
  - `spineGetCompactionCheckpoint(caller) → CompactionCheckpoint | null`
  - `spineKvGet(caller, capabilityId, key) → Promise<unknown>`
  - `spineKvPut(caller, capabilityId, key, value) → Promise<void>`
  - `spineKvDelete(caller, capabilityId, key) → Promise<{ deleted: boolean }>`
  - `spineKvList(caller, capabilityId, prefix?) → Promise<Array<{key, value}>>`
  - `spineScheduleCreate(caller, schedule) → Promise<Schedule>`
  - `spineScheduleUpdate(caller, scheduleId, patch) → Promise<void>`
  - `spineScheduleDelete(caller, scheduleId) → Promise<void>`
  - `spineScheduleList(caller) → Promise<Schedule[]>`
  - `spineAlarmSet(caller, timestamp) → Promise<void>`
  - `spineBroadcast(caller, event) → void`
  - `spineBroadcastGlobal(caller, event) → void`
  - `spineEmitCost(caller, costEvent) → void`
- [x] 3.3 Adjust async/sync signatures to match the current `SpineHost`. Do not introduce Promise wrappers where the current method is synchronous.
- [x] 3.4 Run `bun run typecheck` — EXPECT FAILURES. Every consumer of `SpineHost` (SpineService, AgentRuntime method implementations, AgentDO forwarders, integration tests) will now break. The compile-time `_assertSpineHost` helper in `agent-do.ts` will also fail because the `AgentRuntime` methods still take `sessionId` as first arg. This is the atomic-migration property — you must fix all the call sites before the build goes green.
- [x] 3.5 Do NOT commit yet. Phase 3's interface change and Phase 4's implementation update are atomic — they land together in one commit.

## 4. Phase 4 — Update `AgentRuntime` spine methods and AgentDO forwarders to use `SpineCaller`

- [x] 4.1 For each `spine*` method on `AgentRuntime`:
  - Change the first parameter from `sessionId: string` (or equivalent) to `caller: SpineCaller`.
  - Inside the method body, replace references to `sessionId` with `caller.sid`.
  - Wrap the method body in `return this.withSpineBudget(caller, CATEGORY, async () => { ... });` where CATEGORY is `'sql'`, `'kv'`, `'alarm'`, or `'broadcast'` per the current SpineService category mapping.
  - For methods that are synchronous (e.g. `spineAppendEntry` returning a `SessionEntry` directly), adjust the wrapping to use a sync variant of the helper, or let the helper always be async — whichever is cleaner. If sync methods become async, their callers (AgentDO forwarders, tests) need to `await` them. Update accordingly.
- [x] 4.2 For each `spine*` forwarder on `AgentDO`:
  - Update the signature to accept `caller: SpineCaller` as first arg.
  - Delegate to `this.runtime.spineX(caller, ...)`.
- [x] 4.3 The 18-method update is mechanical but tedious. Do NOT skip any — the compile-time assertion will reject a partial migration.
- [x] 4.4 Run `bun run typecheck` for `packages/runtime/agent-runtime` — should PASS. If it fails on `_assertSpineHost`, confirm that every method on `AgentRuntime` matches the `SpineHost` interface exactly. If it fails on something else, fix the drift at the source.
- [x] 4.5 Commit: "refactor(agent-runtime): update spine methods to use SpineCaller context"

## 5. Phase 5 — Update `SpineService` to pass `SpineCaller` and remove budget tracking

- [x] 5.1 Open `packages/runtime/bundle-host/src/services/spine-service.ts`.
- [x] 5.2 Remove the `private readonly budget: BudgetTracker;` field and its constructor initialization.
- [x] 5.3 Remove the `SPINE_BUDGET?: SpineBudgetConfig` from `SpineEnv`.
- [x] 5.4 Remove the `BudgetTracker` import (and `SpineBudgetConfig` import if unused).
- [x] 5.5 In each spine method:
  - Keep `const { aid, sid, nonce } = await this.verify(token);` — signature verification stays.
  - Delete `this.budget.check(nonce, category);` — the DO handles it now.
  - Construct `const caller: SpineCaller = { aid, sid, nonce };`.
  - Call the DO with the caller context: `return await this.getHost(aid).spineX(caller, ...args);` (where `...args` is whatever the method passes today without the sid).
  - Keep the try/catch around the host call, keep `throw this.sanitize(err);`.
- [x] 5.6 Update the `SpineCaller` import: `import type { SpineCaller } from "@crabbykit/agent-runtime";`
- [x] 5.7 For methods that currently pass `sid` plus other args (e.g., `spineAppendEntry(sid, entry)`), the new call is `spineAppendEntry(caller, entry)` — `sid` is in `caller`, so it's no longer a separate positional arg.
- [x] 5.8 For methods that pass only `sid` (e.g., `spineBuildContext(sid)`), the new call is `spineBuildContext(caller)` — single argument.
- [x] 5.9 For methods that pass `capabilityId` and `key` (KV methods), the new calls are `spineKvGet(caller, capabilityId, key)` etc.
- [x] 5.10 Run `cd packages/runtime/bundle-host && bun run typecheck` — PASS. If not, the signature mismatch between SpineService's call site and AgentRuntime's method is the diagnostic — fix AgentRuntime to match.
- [x] 5.11 Run `cd packages/runtime/agent-runtime && bun run typecheck` — PASS.
- [x] 5.12 Run the repo-wide `bun run typecheck` — PASS. The `_assertSpineHost` helper in `agent-do.ts` should compile cleanly because every spine method now takes `SpineCaller` and the AgentDO forwarders have been updated to match.
- [x] 5.13 Commit: "refactor(bundle-host): pass SpineCaller to DO and remove in-service budget tracker"

## 6. Phase 6 — Update tests (SpineService unit tests, spine-host.test.ts integration, bundle-spine-bridge.test.ts)

- [x] 6.1 Open `packages/runtime/bundle-host/src/__tests__/*.test.ts`. Find tests that:
  - Instantiate SpineService directly and invoke methods on it (unchanged test approach)
  - Assert on budget-exceeded error shapes
  - Assert on SpineEnv shape (specifically the removed `SPINE_BUDGET` field)
  Update each to the new surface.
- [x] 6.2 Open `packages/runtime/agent-runtime/test/integration/spine-host.test.ts`. Every test that calls `stub.spineX(sessionId, ...)` changes to `stub.spineX(caller, ...)` where `caller = { aid: agentId, sid: sessionId, nonce: "test-nonce" }` (or uses a helper that constructs a synthetic caller context).
- [x] 6.3 Add helper to the integration test file:
  ```ts
  function makeCaller(overrides: Partial<SpineCaller> = {}): SpineCaller {
    return {
      aid: "test-agent",
      sid: "test-session",
      nonce: crypto.randomUUID(),
      ...overrides,
    };
  }
  ```
- [x] 6.4 Add new budget-enforcement test scenarios to `spine-host.test.ts`:
  - **Cap enforcement within one nonce**: 100 `spineAppendEntry` calls with the same nonce succeed; the 101st throws `ERR_BUDGET_EXCEEDED`.
  - **Per-nonce isolation**: two distinct nonces each get their own 100-call budget; exhausting nonce A's budget does not affect nonce B.
  - **Per-category accounting**: 100 sql calls and 100 kv calls on the same nonce are tracked independently and both caps apply; exhausting sql does not affect kv.
  - **Per-agent isolation**: two distinct DO stubs (different agent ids) each have their own BudgetTracker. Exhausting agent X's budget does not affect agent Y. Proves the tracker is DO-scoped.
- [x] 6.5 Open `packages/runtime/agent-runtime/test/integration/bundle-spine-bridge.test.ts`. Update for the `SpineCaller` signature change on all call sites.
- [x] 6.6 Add the **instance-recycle simulation test** to `bundle-spine-bridge.test.ts` or a new dedicated test file. This is the load-bearing test for this proposal. Shape:
  ```ts
  test("budget persists across SpineService instance recycles", async () => {
    const env = /* test env */;
    const token = await mintTokenFor(agentId, sessionId, { nonce });
    
    // First SpineService instance — issue 50 calls
    const service1 = new SpineService(/* ctx */, env);
    for (let i = 0; i < 50; i++) {
      await service1.appendEntry(token, { type: "user", data: {} });
    }
    
    // Simulate instance recycle — fresh SpineService, same env and DO
    const service2 = new SpineService(/* ctx */, env);
    for (let i = 0; i < 50; i++) {
      await service2.appendEntry(token, { type: "user", data: {} });
    }
    
    // 101st call in total should fail — budget state lives in the DO,
    // not in the SpineService instance
    await expect(service2.appendEntry(token, { type: "user", data: {} }))
      .rejects.toThrow(/ERR_BUDGET_EXCEEDED/);
  });
  ```
  Under the OLD code, this test fails (each SpineService has its own tracker, the 101st call succeeds on the second instance's fresh tracker). Under the NEW code, the DO has the tracker, state accumulates, the test passes.
- [x] 6.7 Run `cd packages/runtime/bundle-host && bun test` — PASS.
- [x] 6.8 Run `cd packages/runtime/agent-runtime && bun test test/integration/spine-host.test.ts` — PASS.
- [x] 6.9 Run `cd packages/runtime/agent-runtime && bun test test/integration/bundle-spine-bridge.test.ts` — PASS. The instance-recycle test is the critical check.
- [x] 6.10 Commit: "test: verify spine budget persistence across SpineService instance lifetimes"

## 7. Phase 7 — Documentation and lint

- [x] 7.1 Update `CLAUDE.md` — the "Bundle brain override" section mentions SpineService's per-turn budget. Update to clarify that budget state lives in `AgentRuntime` (the DO), not in the `SpineService` instance, and that the `SpineCaller` context carries verified identity across the service → DO boundary.
- [x] 7.2 Update the in-code docstring on `SpineService.verify` — the old docstring mentioned BudgetTracker as the in-service enforcement mechanism. Clarify that budget tracking has moved to the DO and SpineService is now a stateless verify-and-forward service.
- [x] 7.3 Update the in-code docstring on `AgentRuntime.spine*` methods' `withSpineBudget` helper, explaining the trust model (the caller context is trusted because only privileged code holds the DO namespace binding).
- [x] 7.4 Update the in-code comment block on the `_assertSpineHost` helper in `agent-do.ts` — no functional change, but the interface it asserts against has grown `SpineCaller` arguments; confirm the comment still reads correctly.
- [x] 7.5 Run `bun run lint` — compare error count to the spine-bridge proposal's baseline (41 errors / 427 warnings). Should be equal. Zero new errors introduced.
- [x] 7.6 Commit: "docs: update bundle system docs for per-DO spine budget enforcement"

## 8. Phase 8 — Final verification

- [x] 8.1 Clean install: `rm -rf node_modules packages/*/*/node_modules && bun install`.
- [x] 8.2 `bun run typecheck` — PASS across all 41 packages.
- [x] 8.3 `bun run lint` — PASS (error count ≤ baseline).
- [x] 8.4 `bun run test` — PASS on bundle-related packages: `bundle-token`, `bundle-sdk`, `bundle-host`, `agent-runtime` (especially the new budget-enforcement scenarios), `agent-workshop`. Pre-existing miniflare flakes unchanged.
- [x] 8.5 Grep confirmation: `grep -rn "this.budget" packages/runtime/bundle-host/src/` — expect zero hits. SpineService no longer has a budget field.
- [x] 8.6 Grep confirmation: `grep -rn "new BudgetTracker" packages/` — expect hits in exactly two places: `AgentRuntime` constructor and `budget-tracker.test.ts`. No SpineService instantiation.
- [x] 8.7 Grep confirmation: `grep -rn "SpineCaller" packages/` — expect hits across `agent-runtime/src/spine-host.ts`, `agent-runtime/src/agent-runtime.ts`, `agent-runtime/src/agent-do.ts`, `agent-runtime/src/index.ts`, `bundle-host/src/services/spine-service.ts`, and the test files. No stragglers.
- [x] 8.8 Spot-check: open `spine-service.ts`, confirm each method constructs `const caller: SpineCaller = { aid, sid, nonce };` and passes it through.
- [x] 8.9 Spot-check: open `agent-runtime.ts`, confirm each `spine*` method wraps its body with `withSpineBudget(caller, category, () => ...)`.
- [x] 8.10 Spot-check: the compile-time `_assertSpineHost` helper in `agent-do.ts` still compiles cleanly, proving `AgentRuntime` / `AgentDO` structurally satisfies the updated `SpineHost`.
- [x] 8.11 Manual smoke test (if a bundle-enabled example exists): run a turn that makes several spine calls, confirm no regressions. Optionally attempt to exceed the budget by instrumenting the test bundle to issue >cap calls in a loop — confirm the cap fires.
- [x] 8.12 If an instance-recycle integration test passed in Phase 6, the load-bearing verification is already done; Phase 8 is just sanity.
