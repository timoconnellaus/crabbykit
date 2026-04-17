## ADDED Requirements

<!-- Section: Single token per turn -->

### Requirement: Bundle SHALL receive a single `__BUNDLE_TOKEN` env var per turn

For every bundle dispatch turn, the host SHALL mint exactly one capability token and inject it into the bundle isolate's env under the reserved key `__BUNDLE_TOKEN`. The bundle SHALL NOT receive any other token-carrying env field — `__SPINE_TOKEN`, `__LLM_TOKEN`, `__TAVILY_TOKEN`, or any other per-service variant.

Capability client subpaths (the `client` subpath pattern used by shape-2 capabilities like Tavily) SHALL read `env.__BUNDLE_TOKEN` for their authorization token. The environment MUST NOT be projected with any other token field.

#### Scenario: Dispatcher env projection contains only one token field
- **WHEN** `BundleDispatcher.dispatchTurn` prepares the env for a Worker Loader factory
- **THEN** the env contains `__BUNDLE_TOKEN: <string>` and does NOT contain `__SPINE_TOKEN`, `__LLM_TOKEN`, or `__TAVILY_TOKEN`

#### Scenario: Inline dispatch env projection contains only one token field
- **WHEN** `AgentDO._initBundleDispatch`'s `bundlePromptHandler` closure prepares the env for a Worker Loader factory
- **THEN** the env contains `__BUNDLE_TOKEN: <string>` and does NOT contain `__SPINE_TOKEN`, `__LLM_TOKEN`, or `__TAVILY_TOKEN`

#### Scenario: Client event dispatch reuses the env shape
- **WHEN** `bundleClientEventHandler` handles a steer/abort event mid-turn
- **THEN** the fresh mint and env projection follow the same single-token shape

<!-- Section: Scope array in payload -->

### Requirement: Token payload SHALL carry a `scope: string[]` field

The unified capability token's decoded payload SHALL include a `scope: string[]` field alongside the existing `aid`, `sid`, `exp`, `nonce` fields. Scope entries SHALL identify which services and capabilities the token authorizes the bundle to call.

The `@claw-for-cloudflare/bundle-token` package's `TokenPayload` type SHALL declare this field as required (not optional). Every mint SHALL populate it; every verify SHALL preserve it in `VerifyResult.payload`.

#### Scenario: Mint produces a payload with scope
- **WHEN** `mintToken({ agentId, sessionId, scope: ["spine", "llm", "tavily-web-search"] }, subkey)` is called
- **THEN** the minted token decodes to a payload where `scope === ["spine", "llm", "tavily-web-search"]` in declaration order

#### Scenario: Empty scope is permitted at mint
- **WHEN** `mintToken` is called with `scope: []`
- **THEN** the token is minted successfully but does not authorize any service call (every `requiredScope` check fails)

#### Scenario: Scope missing from payload is malformed
- **WHEN** a token with no `scope` field in its payload (e.g. crafted by hand, or minted before this change) is verified
- **AND** verification is called with `requiredScope: "spine"`
- **THEN** verification fails with `ERR_SCOPE_DENIED` — the scope check treats missing/non-array scope as empty

<!-- Section: Reserved core scopes + capability scopes -->

### Requirement: Scope SHALL mix reserved core strings with catalog-derived capability ids

The dispatcher SHALL compute the scope array at mint time as the concatenation of two reserved core strings and the validated capability catalog's ids:

```ts
scope = ["spine", "llm", ...requiredCapabilities.map(r => r.id)]
```

The reserved strings `"spine"` and `"llm"` SHALL be present in every minted token regardless of the bundle's declaration. Bundle authors SHALL NOT be able to exclude them. They authorize the two non-negotiable channels every bundle uses: the DO state/RPC surface (SpineService) and the LLM inference surface (LlmService).

Capability scopes SHALL be populated verbatim from the validated catalog. The catalog's input validation (kebab-case, 2..64 chars, at most 64 entries, deduplicated) bounds scope entries automatically.

#### Scenario: Bundle with catalog declaration
- **WHEN** a bundle's active version declares `requiredCapabilities: [{ id: "tavily-web-search" }, { id: "file-tools" }]`
- **AND** the dispatcher has validated the catalog successfully
- **THEN** the minted token's `scope` equals `["spine", "llm", "tavily-web-search", "file-tools"]`

#### Scenario: Bundle without catalog declaration
- **WHEN** a bundle's active version has `requiredCapabilities: undefined` (legacy) or `[]` (explicit empty)
- **THEN** the minted token's `scope` equals `["spine", "llm"]` — the two reserved core scopes only

#### Scenario: Scope entries are ordered consistently
- **WHEN** two turns of the same bundle mint tokens
- **THEN** both tokens have identical `scope` arrays in identical order (reserved core scopes first, catalog ids in declaration order)

<!-- Section: Per-service scope enforcement -->

### Requirement: Each host-side service SHALL verify its scope before authorizing

Every host-side service that holds provider credentials or mediates access to DO state SHALL call `verifyToken` with a `requiredScope` option set to its canonical scope string. Signature verification and TTL checks SHALL run before the scope check; scope denial SHALL only surface for tokens that are otherwise valid.

Canonical scope strings:

- `SpineService` → `"spine"`
- `LlmService` → `"llm"`
- `TavilyService` → `"tavily-web-search"` (matches the capability's registered `id`)
- Future shape-2 services → their capability's kebab-case `id`

A service that receives a token whose `scope` does not include its canonical scope SHALL reject the call with error code `ERR_SCOPE_DENIED` (surfaced as a thrown error whose message contains the code).

#### Scenario: SpineService rejects scope-insufficient token
- **WHEN** a bundle calls `env.SPINE.appendEntry(token, entry)` with a token whose payload `scope` does not include `"spine"`
- **THEN** `SpineService.appendEntry` throws `SpineError` with code `ERR_SCOPE_DENIED`

#### Scenario: LlmService rejects scope-insufficient token
- **WHEN** a bundle calls `env.LLM_SERVICE.infer(token, request)` with a token whose payload `scope` does not include `"llm"`
- **THEN** the call throws with the error message `ERR_SCOPE_DENIED`

#### Scenario: TavilyService rejects scope-insufficient token
- **WHEN** a bundle calls `env.TAVILY.search(token, args)` with a token whose payload `scope` does not include `"tavily-web-search"`
- **THEN** the call throws with the error message `ERR_SCOPE_DENIED`

#### Scenario: Valid scope passes verify
- **WHEN** the same service is called with a token whose `scope` includes its canonical scope string
- **AND** the token is otherwise valid (signature, TTL, optional nonce)
- **THEN** verification returns `{ valid: true, payload }` and the service proceeds with its normal authorization flow

<!-- Section: verify call order -->

### Requirement: Scope check SHALL run after signature, TTL, and nonce checks

`verifyToken` SHALL perform checks in the following order, returning the first failure encountered:

1. Token structure (base64url decode, dot-separated halves). Failure → `ERR_MALFORMED`.
2. HMAC signature verification. Failure → `ERR_BAD_TOKEN`.
3. Payload JSON parse. Failure → `ERR_MALFORMED`.
4. Expiration check (`exp <= Date.now()`). Failure → `ERR_TOKEN_EXPIRED`.
5. Nonce tracker `tryConsume` (if tracker provided). Failure → `ERR_TOKEN_REPLAY`.
6. Scope check (`payload.scope.includes(requiredScope)`, if `requiredScope` provided). Failure → `ERR_SCOPE_DENIED`.

The ordering ensures that a malformed or expired token never leaks information about its scope, and that cheap checks run before expensive ones.

#### Scenario: Expired token surfaces TTL error even when scope is wrong
- **WHEN** a token with `exp < Date.now()` and a `scope` that does not include `"spine"` is verified against `requiredScope: "spine"`
- **THEN** verification returns `ERR_TOKEN_EXPIRED`, not `ERR_SCOPE_DENIED`

#### Scenario: Signature-tampered token surfaces BAD_TOKEN even when scope is wrong
- **WHEN** a token with a flipped signature byte and a `scope` that does not include `"spine"` is verified against `requiredScope: "spine"`
- **THEN** verification returns `ERR_BAD_TOKEN`

#### Scenario: Valid-but-wrong-scope token surfaces scope denial
- **WHEN** a token with valid signature, unexpired TTL, and `scope` that does not include `"spine"` is verified against `requiredScope: "spine"`
- **THEN** verification returns `ERR_SCOPE_DENIED`

<!-- Section: Single HKDF subkey -->

### Requirement: Mint and verify SHALL derive keys from a single HKDF label `claw/bundle-v1`

The host SHALL derive the mint subkey from `AGENT_AUTH_KEY` via HKDF-SHA-256 with label `claw/bundle-v1`. All three services (SpineService, LlmService, TavilyService) SHALL derive verify-only subkeys from the same `AGENT_AUTH_KEY` with the same label.

The per-service labels used previously (`claw/spine-v1`, `claw/llm-v1`, `claw/tavily-v1`) SHALL NOT appear in production code. Domain separation between services is moved from the HKDF layer into the payload's `scope` field, enforced by per-service `requiredScope` checks.

A single exported constant `BUNDLE_SUBKEY_LABEL = "claw/bundle-v1"` SHALL be re-exported from `@claw-for-cloudflare/bundle-host`'s barrel. All mint and verify call sites SHALL import this constant rather than hard-coding the string.

#### Scenario: All services use the same subkey label
- **WHEN** SpineService, LlmService, and TavilyService each derive their verify-only subkey
- **THEN** all three pass `"claw/bundle-v1"` (via the `BUNDLE_SUBKEY_LABEL` export) to `deriveVerifyOnlySubkey`

#### Scenario: Mint uses the same label as verify
- **WHEN** the dispatcher mints a token via `mintToken` with a subkey derived from `deriveMintSubkey(AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL)`
- **AND** a service verifies the token with a subkey derived from `deriveVerifyOnlySubkey(AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL)`
- **THEN** the HMAC signature check succeeds because both subkeys derive from the same HKDF inputs

#### Scenario: Old subkey labels are absent
- **WHEN** the codebase is grep-searched for `claw/spine-v1`, `claw/llm-v1`, `claw/tavily-v1`
- **THEN** no matches appear in production source or tests (openspec proposal files documenting the migration are exempt)

<!-- Section: TTL preserved -->

### Requirement: Token TTL behavior SHALL be unchanged

The token's default TTL SHALL remain 60 seconds (`DEFAULT_TTL_MS = 60 * 1000` in `bundle-host/src/security/mint.ts`). `MintOptions.ttlMs` SHALL continue to allow per-call override. The TTL's semantic purpose — bounding replay window — SHALL be unchanged.

#### Scenario: Default TTL is 60 seconds
- **WHEN** `mintToken({ agentId, sessionId, scope })` is called without `ttlMs`
- **THEN** the token's `payload.exp` equals `Date.now() + 60_000` (±clock skew)

#### Scenario: Custom TTL honored
- **WHEN** `mintToken({ agentId, sessionId, scope, ttlMs: 5_000 })` is called
- **THEN** the token expires 5 seconds from mint time

<!-- Section: Nonce semantics preserved -->

### Requirement: Nonce generation and tracking behavior SHALL be unchanged

Each minted token SHALL carry a unique `nonce: string` generated by `crypto.randomUUID()`. `NonceTracker` SHALL continue to support single-use-nonce semantics for callers that opt in; production services (SpineService, LlmService) SHALL continue to NOT use NonceTracker because a single per-turn token carries many RPC calls.

The shared nonce across all services within a turn SHALL NOT cause cross-service replay detection issues — each opting-in consumer maintains its own tracker, and trackers deduplicate against their own `consumed` map. Budget enforcement keyed on `(nonce, category)` SHALL continue to work because each service reports its own category and the `BudgetTracker` lives in the DO (per `move-spine-budget-into-do`).

#### Scenario: Nonce is unique per mint
- **WHEN** two consecutive `mintToken` calls occur with identical `agentId`, `sessionId`, and `scope`
- **THEN** the two tokens have distinct `payload.nonce` values

#### Scenario: Same nonce used by multiple services within a turn
- **WHEN** a single `__BUNDLE_TOKEN` is used for one spine RPC and one LLM RPC in the same turn
- **THEN** both calls succeed; both `caller` contexts carry the same nonce string; the DO's `BudgetTracker` accumulates counts under that nonce without interference between categories

<!-- Section: Reserved scope strings cannot collide with capability ids -->

### Requirement: Reserved scope strings SHALL NOT be used as capability ids

The reserved scope strings `"spine"` and `"llm"` SHALL NOT appear as capability ids anywhere in the system. They authorize the two non-negotiable bundle→host channels every bundle uses (DO state/RPC and LLM inference), are unconditionally prepended to every minted token's `scope` array by the dispatcher, and MUST NOT be obtainable via a bundle's `requiredCapabilities` declaration.

The catalog validator SHALL enforce this exclusion at both the `defineBundleAgent` build-time layer and the `BundleRegistry.setActive` promotion layer. See the companion `bundle-capability-catalog` spec for the declaration-side rules; this requirement captures the invariant from the token side: **no bundle-authored scope entry SHALL match a reserved string**.

The scope-array computation in both dispatch paths SHALL therefore be safe to treat `"spine"` and `"llm"` as positional-prefix-only — the catalog-derived tail can never include them by construction.

#### Scenario: Scope array prefix is reserved-scope-only
- **WHEN** a bundle with any valid `requiredCapabilities` declaration runs a turn
- **THEN** the minted token's `scope[0] === "spine"` and `scope[1] === "llm"`
- **AND** `scope.slice(2)` contains only capability ids drawn verbatim from the validated catalog (none of which equals `"spine"` or `"llm"`)

#### Scenario: Cross-reference to catalog-side rejection
- **WHEN** a bundle declares `requiredCapabilities: [{ id: "spine" }]`
- **THEN** the declaration is rejected at build time by `defineBundleAgent` or at pointer-flip time by `BundleRegistry.setActive` — the reserved-id check runs in both layers per the companion `bundle-capability-catalog` spec
- **AND** no minted token ever carries a scope array derived from such a declaration, because the declaration itself never reaches dispatch

<!-- Section: Scope-denied error round-trip -->

### Requirement: `ERR_SCOPE_DENIED` from spine services SHALL round-trip the error code intact

When a bundle calls a SpineService RPC with a token that fails scope verification, the `SpineError` raised inside `SpineService` SHALL be sanitized via the same code-preserving path that already handles `ERR_BUDGET_EXCEEDED`. The sanitizer SHALL embed `ERR_SCOPE_DENIED` into the error message so that the bundle-side receiver can match it by substring the same way it matches other propagated codes.

The bundle-observable error thrown at the RPC receiver SHALL have `code === "ERR_SCOPE_DENIED"` (or an equivalent substring match) rather than being collapsed to `ERR_INTERNAL`. The same guarantee applies when scope denial is triggered via `spine.emitCost` — a cost-emission call from a token lacking `"spine"` scope SHALL surface `ERR_SCOPE_DENIED` to the bundle.

#### Scenario: `spine.emitCost` scope denial preserves code
- **WHEN** a bundle invokes `env.SPINE.emitCost(token, event)` with a token whose `scope` does not include `"spine"`
- **THEN** the caught error's code (or message substring) is `ERR_SCOPE_DENIED`, not `ERR_INTERNAL`
- **AND** the sanitizer path at `bundle-host/src/services/spine-service.ts` forwards the code identically to how `ERR_BUDGET_EXCEEDED` is forwarded (the mechanism added by `fix(bundle-host): preserve ERR_BUDGET_EXCEEDED code across DO RPC boundary`)

#### Scenario: Scope-denied SpineError survives sanitize branch
- **WHEN** a SpineService method catches a `SpineError { code: "ERR_SCOPE_DENIED" }` in its sanitize branch
- **THEN** the error re-thrown to the bundle preserves the code — the `.includes("ERR_SCOPE_DENIED")` check on the bundle side matches, matching the `ERR_BUDGET_EXCEEDED` precedent

<!-- Section: Breaking change -->

### Requirement: Per-service token env fields SHALL be removed

The following env fields SHALL NOT be written by any dispatcher and SHALL NOT be read by any capability client subpath after this change; they are removed from the bundle isolate's env projection:

- `__SPINE_TOKEN`
- `__LLM_TOKEN`
- `__TAVILY_TOKEN`

After the change, no capability client code SHALL read any of these fields. No dispatcher SHALL write any of these fields. The single replacement `__BUNDLE_TOKEN` SHALL be the only token-carrying env field.

This is a breaking change. Bundle authors and third-party capability authors who read the removed fields SHALL rebuild against the current SDK. No compat shim SHALL be introduced; per CLAUDE.md's "No legacy code" policy, the old API is deleted cleanly.

#### Scenario: Removed env fields produce undefined on read
- **WHEN** a bundle built against a prior version of the SDK reads `env.__SPINE_TOKEN`
- **THEN** the value is `undefined` — the dispatcher no longer injects this field

#### Scenario: Grep confirms complete removal
- **WHEN** the codebase is grep-searched for `__SPINE_TOKEN`, `__LLM_TOKEN`, `__TAVILY_TOKEN`
- **THEN** no matches appear in production source, tests, or examples (openspec proposal files documenting the migration are exempt)
