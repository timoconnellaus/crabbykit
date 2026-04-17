## Why

Every host-side service that accepts calls from a bundle mints its own per-turn capability token under its own HKDF subkey, and delivers that token to the bundle isolate under its own reserved env field. Three services, three tokens, three subkey labels, three env fields, three verify paths:

| Service | HKDF subkey label | Env field on bundle | Verifier |
|---|---|---|---|
| spine (SpineService) | `claw/spine-v1` | `env.__SPINE_TOKEN` | `SpineService.verify` |
| llm (LlmService) | `claw/llm-v1` | `env.__LLM_TOKEN` | `LlmService.verify` |
| tavily (TavilyService) | `claw/tavily-v1` (intended) | `env.__TAVILY_TOKEN` (intended) | `TavilyService.verify` (stubbed) |

Actual code today is worse than the table suggests. `agent-runtime/src/agent-do.ts` mints two tokens per turn (spine + llm) and writes them to `env.__SPINE_TOKEN` / `env.__LLM_TOKEN`. `packages/capabilities/tavily-web-search/src/client.ts` reads `env.__SPINE_TOKEN` to authorize Tavily calls — i.e., Tavily reuses the spine token because the intended Tavily-scoped token was never wired. `TavilyService` has a `TAVILY_SUBKEY: CryptoKey` field in its env type and a comment "Token verification would happen here via TAVILY_SUBKEY (simplified for initial implementation — full verify in integration)" sitting above an empty check. So the "three tokens" pattern is already half-broken: the code pretends each service has its own token, the dispatcher doesn't mint one for Tavily, and the client silently falls back to the spine token.

Separately, `BundleDispatcher` (the unit-test-only path in `bundle-host/src/dispatcher.ts`) only knows about `__SPINE_TOKEN`. It does not mint an LLM token at all. The inline dispatch closure in `agent-do.ts` (the production path) mints both. Two implementations of the same dispatch mechanism with different ideas about how many tokens exist.

Costs of the current pattern:

1. **Scaling cost.** Adding a fourth shape-2 capability (file-tools, vector-memory, browserbase, skills are all candidates) means: new HKDF subkey label + new mint call in the dispatcher + new reserved `__FOO_TOKEN` env field + new verify path in the service + new entry in `bundleEnv` documentation. Five changes per capability. The scaling slope is wrong.
2. **Drift surface.** The two dispatcher implementations already disagree on which tokens to mint. Each new token multiplies the drift risk between dispatchers. Tavily's client today reads the wrong env field — the bug is dormant because the spine subkey happens to verify the token on any service whose verify path doesn't actually check the label. The drift is already real.
3. **Bundle env pollution.** `env.__SPINE_TOKEN`, `env.__LLM_TOKEN`, `env.__TAVILY_TOKEN`, … is a poll tax on the bundle env namespace. Each token is a reserved identifier the bundle author must not use. Capability authors must know which one to read. The surface grows linearly with capability count.
4. **Single-scope compromise makes weaker guarantees than it looks like.** The domain separation from per-service HKDF subkeys only helps if a token could leak from one service to another. In practice the three tokens are all minted in the same DO, at the same millisecond, from the same payload, and delivered simultaneously to the same isolate with `globalOutbound: null`. There is no realistic scenario where the spine token leaks but the llm token doesn't. The per-subkey separation is theater against an attack model that doesn't exist in the current deployment shape.

The fix is to mint one token per turn carrying an explicit scope list, deliver it in one reserved env field (`env.__BUNDLE_TOKEN`), and have each service verify both the signature and the presence of its own scope in the payload before authorizing. Identical security posture for the realistic threat model (short-lived token, no exfiltration, per-service scope check), strictly better scaling (adding a new shape-2 capability is one entry in the scope array at mint time, one kebab-case check on verify).

The capability catalog proposal just shipped. Bundles now declare their `requiredCapabilities`, and the dispatcher validates the declaration at pointer-flip time. The unified token's `scope` array is derived directly from the catalog plus two reserved core scopes (`"spine"`, `"llm"`). The catalog is the one authoritative source for "what this bundle may do"; the token is the per-turn credential that enforces it.

This is a breaking change. No compat shim. `__SPINE_TOKEN` / `__LLM_TOKEN` / `__TAVILY_TOKEN` are removed. Capability client subpaths that read them — today only Tavily, tomorrow the shape-2 capability rollout — are rewritten to read `env.__BUNDLE_TOKEN`. Per CLAUDE.md, CLAW is greenfield and we delete the old surface rather than maintain compat shims.

## What Changes

- **Single per-turn token in `env.__BUNDLE_TOKEN`.** The dispatcher mints exactly one capability token per turn. Its payload carries a new `scope: string[]` field naming every service and capability the bundle is authorized to call. It is written to `env.__BUNDLE_TOKEN` on the bundle isolate's env.

- **Token payload widens with `scope: string[]`.** The `TokenPayload` interface in `@claw-for-cloudflare/bundle-token` adds a required `scope: string[]` field. Existing fields (`aid`, `sid`, `exp`, `nonce`) are unchanged.

  ```ts
  export interface TokenPayload {
    aid: string;
    sid: string;
    exp: number;
    nonce: string;
    scope: string[]; // NEW: scopes this token authorizes
  }
  ```

- **Single HKDF subkey label: `claw/bundle-v1`.** The three per-service labels (`claw/spine-v1`, `claw/llm-v1`, `claw/tavily-v1`) are removed. Mint and all three verifiers use the single label. Domain separation moves from the HKDF layer into the payload's `scope` field, checked explicitly by each service on verify.

- **`verifyToken` gains a `requiredScope` parameter.** The signature becomes `verifyToken(token, subkey, { nonceTracker?, requiredScope? }): Promise<VerifyOutcome>`. When `requiredScope` is provided, verification additionally checks `payload.scope.includes(requiredScope)` after signature + TTL + nonce pass. Mismatched scope surfaces as a new `VerifyError` code `ERR_SCOPE_DENIED`. Omitting `requiredScope` preserves the previous semantics (signature + TTL + nonce only), useful for tests.

- **Reserved scopes: `"spine"` and `"llm"`.** These are not capability ids — they're the two non-negotiable bundle→host channels every bundle uses (DO state/RPC and LLM inference). They are always present in the minted scope list, regardless of the bundle's declaration.

- **Capability scopes: the capability's kebab-case `id`.** Scope entries beyond the two reserved ones are copied verbatim from the validated catalog (`requiredCapabilities.map(r => r.id)`). A bundle declaring `[{ id: "tavily-web-search" }]` gets `scope: ["spine", "llm", "tavily-web-search"]`. A bundle that declares nothing (empty catalog) gets `scope: ["spine", "llm"]`.

- **Per-service verify is `scope.includes(myScope)`.** `SpineService` verifies and requires `"spine"`. `LlmService` verifies and requires `"llm"`. `TavilyService` verifies and requires `"tavily-web-search"`. Each service fails closed with `ERR_SCOPE_DENIED` when its scope is absent.

- **Dispatcher mints one token per turn.** Both dispatchers (`BundleDispatcher` in `bundle-host`, the inline `initBundleDispatch` closure in `agent-runtime/src/agent-do.ts`) collapse their two mint calls into one. The scope list is computed as `["spine", "llm", ...validatedCatalogIds]`. The token is written to `env.__BUNDLE_TOKEN`. The `__SPINE_TOKEN` / `__LLM_TOKEN` / `__TAVILY_TOKEN` fields are removed from the projected bundle env.

- **Capability catalog is the authoritative scope source.** The dispatch-time catalog validation that landed in `define-bundle-capability-catalog` already produces a validated set of capability ids the bundle is allowed to use. That same validated list feeds the mint's scope array. A bundle that doesn't declare `tavily-web-search` cannot obtain a `tavily-web-search` scope at mint time — the token cryptographically cannot authorize calls to a capability the bundle didn't declare.

- **Capability client subpaths read `env.__BUNDLE_TOKEN`.** Tavily's `src/client.ts` changes `env.__SPINE_TOKEN` to `env.__BUNDLE_TOKEN`. Future shape-2 capabilities do the same — single env field for every capability, no per-capability token naming convention to learn.

- **Nonce tracker semantics unchanged.** The existing `NonceTracker` is keyed on nonce alone and stores `{nonce → expiresAt}`. With one token per turn, a single nonce is shared across all services. Production spine path does NOT use `NonceTracker` (documented: a single per-turn token carries the bundle through many RPCs, so single-use nonce would cap a turn at one call). Production LLM path also does not use it. If a service opts into replay protection, it keeps its own tracker; cross-service nonce sharing doesn't break that because each tracker deduplicates against its own `consumed` map. Budget enforcement, which is keyed on nonce, continues to work identically.

- **Budget tracker semantics unchanged.** `AgentRuntime.spineBudget` (per-DO, keyed on `caller.nonce` and category) runs identically. The shared nonce across services is fine: budget enforces *per-category* totals, and each service still reports its own category. Tavily and LLM don't touch the spine budget at all — they emit costs via `spine.emitCost`, which is under `"broadcast"` category and capped as before.

- **Mint signature change.** `mintToken` in `bundle-host/src/security/mint.ts` grows a required `scope: string[]` parameter in `MintOptions`. Callers must pass the scope list explicitly. There is no sensible default; every call site has a principled answer (the catalog validation already ran).

- **Old per-service labels disappear.** `SPINE_SUBKEY_LABEL`, `LLM_SUBKEY_LABEL`, and any `TAVILY_SUBKEY_LABEL` constant are deleted and replaced with a single `BUNDLE_SUBKEY_LABEL = "claw/bundle-v1"` export.

## Capabilities

### Added Capabilities

- **`bundle-capability-token`** — a unified per-turn capability token with an explicit scope list. Single HKDF subkey (`claw/bundle-v1`). Single env field (`__BUNDLE_TOKEN`). Per-service scope check on verify. Replaces the multi-token pattern that existed prior to this change.

### Modified Capabilities

- **`agent-bundles`** — the per-turn bundle dispatch lifecycle mints one token per turn instead of N tokens (where N was one per host-side service). The reserved per-service env fields are removed from the bundle's projected env. The dispatcher's mint call site reads the validated catalog to populate scope.

### Removed Capabilities

None. The security property preserved by the three-token scheme (a bundle cannot escalate from one service's authorization to another's) is retained by the per-service `scope.includes(...)` check on verify.

## Impact

- **Modified packages**:
  - `packages/runtime/bundle-token/` — `TokenPayload` adds `scope: string[]`. `VerifyError` code union adds `"ERR_SCOPE_DENIED"`. `verifyToken` grows a `requiredScope?` option. No mint primitives introduced — package stays verify-only.
  - `packages/runtime/bundle-host/` — `mintToken` in `src/security/mint.ts` takes a required `scope: string[]`. The per-service subkey labels are deleted; one `BUNDLE_SUBKEY_LABEL = "claw/bundle-v1"` export replaces them. `SpineService.verify` and `LlmService.verify` pass `requiredScope: "spine"` / `"llm"` when verifying. `BundleDispatcher.dispatchTurn` mints one token with a scope derived from the validated catalog plus the two core scopes, writes to `env.__BUNDLE_TOKEN`, and removes the per-service env fields from the projected env.
  - `packages/runtime/agent-runtime/` — the inline `initBundleDispatch` closure in `src/agent-do.ts` mirrors the dispatcher: one mint, one env field, scope derived from the validated catalog. The `getSpineSubkey` / `getLlmSubkey` closures collapse into a single `getBundleSubkey` closure.
  - `packages/capabilities/tavily-web-search/` — `TavilyService.search` / `.extract` verify the token with `requiredScope: "tavily-web-search"`. `src/client.ts` reads `env.__BUNDLE_TOKEN`. The vestigial `TAVILY_SUBKEY: CryptoKey` field on the service env is deleted; the service reads `AGENT_AUTH_KEY` and derives `claw/bundle-v1` (matching the other services). `package.json` gains `@claw-for-cloudflare/bundle-token: workspace:*` as a dependency so the service can import `verifyToken` + `deriveVerifyOnlySubkey` + `BUNDLE_SUBKEY_LABEL` (the last re-exported from `bundle-token`; see design decision 2).
  - `packages/runtime/bundle-sdk/` — the bundle authoring API's `BundleEnv` typed fields change. `src/types.ts` drops `__SPINE_TOKEN?: string` and `__LLM_TOKEN?: string` and adds `__BUNDLE_TOKEN?: string`. `src/define.ts`'s `handleTurn` 401-checks `env.__BUNDLE_TOKEN` (replacing the two current checks at lines 84-94); `handleSmoke` reads `env.__BUNDLE_TOKEN` for its `hasToken` field (line 171). `src/runtime.ts`'s `buildBundleContext` reads `env.__BUNDLE_TOKEN` (line 34); `runBundleTurn` reads it for the LLM call (line 272). `src/llm/service-provider.ts` reads `env.__BUNDLE_TOKEN` (line 46) and its file-level docstring at lines 5-6 — which currently contains an explicit "Do NOT use __SPINE_TOKEN here" warning — is rewritten for the unified-token reality. Four test files (`define.test.ts`, `bundle-env.types.test.ts`, `openrouter-integration.test.ts`, plus any stragglers caught by the Phase 8 grep) update their fake `env` stubs and type assertions.
- **Unchanged packages**:
  - `packages/runtime/bundle-registry/` — unchanged. The registry stores metadata; the catalog it stores is consumed by the dispatcher at mint time, but the registry doesn't know about tokens.
  - `packages/runtime/agent-workshop/` — unchanged. Workshop tools do not mint tokens themselves; bundle build/test paths are unaffected by this proposal.
- **Wire-format changes**: `TokenPayload.scope: string[]` is an additive, not-backward-compatible change in the payload JSON. Pre-change tokens verify against the new subkey label fail. Cutover is atomic because there's no token persistence — tokens live for 60s and are regenerated per turn.
- **Env field removal is breaking.** `env.__SPINE_TOKEN`, `env.__LLM_TOKEN`, `env.__TAVILY_TOKEN` are gone. Any bundle author (or capability client author) that reads them gets `undefined`. Only internal consumers read them today (Tavily's client, which ships with CLAW). External bundle authors don't generally touch the double-underscore names.
- **HKDF label removal.** The three per-service label constants (`SPINE_SUBKEY_LABEL`, `LLM_SUBKEY_LABEL`, intended `TAVILY_SUBKEY_LABEL`) are deleted. One new export `BUNDLE_SUBKEY_LABEL` replaces them.
- **Security posture**: equivalent for the realistic threat model. Before: three tokens under three subkeys, each delivered simultaneously to the same bundle isolate with `globalOutbound: null`. A compromised token in the bundle could only reach its own service because the other services' verifiers would fail the HMAC. After: one token under one subkey, delivered to the same isolate, scope-checked on verify. A compromised token reaches every service in its scope list — but every token in its lifetime has the same scope list, so this is what the bundle was authorized for anyway. The attack model where a bundle author carefully steals the spine token and replays it against the LLM service is already blocked by `globalOutbound: null` (no exfiltration path) and the TTL (60s).
- **Hot-path cost**: lower. One mint per turn instead of N. One subkey derivation per DO lifetime instead of N. Wire bytes per turn drop proportionally.
- **Breaking change**: yes, no compat shims. Per CLAUDE.md "Delete old APIs, don't add compat shims." In-flight bundles with old payloads fail verification after the deploy; they re-mint on next turn and succeed.
- **Depends on**: `define-bundle-capability-catalog` having landed. The scope array is derived from `requiredCapabilities` via the validated catalog. Landing order is explicit.
- **Unblocks**: future shape-2 capability rollouts. Each new capability ships its `service`/`client`/`schemas` subpaths without reserving a new `__FOO_TOKEN` env field or a new HKDF label. The entire per-capability security surface is "pick a kebab-case id, add it to your bundle's `requiredCapabilities`, check the scope on verify."
- **Out of scope**:
  - Typed `ctx.capabilities.tavily.search(...)` bundle-side surface. Separate follow-up.
  - Changing the HMAC primitive, TTL, or transport mechanism. All unchanged.
  - Changing budget enforcement or cost emission. Unchanged.
  - Moving `BudgetTracker` or `NonceTracker`. Unchanged.
  - Refactoring the two duplicate dispatch paths (`BundleDispatcher` vs. `initBundleDispatch` inline closure). That's an open architectural question flagged by this proposal but not resolved here — this proposal keeps both in sync.
- **Risk profile**: medium. The change is mechanical and narrow (one payload field, one label, one env field rename, N verify call sites), but it is a breaking change to the core security primitive between bundle and host. The test matrix has to cover scope-denial paths for each service, nonce sharing across services, and cutover semantics.

- **Visible to bundle authors.** `BundleEnv` typed fields change — `__SPINE_TOKEN?` and `__LLM_TOKEN?` are removed; `__BUNDLE_TOKEN?` is added. A bundle written against the pre-change types will not compile against the new SDK — which is the intended breaking signal. Bundles that never read these fields directly (the common case; capabilities handle their own tokens) compile unchanged; only bundle code that explicitly referenced `env.__SPINE_TOKEN` / `env.__LLM_TOKEN` by name sees a type error.

- **Tavily is a bug-fix piggyback.** The existing `TavilyService.verify` at `service.ts:38-39` is a stub comment above an empty check — there is no working Tavily-scoped token today. `packages/capabilities/tavily-web-search/src/client.ts` already reads `env.__SPINE_TOKEN` (lines 33, 46, 70), not a dedicated Tavily token, so every current Tavily call opportunistically reuses the spine token. The `claw/tavily-v1` label and `__TAVILY_TOKEN` field were scoped out of the original Tavily landing with a "full verify in integration" TODO and never wired. This proposal ships a real verify for TavilyService AND unifies the token in the same commit because (a) there is no separate working Tavily-scoped token worth preserving, (b) CLAUDE.md's greenfield stance says no compat shims so staging the two is legacy-code-for-one-release, and (c) the real-verify work and the unify work touch the same three lines of `service.ts` — splitting them would require two edits to the same function body. The consequence is that this proposal's "Tavily migration" is best read as "Tavily gains a working verify for the first time, under the unified-token shape from day one."
