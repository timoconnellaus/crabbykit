## Where the boundary actually lives

There are three isolate/process boundaries in a bundle-enabled turn, and it is worth naming them before changing any of them, because the proposal's scope is precisely one of the three and people (including future me) will conflate them.

```
  ┌───────────────────────────────────┐
  │  Bundle isolate (Worker Loader)   │
  │                                   │
  │  defineBundleAgent → BundleContext│
  │  BundleSessionStoreClient         │
  │  BundleKvStoreClient              │
  │  BundleSchedulerClient            │
  │  BundleSessionChannel             │
  │                                   │
  │  env.SPINE = Service<SpineService>│  ◀── Service binding RPC
  │  env.LLM   = Service<LlmService>  │      (structured clone, cross-isolate)
  │  env.TAVILY= Service<TavilyService>│
  └──────────────┬────────────────────┘
                 │
                 │  (1) Bundle → Service
                 │      Native WorkerEntrypoint RPC.
                 │      Already method-call based. Not touched.
                 │
  ┌──────────────▼────────────────────┐
  │  Host worker                      │
  │                                   │
  │  SpineService (WorkerEntrypoint)  │
  │  LlmService   (WorkerEntrypoint)  │
  │  TavilyService(WorkerEntrypoint)  │
  │                                   │
  │  Each service holds:              │
  │    - HKDF subkey (own label)      │
  │    - NonceTracker                 │
  │    - BudgetTracker (SpineService) │
  │    - provider creds (LLM, Tavily) │
  │                                   │
  │  env.AGENT = DurableObjectNamespace│  ◀── HTTP bridge via host.fetch(Request)
  │                                   │      (TODAY — this is what we're changing)
  └──────────────┬────────────────────┘
                 │
                 │  (2) Service → AgentDO
                 │      TODAY: host.fetch(Request → /spine/appendEntry)
                 │      AFTER: host.spineAppendEntry(sid, entry)
                 │
  ┌──────────────▼────────────────────┐
  │  Agent Durable Object             │
  │                                   │
  │  AgentDO (extends DurableObject)  │
  │  ↓ createDelegatingRuntime         │
  │  AgentRuntime<TEnv>               │
  │    sessionStore (sync SQLite)     │
  │    transport                      │
  │    scheduler                      │
  │    kvStore                        │
  │    compaction                     │
  │                                   │
  │  TODAY: fetch() → handleSpineRequest│
  │         switch over /spine/* paths│
  │  AFTER: public method surface     │
  │         matching SpineHost 1:1    │
  └───────────────────────────────────┘

                 (3) Intra-runtime: AgentDO → AgentRuntime
                     Already direct method calls via delegating runtime.
                     Not touched.
```

This proposal changes **only boundary (2)**. Boundaries (1) and (3) are already correct and idiomatic. Conflating them — for instance, asking "should we also change how the bundle calls SpineService?" — is a different question with a different answer (no, because (1) is already native service-binding RPC).

## Why this wasn't done originally

The `add-bundle-brain-override` proposal that introduced SpineService was written under uncertainty about DO RPC method-call support. The proposal explicitly noted that DO-to-DO method calls "have rough edges" at the time. The HTTP route was chosen because a `fetch` handler on a DO is a stable, known-working surface — it's how fetch-based HTTP to a DO has worked since DOs launched. Method-call RPC on DO stubs existed but was less battle-tested.

Today, DO method-call RPC is well-established, documented, used in public Cloudflare examples, and supported across wrangler and production. The conservatism that picked HTTP routing in the first proposal is no longer warranted. This is a straightforward "adopt the native mechanism now that it's trusted" change.

## What compile-time `SpineHost` satisfaction buys

The `split-agent-bundle-host-and-sdk` proposal's Phase 5 had a task to add this assertion:

```ts
const _spineHostCheck: (x: AgentDO<any>) => SpineHost = (x) => x;
```

The implementing subagent reported:

> Phase 5 type-level assertion (task 5.5) — the proposed `const _spineHostCheck` cannot compile because `AgentDO` does NOT structurally implement the SpineHost method surface. The spine bridge uses HTTP routes on the DO stub rather than direct method calls.

That agent was correct — and it is the smell this proposal resolves. The aspirational assertion in P2 was aspirational because the current architecture made it impossible. With this change, the assertion compiles, and the `SpineHost` interface becomes load-bearing rather than documentation.

Concrete failure mode that the assertion catches, post-change:

1. A developer adds a new spine method, `spineGetMode`, to the `SpineHost` interface.
2. They implement it in `SpineService` (easy to remember because the bundle needs it).
3. They forget to implement it on `AgentRuntime`.
4. Before this change: nothing breaks at compile time. The bundle calls `env.SPINE.getMode(token)` → SpineService forwards to `host.fetch("/spine/getMode")` → AgentDO's `handleSpineRequest` hits the `default` case → returns 404 → SpineService throws a sanitized error → bundle sees `ERR_INTERNAL` at runtime.
5. After this change: the TypeScript compiler sees that `AgentDO` does not have a public `spineGetMode` method. `const _check: SpineHost = agentDO` fails to compile. The build breaks. The developer fixes it before committing. No runtime failure.

This is the type-safety argument in one paragraph. Other failure modes (method renames, signature changes, return-type drift) map to the same pattern.

## The seven orphaned methods

Current state: `SpineHost` declares 20+ methods. `SpineService` implements 19 of them (forwarding to `host.fetch`). `handleSpineRequest` in `AgentRuntime` handles ~12 of them with real logic; the remaining ~7 return `501 Not Implemented`. A bundle calling any of the 7 gets a runtime error — silent in the sense that the interface width suggests the method exists and will work.

The seven (based on the current fallthrough block in `handleSpineRequest`):

```ts
case "/spine/getCompactionCheckpoint":
case "/spine/scheduleCreate":
case "/spine/scheduleUpdate":
case "/spine/scheduleDelete":
case "/spine/scheduleList":
case "/spine/alarmSet":
  return notImplemented(pathname);
```

Plus whatever else isn't in the handled set.

Post-change, the compile-time check forces these methods to exist on `AgentRuntime` or the build fails. The proposal therefore includes implementing them for real, not just stubbing. The implementations are straightforward:

- **`spineGetCompactionCheckpoint(sessionId)`** → `this.sessionStore.getCompactionCheckpoint(sessionId)` — the session store already exposes this for the static runtime's own compaction walker. The spine method is a thin wrapper.
- **`spineScheduleCreate(schedule)`** → `await this.scheduleStore.create(schedule)` — same.
- **`spineScheduleUpdate(scheduleId, patch)`** → `await this.scheduleStore.update(scheduleId, patch)`.
- **`spineScheduleDelete(scheduleId)`** → `await this.scheduleStore.delete(scheduleId)`.
- **`spineScheduleList()`** → `await this.scheduleStore.list()`.
- **`spineAlarmSet(timestamp)`** → `await this.scheduler.setAlarm(timestamp)` — the scheduler adapter already has this method because static agents use it.

These are not new features. They are pass-throughs to subsystems that already exist and already work for static agents. Bundles were unable to use scheduling or compaction because the bridge forgot to wire them up. The proposal wires them up. It is not a scope expansion — it is closing a known gap that the current architecture hides.

## The method naming convention

One ergonomic question worth settling: should `AgentRuntime`'s new public methods be called `spineAppendEntry` (match `SpineHost`), or should `SpineHost`'s methods be renamed to `appendEntry` (match the underlying sessionStore method)?

Two options:

**Option A — prefix everything with `spine`**
```ts
interface SpineHost {
  spineAppendEntry(sessionId: string, entry: unknown): unknown;
  spineGetEntries(sessionId: string, options?: unknown): unknown[];
  // ...
}

class AgentRuntime<TEnv> {
  spineAppendEntry(sessionId: string, entry: unknown): unknown { /* ... */ }
  // ...
}
```

**Option B — drop the prefix**
```ts
interface SpineHost {
  appendEntry(sessionId: string, entry: unknown): unknown;
  getEntries(sessionId: string, options?: unknown): unknown[];
  // ...
}

class AgentRuntime<TEnv> {
  // Already has sessionStore.appendEntry, sessionStore.getEntries, etc.
  // SpineHost methods would shadow or conflict with these semantics.
}
```

**Decision: Option A, keep the `spine` prefix.** Reasoning:

1. The methods are the spine-bridge surface specifically. They exist for this one job. Naming them after that job keeps the intent legible.
2. `AgentRuntime` already has `appendEntry`-shaped methods via its subsystems (`this.sessionStore.appendEntry`, etc.). Adding a bare `appendEntry` on the runtime itself invites confusion — "which one is the right one to call from a capability vs from a test vs from the spine?"
3. Grep-ability: `grep -r "spineAppendEntry"` finds every spine-surface call site; `grep -r "appendEntry"` would find every usage of the underlying store too.
4. The `SpineHost` interface already uses the prefix today. Renaming it would be a larger churn for no benefit.

The one mild cost: a bundle calling `env.SPINE.appendEntry(token, entry)` (bundle-facing name, no prefix) flows through `SpineService.appendEntry` → `host.spineAppendEntry(sid, entry)` (AgentRuntime-facing name, with prefix). The asymmetry is fine — it reflects the different audiences. The bundle sees a capability API; the host sees a spine bridge surface.

## Test strategy

Three tiers of test coverage exist today and all need attention:

1. **Unit tests for SpineService** (in `bundle-host/src/__tests__/`). Today: they mock `host.fetch` and assert on Request URL + body. After: they mock the DO stub's methods and assert on method arguments. This is a mechanical rewrite — `expect(mockFetch).toHaveBeenCalledWith(requestMatching(url, body))` becomes `expect(mockHost.spineAppendEntry).toHaveBeenCalledWith(sid, entry)`. Arguably clearer.

2. **Direct DO surface integration tests** (`spine-host.test.ts`). Today: `postJson(stub, "/spine/appendEntry", { sessionId, entry })`. After: `await stub.spineAppendEntry(sessionId, entry)`. The `postJson` helper becomes obsolete. The test file shrinks.

3. **End-to-end bundle integration** (`bundle-spine-bridge.test.ts`). Today: exercises bundle → SpineService → DO via both the service binding and the HTTP bridge. After: same outer flow, different inner mechanism. The test should be nearly unchanged at the outer boundary — a bundle fetches `/turn`, SpineService receives calls, events flow back. Internally the fetch-based mocks drop out.

New scenarios to add:

- Each of the seven previously-501 methods gets an end-to-end test. Prove that `spineGetCompactionCheckpoint`, `spineScheduleCreate`, etc. now work when called from a bundle.
- A compile-time test that the `SpineHost` satisfaction assertion compiles. This is implicit in the build passing — if the assertion is present and the build passes, we know it compiles. No runtime test needed, but the assertion should be in a file that is always compiled (not gated behind a test runner).
- Optionally: a negative compile-time test using `@ts-expect-error` to prove that removing a method from AgentRuntime would break the build. Low priority; nice if cheap.

## Benchmark (optional, informational)

A before/after measurement of per-turn spine overhead would be useful to quantify the performance argument. The cleanest harness:

1. Check out `main` with the HTTP bridge.
2. Run a turn that makes N spine calls of each type (synthetic workload, e.g. 50 appendEntry + 50 kvGet + 20 broadcast).
3. Record wall time.
4. Check out this proposal's branch.
5. Same workload, same measurement.
6. Report delta.

This is informational, not gating. The proposal ships on correctness and type-safety grounds; the performance win is a bonus. If the benchmark reveals a regression, that is a bug in the implementation and should be investigated, but ex-ante the theoretical expectation is a substantial improvement per call.

## Risks

1. **DO RPC argument serialization**. Structured clone is stricter than JSON in some dimensions (fails on functions, class instances with methods, DOM objects) but looser in others (succeeds on Date, Map, Set, typed arrays, circular refs). No current spine method passes any of the edge-case types. Mitigation: add a guard in the test suite that rejects any future spine method whose arguments cannot be cloned.

2. **Typed error classes across the bridge**. Today, errors thrown inside `handleSpineRequest` become HTTP 500 responses with a serialized message, which SpineService catches and sanitizes. Post-change, errors thrown inside `AgentRuntime.spineX` propagate as real exceptions. SpineService's existing `catch (err) { throw this.sanitize(err) }` pattern handles both cases identically — both are `catch (err)` and both go through `sanitize`. No behavioral change visible to bundles. The only difference is internal: stack traces and error types are preserved on the host side for logging.

3. **Test flakiness**. The miniflare test environment is known-flaky (documented in CLAUDE.md and noted by the P1 and P2 subagents). Any integration-test rewrite risks catching flaky tests that were passing under the old pattern by accident. Mitigation: run each test class in isolation after the rewrite, compare against baseline, investigate any fresh failures before merging.

4. **A third party (external to this repo) hits `/spine/*` routes**. Extremely unlikely — those routes are internal to the SpineService → AgentDO path. A grep across the repo confirmed only SpineService itself and the two integration test files reference them. Mitigation: the grep is part of Phase 1 verification before any deletion.

5. **Future additions forget to wire the delegating runtime**. If someone adds a method to `AgentRuntime` with a new public surface, they may forget to check that `createDelegatingRuntime` forwards it. Mitigation: the SpineHost compile-time assertion is on `AgentDO`, not `AgentRuntime` — if the delegation is incomplete, `AgentDO` drifts from SpineHost and the build breaks. The check is in the right place.

## What this proposal deliberately does not decide

- **Whether to collapse SpineService into the DO entirely** (skipping the host worker middle tier for the bundle→spine hop). There's an argument that SpineService's only job is token verification and budget check, and those could happen inside a per-request wrapper on the DO's incoming RPC. This would eliminate boundary (1), not just boundary (2). It is a larger and more invasive change with its own trade-offs (token verification becomes per-DO instead of per-host-worker; budget state co-locates with session state). Not scoped here. Worth revisiting in a future proposal if the current architecture hits a real friction point.
- **Whether to replace LlmService's credential-holding role with something else.** Orthogonal. LlmService → DO path through `emitCost` benefits from this change for free (one call per cost emit, internally), but the bulk of LlmService's work is invoking external providers, which this proposal does not touch.
- **Whether to change the capability token model.** Explicitly preserved.
- **Whether to switch Tavily's `service` → `client` pattern.** Orthogonal. Tavily already works the same way post-change — it calls `env.SPINE.emitCost(...)` and the internal bridge change is invisible to it.

## Ordering

This proposal is independent. It can land:

1. Immediately after `split-agent-bundle-host-and-sdk` — no gap, just roll into it.
2. After some shape-2 capability rollout work — no dependency.
3. Before the A2A first-class promotion — no dependency.
4. In parallel with most other proposals — no shared files, minimal risk of merge conflict (the only shared file is `handleSpineRequest` in `agent-runtime.ts`, which is deleted, so anyone touching that function will have an obvious merge conflict).

Recommendation: land it soon after P2 closes out, while the spine architecture is fresh in memory and the test scaffolding added by P2 is current. Waiting does not make it harder; doing it early pays back the type-safety benefit for every subsequent edit.
