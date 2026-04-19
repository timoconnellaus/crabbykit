## MODIFIED Requirements

<!-- Section: Spine budget enforcement -->

### Requirement: Spine budget enforcement state lives in the agent DO

The per-turn RPC budget accumulator used to cap spine calls per category (`sql`, `kv`, `alarm`, `broadcast`) SHALL live inside `AgentRuntime<TEnv>` as an instance field, not inside `SpineService` as a `WorkerEntrypoint` instance field. The accumulator's lifetime SHALL be the lifetime of the Agent Durable Object, which provides strongly-consistent per-agent state that survives across `SpineService` instance recycles.

`SpineService` SHALL NOT hold a `BudgetTracker` instance or any other per-turn accumulator. Its `SpineEnv` type SHALL NOT declare a `SPINE_BUDGET` field. Its methods SHALL NOT call any per-turn budget check function local to the service.

`AgentRuntime<TEnv>` SHALL instantiate a single `BudgetTracker` in its constructor, held as a private readonly field, configured via the budget config passed through `AgentRuntimeOptions` (or equivalent runtime construction input). Every `spine*` method on `AgentRuntime` SHALL check and increment the budget via a `withSpineBudget(caller, category, fn)` helper before executing the method body.

#### Scenario: Budget enforced across SpineService instance recycles
- **WHEN** a bundle issues 100 `appendEntry` calls through a first `SpineService` instance
- **AND** a second `SpineService` instance is subsequently used (simulating Cloudflare Workers' WorkerEntrypoint instance recycling)
- **AND** the second instance receives a 101st `appendEntry` call with the same token and nonce
- **THEN** the 101st call SHALL fail with `ERR_BUDGET_EXCEEDED` because the budget accumulator lives in the agent DO and persists across both `SpineService` instance lifetimes

#### Scenario: Per-nonce budget isolation
- **WHEN** a bundle exhausts the budget for nonce A across any category
- **AND** the same bundle later uses a different token with nonce B
- **THEN** nonce B's budget SHALL start at zero and be enforced independently — nonce A's exhaustion SHALL NOT affect nonce B

#### Scenario: Per-agent budget isolation
- **WHEN** agent X's budget is exhausted for a given nonce and category
- **AND** an unrelated agent Y receives a spine call
- **THEN** agent Y's budget SHALL be independent from agent X's — each DO holds its own `BudgetTracker` instance scoped to its own per-agent state

#### Scenario: Budget category independence
- **WHEN** a bundle exhausts the `sql` category budget for a nonce
- **AND** the same bundle attempts a `kv` category operation with the same nonce
- **THEN** the `kv` operation SHALL succeed — categories are tracked independently

### Requirement: `SpineHost` methods accept a `SpineCaller` context

Every method on the `SpineHost` interface SHALL accept a `SpineCaller` object as its first parameter, replacing the previous `sessionId: string` or equivalent first arguments. The `SpineCaller` type SHALL be declared in `@crabbykit/agent-runtime` and exported from the package barrel.

The `SpineCaller` interface SHALL declare at minimum:

- `aid: string` — verified agent id from the token payload
- `sid: string` — verified session id from the token payload (may be empty string for agent-scoped methods that do not require a session context)
- `nonce: string` — verified nonce from the token payload, used as the per-turn budget accumulator key

Additional fields MAY be added to `SpineCaller` in future changes to carry more verified context (e.g., a `mode` field for mode-aware dispatch) without requiring a separate interface change to every method.

`SpineService` SHALL construct the `SpineCaller` for each call exclusively from the verified token payload fields. It SHALL NOT accept or forward any caller-supplied identity fields; the `SpineCaller` is produced from cryptographically-verified data, not from arguments the bundle passed.

#### Scenario: Spine method receives typed caller context
- **WHEN** `SpineService.appendEntry(token, entry)` is called
- **AND** the token's signature and TTL verify successfully
- **THEN** `SpineService` constructs `const caller: SpineCaller = { aid, sid, nonce }` from the verified payload and calls `host.spineAppendEntry(caller, entry)` on the DO stub

#### Scenario: Type drift on the caller context is caught at compile time
- **WHEN** a developer adds a new field to `SpineCaller` and forgets to populate it in `SpineService`
- **THEN** TypeScript reports an error at the SpineService call site because the object literal is missing a required property

### Requirement: `AgentRuntime.spine*` methods run budget enforcement via a central helper

Every `spine*` method on `AgentRuntime<TEnv>` SHALL run its body through a private `withSpineBudget(caller, category, fn)` helper (or equivalent structural pattern) that:

1. Calls `this.spineBudget.check(caller.nonce, category)` as the first operation.
2. Throws `ERR_BUDGET_EXCEEDED` if the per-turn cap for `(nonce, category)` is exceeded, before performing any work.
3. Invokes the method body (passed as a callback or inlined) only if the check passes.

The `category` argument SHALL be a literal string matching the method's intended budget category (`sql`, `kv`, `alarm`, `broadcast`). The category MUST be declared explicitly at the call site — no implicit or default category.

Forgetting to wrap a spine method's body with `withSpineBudget` SHALL be a review-caught bug. No automatic budget enforcement exists at the type level (TypeScript cannot prove a method "calls the helper first"); the guarantee is enforced by convention and verified by tests.

#### Scenario: Budget check runs before method body
- **WHEN** `AgentRuntime.spineAppendEntry(caller, entry)` is invoked with a nonce whose `sql` budget is already exhausted
- **THEN** the method throws `ERR_BUDGET_EXCEEDED` WITHOUT calling `this.sessionStore.appendEntry(...)` — no partial state mutation

#### Scenario: Budget check category matches method's operation type
- **WHEN** `AgentRuntime.spineKvPut` is invoked
- **THEN** the budget check uses category `'kv'`, not `'sql'` or any other

### Requirement: Budget config flows from wrangler to AgentRuntime construction

The spine budget configuration (`SpineBudgetConfig`) SHALL be read from the host worker's environment (typically `env.SPINE_BUDGET` if declared, or a default-constructed config if absent) and passed into `AgentRuntime` construction via `AgentDO`'s runtime-construction path. `SpineService` SHALL NOT read the budget config.

If the environment variable `SPINE_BUDGET` is not declared in `wrangler.jsonc`, `AgentRuntime` SHALL construct `BudgetTracker` with its default config — matching the behavior SpineService had prior to this change with an absent `SPINE_BUDGET`.

#### Scenario: Default budget applies when unconfigured
- **WHEN** a deployment's `wrangler.jsonc` does not declare any `SPINE_BUDGET` binding
- **THEN** `AgentRuntime` constructs `BudgetTracker` with the class's default configuration — the same defaults that applied when SpineService held the tracker with an absent env binding

#### Scenario: Custom budget passes through wrangler env
- **WHEN** a deployment's `wrangler.jsonc` declares a `SPINE_BUDGET` env binding with custom category caps
- **THEN** `AgentDO` reads that binding at construction and forwards it to `AgentRuntime`, which constructs `BudgetTracker` with the custom caps

## ADDED Requirements

<!-- Section: Trust model for SpineCaller -->

### Requirement: `SpineCaller` is trusted by the DO method recipient

The DO method recipient (`AgentRuntime.spineX`) SHALL NOT re-verify the `SpineCaller` context. The trust model assumes that any caller holding a `DurableObjectNamespace<AgentDO>` binding is already privileged code (by virtue of the binding being a capability), and that privileged code constructing a `SpineCaller` is trusted to provide accurate verified identity.

`SpineService` is the gatekeeper for the one untrusted caller (the bundle isolate). It verifies the token cryptographically and constructs `SpineCaller` from the verified payload. Other trusted callers (admin tooling, debug endpoints, future internal services) that directly invoke DO spine methods construct their own `SpineCaller` and the DO trusts them.

A compromised `SpineService` COULD forge a `SpineCaller` with arbitrary identity, but the trust model has always treated `SpineService` as privileged — a compromise of SpineService is a higher-severity incident than a forged caller context alone, and the forgery is not a new attack surface introduced by this change.

#### Scenario: DO method does not verify the caller context
- **WHEN** `AgentRuntime.spineAppendEntry(caller, entry)` is invoked with any `SpineCaller` object
- **THEN** the method trusts the fields in `caller` as accurate verified identity, performs the budget check against `caller.nonce`, and appends the entry against `caller.sid` — no token verification or signature check happens inside the DO method

#### Scenario: Trusted direct invocation
- **WHEN** a hypothetical admin tool holds `env.AGENT` (the DO namespace binding) and directly calls `stub.spineAppendEntry({ aid, sid, nonce }, entry)` without going through `SpineService`
- **THEN** the call succeeds because the DO trusts its direct callers — the admin tool is trusted by virtue of holding the namespace binding

### Requirement: Instance-recycle simulation test exists and passes

The test suite SHALL contain an integration test that simulates SpineService instance recycling within a single turn and verifies that the per-turn budget is enforced across the combined call count from both instances. This test is load-bearing: it is the test that fails under the pre-change architecture (where the budget lives in the SpineService instance) and passes under the post-change architecture (where it lives in the DO).

The test SHALL:

1. Mint a capability token for a specific agent, session, and nonce.
2. Construct a first `SpineService` instance and issue N spine calls through it, where N is less than the configured category cap.
3. Discard the first instance and construct a second `SpineService` instance with the same underlying environment.
4. Issue more calls through the second instance until the total (first instance + second instance) exceeds the cap.
5. Assert that the (cap + 1)-th total call fails with `ERR_BUDGET_EXCEEDED`.

#### Scenario: Instance recycle does not reset the budget
- **WHEN** a test mints a token with nonce N and issues 50 `appendEntry` calls via a first `SpineService` instance
- **AND** the test discards that instance and constructs a new one
- **AND** the test issues 50 more `appendEntry` calls via the new instance
- **AND** the total category budget is 100
- **THEN** the 51st call on the second instance (the 101st total call) throws `ERR_BUDGET_EXCEEDED`

#### Scenario: The same test fails under the pre-change architecture
- **WHEN** the same test is run against the pre-change codebase where `BudgetTracker` lives in `SpineService`
- **THEN** the test fails because the second `SpineService` instance has its own fresh `BudgetTracker` and accepts all 50 calls without reaching the cap — the 51st call succeeds instead of throwing, and the assertion fails
- **NOTE**: this scenario is informational; the test is authored for the post-change codebase and is intended to pass there. It exists as documentation that the pre-change architecture was structurally unable to satisfy the requirement.
