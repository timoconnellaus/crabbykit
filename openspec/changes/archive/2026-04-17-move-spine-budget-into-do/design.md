## The actual threat model

It is worth naming what the budget cap is protecting against, because the design decisions fall out of that directly.

The spine budget is **per-turn RPC fanout limiting**. A single bundle turn obtains one capability token, makes N service-binding calls to SpineService with that token, and each call forwards to the DO. The cap bounds N per category (`sql`, `kv`, `alarm`, `broadcast`). Without the cap, a bundle that misbehaves — by bug, by attacker compromise, by adversarial prompt — could issue thousands of spine calls in a tight loop during a single turn, consuming DO CPU, saturating SQLite writes, and blocking the session for legitimate work.

The cap is NOT:

- An authentication mechanism — the token handles that.
- A replay-protection mechanism — the token's TTL handles that, and `NonceTracker` is available if real replay is ever needed.
- A DOS prevention mechanism against unauthenticated attackers — Worker Loader's `globalOutbound: null` and the token model already prevent bundles from exfiltrating credentials; the DOS case is "the authenticated bundle itself goes rogue."
- A cross-turn accounting mechanism — cost tracking is separate, uses `CostEvent`, is persisted in the session log, and has its own aggregation.

It is specifically: "if a bundle tries to issue more than 100 kv operations in a single turn, stop it at 101."

## Why the current architecture fails at that job

Under CF Workers, a `WorkerEntrypoint` instance is lightly ephemeral. There is no public guarantee that instance fields persist across invocations — the platform may construct a fresh instance per RPC call, may reuse the instance across many RPC calls, may pool them across isolate lifecycle events, may shard them across concurrent requests. Real behavior in production is probably "mostly reused, but not always."

`SpineService.budget` is an instance field. Its `Map<nonce, counters>` accumulates across all calls that happen to hit the same instance. If the bundle's 100 spine calls all land in one SpineService instance, the cap is honored correctly. If they split across two instances (instance A serves the first 50, instance B serves the next 50), each instance sees a counter of ≤50 at most, and the cap of 100 is effectively a cap of 100-per-instance, or 200 total — and worse, split any way the platform decides, so the effective cap is unpredictable.

This is not hypothetical. CF's published guidance on `WorkerEntrypoint` explicitly treats instance reuse as an optimization, not a contract. Anything that depends on instance-local state for correctness is structurally fragile. The budget tracker is exactly that.

The fact that this hasn't caused visible failures in production is because the bundle brain override has been in testing with small workloads where the fanout limit hasn't been hit, and because the cap is set generously. Under real bundle workloads with real per-turn operation counts, the problem would surface as either flaky cap behavior (sometimes enforced, sometimes not) or apparent "silent DoS" (a bundle that can run twice as many operations as its cap claims it should).

## Why the DO is the right home

A Durable Object is strongly-consistent per-id state. Within the scope of one agent's DO:

- **One DO instance exists at a time.** If the DO is alive, there is exactly one process running its code; all concurrent requests to the DO are serialized through its single-threaded event loop. No recycling mid-turn unless the DO is explicitly evicted by storage pressure or lifecycle events, both of which are rare and detectable.
- **Instance lifetime spans many turns, not just one.** A DO once warmed up stays warm for minutes to hours, depending on traffic. Budget state across turns is naturally isolated by the per-turn nonce key — old entries evict via the tracker's internal TTL. Cross-turn accumulation is correct by construction.
- **The DO is already the authoritative owner of per-agent state.** Sessions, capability caches, session agents, pending async ops, rate limiters — all live on `AgentRuntime` as instance fields today, with the same implicit guarantee (DO-lifetime persistence). The budget tracker joins a bucket of state that already works this way. No new guarantees are being invented.
- **Every spine call already lands on the DO** (after this proposal's predecessor, `switch-spine-bridge-to-direct-rpc`, moved the bridge from HTTP routing to direct RPC method calls). The budget check is on the path anyway. Moving the accumulator from SpineService to AgentRuntime means the increment happens inside the method where the work is about to be done, instead of inside a WorkerEntrypoint that then forwards to the method. One code location, one increment, atomic with the work.

The trade-off: the DO is shared across all spine calls for one agent, which means the budget check is serialized through the DO's event loop just like everything else. This is not a bottleneck — the check is `O(1)` map lookup and increment. The DO already serializes all its other state accesses through the same event loop with no observable cost.

## The `SpineCaller` context type

The proposal changes `SpineHost` method signatures from `(sessionId, ...args)` to `(caller: SpineCaller, ...args)`. Why a structured arg instead of flat positional args?

Three reasons:

1. **Future-proofing for additional verified fields.** Today the verified token payload contains `{aid, sid, nonce, exp, iat}`. Tomorrow it might grow a `mode` field (for mode-aware bundle dispatch, a known v1.1 follow-up), or a `scope` field, or anything else. A structured `SpineCaller` lets the interface grow by adding optional fields without re-touching every method signature. Positional args force a new argument slot on every method for every new field, which is painful.

2. **Explicitness at the call site.** `host.spineAppendEntry({ aid, sid, nonce }, entry)` is clearer about what's being passed than `host.spineAppendEntry(sid, nonce, entry)` — readers see the typed object and can grep for it. With positional args, you have to match argument slots against a mental model of the interface.

3. **Atomicity guarantee.** A structured object is passed as a single reference (structured-cloned across the DO RPC boundary). Positional args are three separate serializations. The single-object form slightly reduces the risk that a caller constructs an inconsistent set of positional args (e.g., a nonce from one token and a sessionId from another). Every spine call either has a correct `SpineCaller` or doesn't.

The minor cost is verbosity — `host.spineAppendEntry({ aid, sid, nonce }, entry)` is longer than `host.spineAppendEntry(sid, entry)`. Worth it.

## Why `SpineCaller` is "trusted" when it reaches the DO

The DO does not re-verify the token that SpineService already verified. The `SpineCaller` context that reaches `AgentRuntime.spineAppendEntry` is taken on faith from whoever called the DO method.

Is that safe? Yes, under the existing trust model:

- **Only code that holds a `DurableObjectNamespace<AgentDO>` binding can call AgentDO methods.** That binding is a capability. It is held by the host worker's SpineService (intentionally). It is NOT held by bundles (structured-clone fails). It is NOT held by untrusted code in general.
- **The bundle is the only untrusted caller in the system.** Everything else running in the same worker deployment is trusted — it's code the deployer shipped. Trusted code with a DO namespace binding is the correct audience for DO method calls; the entire point of having a DO is that privilege is mediated by who holds the binding.
- **SpineService's only job in this trust chain is to gate untrusted (bundle) callers.** It does that by verifying the token. A successful verification produces a `SpineCaller` that reflects the identity encoded in the HMAC-signed payload. That identity is trustworthy because the signature was trustworthy.
- **If a different trusted caller (admin tool, debug endpoint, future tooling) wants to call AgentDO spine methods directly without going through SpineService, they construct their own `SpineCaller` with whatever identity they want.** That's fine because they're trusted; if they're lying, the bug is in the trusted caller, not in the DO. This is the same model as calling `sessionStore.appendEntry(sid, entry)` directly — nothing verifies the caller has any business with that sid.

The one edge case: a compromised SpineService could construct a false `SpineCaller` and call the DO with it. But a compromised SpineService can also just call `DO.fetch()` with arbitrary URLs, call any other DO method, or read any binding in its env. The threat model already treats SpineService as privileged — compromising it is a much bigger problem than a forged caller context. The `SpineCaller` argument is not a new attack surface.

## What stays in SpineService

Post-change, SpineService still does:

1. **Token verification** — signature, TTL, extract `{aid, sid, nonce}` from payload. Stateless crypto, works in any instance lifetime.
2. **HKDF subkey derivation** — cached in an instance-local promise, re-derives on fresh instance. Cheap.
3. **DO routing** — `this.getHost(aid)` returns a typed `DurableObjectStub<SpineHost>` and is the only place that holds the DO namespace binding for bundle-invoked calls.
4. **Error sanitization** — catches DO-side exceptions and returns sanitized `SpineError` to the bundle. Keeps stack traces and internal state off the wire.
5. **Structured clone of `SpineCaller` and args across the DO RPC boundary** — implicit in the method call.

What it stops doing:

- Budget tracking. Instance-local state for per-turn accounting is deleted.
- Nonce tracking. Already wasn't doing this in the production path (test-only).
- Any stateful accumulation of any kind. SpineService becomes provably stateless except for the HKDF subkey cache.

This is architecturally cleaner. A stateless verify-and-forward service is a simple thing; a verify-track-budget-forward service is a complex thing whose per-instance state has to be reasoned about.

## What stays in SpineService's env

The `SpineEnv` type currently declares:

```ts
export interface SpineEnv {
  AGENT_AUTH_KEY: string;      // master HMAC secret (for subkey derivation)
  AGENT: DurableObjectNamespace; // binding to reach the agent DO
  SPINE_BUDGET?: SpineBudgetConfig; // optional budget configuration
}
```

After this change:

```ts
export interface SpineEnv {
  AGENT_AUTH_KEY: string;      // master HMAC secret (still used for signature verification)
  AGENT: DurableObjectNamespace; // binding to reach the agent DO
  // SPINE_BUDGET removed — budget config moves to the DO's env / AgentRuntime construction
}
```

The `SPINE_BUDGET` optional binding moves to wherever `AgentRuntime` reads its construction config. In practice, since `SpineService` and `AgentDO` live in the same host worker, both read from the same `env` object — the name just moves from `SpineEnv` to an `AgentRuntime` config parameter. No `wrangler.jsonc` change is required because env bindings in wrangler are worker-scoped, not per-class-scoped.

## Where the `BudgetTracker` class lives

Currently: `packages/runtime/bundle-host/src/budget-tracker.ts`. Exported from `bundle-host/src/index.ts`.

After this change: the class stays at its current source location. Only its consumers change. `bundle-host` continues to export it (for backward compat with tests that instantiate it directly, and for anyone else who wants the class). `agent-runtime` imports the class type from `bundle-host` via an `import type` (or plain import if the runtime instantiates it).

Is this architecturally clean? Not perfect — the class now has zero runtime consumers inside `bundle-host` (SpineService no longer holds an instance) but is still exported from there. It's a pure "utility class that lives in the wrong package for historical reasons." The ideal move is to relocate the file to `agent-runtime/src/spine-budget-tracker.ts` and have `bundle-host` drop the export entirely.

I am **deferring that move** to keep this proposal's scope tight. Reasons:

- The file is ~80 lines. Relocating it is a mechanical `git mv` that touches ~3 imports. Cheap to do later.
- Keeping the file at its current location avoids expanding the diff with a rename that has no runtime effect.
- If nobody ends up importing `BudgetTracker` from `bundle-host` after this proposal lands, the next cleanup pass (or whoever is touching bundle-host next) can relocate it opportunistically.

If preferred, the relocation can be rolled into this proposal — say so during review and I'll expand the task list. Either ordering works.

## Dependency direction

`agent-runtime` currently does NOT import from `bundle-host`. The dep direction is one-way: `bundle-host → agent-runtime`. Adding `agent-runtime → bundle-host` for the `BudgetTracker` class type introduces a cross-edge.

Is that a circular dep? No, because the import is type-only. `import type { BudgetTracker } from "@crabbykit/bundle-host"` doesn't add a runtime dependency; TypeScript strips it at compile time. The dep-direction CI script (`scripts/check-package-deps.ts`) has a blanket exception for type-only imports (from P1) specifically to allow this pattern.

Alternative: move the `BudgetTracker` file to `agent-runtime` now (option discussed above). This makes the dep direction clean without needing the type-only exception. Slightly more churn, slightly cleaner graph.

Pick based on taste. Deferring feels right to me — the type-only exception exists for exactly this case.

## Test matrix changes

The budget enforcement tests need to prove that **instance-level state loss doesn't break the cap**. That requires simulating instance recycling. Two ways to do it:

### Way 1: Construct two SpineService instances against one DO

The test harness today instantiates `SpineService` via `new SpineService(ctx, env)` and calls methods on it directly. The new test does this twice with the same underlying DO stub and verifies state accumulates across the two instances:

```ts
const do = getAgentDO(env);
const service1 = new SpineService(ctx, env);
for (let i = 0; i < 50; i++) {
  await service1.appendEntry(token, { ... });
}
// Simulate instance recycle
const service2 = new SpineService(ctx, env);
for (let i = 0; i < 50; i++) {
  await service2.appendEntry(token, { ... });
}
// Next call should fail with ERR_BUDGET_EXCEEDED
await expect(service2.appendEntry(token, { ... })).rejects.toThrow("ERR_BUDGET_EXCEEDED");
```

Under the old code, this test fails because each SpineService has its own BudgetTracker — instance 2 sees 0 calls used, happily accepts 50 more, and the 51st passes instead of failing. Under the new code, the budget state lives in the DO and accumulates across both service instances correctly.

This is the test that would have caught the bug. It should exist.

### Way 2: Drive the DO's method surface directly

An alternative: skip SpineService entirely in the test, call `stub.spineAppendEntry(caller, entry)` 101 times with a cap of 100, verify the 101st throws. This tests the DO's budget enforcement but doesn't prove the end-to-end path with SpineService is correct. Useful but not sufficient on its own.

**Recommendation: both**. Way 2 for the unit-level budget tracker test; Way 1 for the integration-level "the whole system enforces caps across instance lifecycles" test.

## Risks and how to mitigate

1. **The interface change is wide.** `SpineHost` method signatures change for every method. Every consumer has to update. Mitigation: TypeScript catches every stale call site at compile time. The compile-time `SpineHost` satisfaction assertion added in `switch-spine-bridge-to-direct-rpc` forces the migration to be atomic — partial updates fail the build. You cannot land this proposal half-done.

2. **Test flakes masking real regressions.** The miniflare test environment has known flakes (documented in P1/P2/spine bridge reports). When the spine tests are rewritten, some pre-existing flakes might attach to the new test shape and be misattributed. Mitigation: run each test category in isolation and compare fail counts against the spine-bridge baseline; new failures get investigated individually.

3. **Someone else adds a `SPINE_BUDGET` wrangler binding while this proposal is in flight.** The binding is currently optional and unused in `wrangler.jsonc` files I can see, but a parallel change might add it. Mitigation: audit in Phase 1 and flag.

4. **Downstream consumers of `BudgetTracker` (tests, other services) get surprised that SpineService no longer instantiates one.** Low risk — the class is exported as a utility and can still be instantiated by anyone who wants it. Mitigation: grep for `new BudgetTracker` to find all instantiation sites and verify they're either tests or (post-change) the `AgentRuntime` constructor.

5. **`BudgetTracker` class doesn't survive structured clone.** Doesn't matter — the tracker is never sent across an RPC boundary. It lives entirely inside the DO process, constructed once in the `AgentRuntime` constructor and held as a private field. Structured clone never comes up.

## What this proposal does NOT do

- Does not change how `CostEvent` is emitted or tracked. `spineEmitCost` still routes through to `AgentRuntime.handleCostEvent` as it does today. The cost accounting system is separate from the budget tracker and this proposal doesn't touch it.
- Does not change budget defaults or caps. The `BudgetTracker` constructor's default config stays the same.
- Does not add persistent budget state. The tracker remains in-memory on the runtime. Turn state does not need to survive DO restarts (a DO restart mid-turn already aborts the turn).
- Does not audit or fix anything about `NonceTracker`. Out of scope.
- Does not touch `LlmService` or `TavilyService`. Their `env.SPINE.emitCost(...)` calls still work, still go through SpineService, still end up at the DO. The internal budget accounting change is invisible to them.
- Does not add real nonce-keyed replay protection to the spine path. That's a separate design question with its own trade-offs.

## When this should land

Any time after `switch-spine-bridge-to-direct-rpc` has settled. It's not urgent in the "imminent incident" sense — budget caps are generous and real bundle workloads haven't stressed them in testing. It IS urgent in the "latent bug that should be fixed before real production traffic" sense — the current architecture provides a false guarantee and real production traffic will eventually land on instance-split call patterns that expose it.

Recommended ordering: land it in the current wave of bundle-system refinements while the architecture is fresh in memory. Deferring indefinitely is fine but compounds the "code that's structurally wrong but hasn't caused a visible failure yet" debt.
