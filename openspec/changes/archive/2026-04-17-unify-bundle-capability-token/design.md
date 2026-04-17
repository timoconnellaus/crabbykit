## The threat model the token is actually defending

Before picking between options, it's worth naming the adversary explicitly, because the "three subkeys" design has accumulated some reasoning that doesn't survive scrutiny.

The bundle is untrusted-but-sandboxed code. It runs in a Worker Loader isolate with `globalOutbound: null`, meaning it cannot make direct outbound network calls. It holds the capability token only as an `env.__X_TOKEN` string. Its only channels to the outside world are the service bindings the host wired in — which is exactly `env.SPINE`, `env.LLM_SERVICE`, and per-capability bindings like `env.TAVILY`.

The token is meant to prevent two things:

1. **A bundle calling a service it wasn't authorized to use.** If a bundle wasn't supposed to call Tavily, it shouldn't be able to. Today this is enforced by the bundle not having `env.TAVILY` bound — no service binding, no call. But once the binding is present (because the host wanted to allow Tavily for *some* bundles), every bundle loaded into that isolate can call it. The token doesn't actually gate service bindings today; the bundle's `bundleEnv` projection does.

2. **A bundle forging identity.** If a bundle claims `aid: "someone-else"`, the receiving service should reject the call. This is the HMAC signature's job. Unchanged.

What the per-service HKDF subkey scheme was supposed to add: if the spine token leaked to an attacker outside the bundle isolate, that attacker couldn't replay it against the LLM service. In practice there is no leak path. The token is injected into the isolate as an env string, never round-trips, and `globalOutbound: null` prevents exfiltration. The bundle can't write it to disk (no disk), can't HTTP it out (no outbound), and can't ship it back through a service binding without the host auditing the RPC. The "compartmentalize the tokens with separate subkeys" defense is defending against a leak that cannot happen.

What the scheme actually costs: three mint calls per turn, three env fields per bundle, three verify paths per service, a dispatcher that has to know about every service at mint time, and a scaling pattern that makes every new shape-2 capability expand the security surface by five items.

The unified token's scope check preserves the useful property (bundle cannot call a service it wasn't authorized to) while deleting the cost. If a bundle declares `[{ id: "tavily-web-search" }]`, its token carries `scope: ["spine", "llm", "tavily-web-search"]`. The Tavily service checks `scope.includes("tavily-web-search")`. The LLM service doesn't care about Tavily. Authorization is explicit, per-service, and at verify time — instead of implicit and at mint time.

## Decisions

### 1. Where does domain separation live post-unification?

**Decision: option (a).** Single HKDF subkey `claw/bundle-v1`. Scope in payload as `scope: string[]`. Each service checks its scope on verify.

Option (b) (one token that verifies under any of N subkeys) was rejected at briefing: it doesn't unify anything — you still have N subkeys and N verify paths — it just shares the payload. No reduction in mint cost, no reduction in wire-size, no reduction in label sprawl. Wrong answer.

Option (c) (single subkey, required `aud` field, one token per service per turn) is a half-measure. You've deleted the HKDF separation but kept the N-mints-per-turn cost. The goal of this proposal is "one mint per turn"; option (c) breaks that at the outset.

Option (a) is the only answer that actually reduces the cost. The objection "a compromised token now authorizes more services" is correct in the abstract but empty in practice, for the reasons in the threat-model section. Blast-radius analysis: a leaked token with `scope: ["spine", "llm", "tavily-web-search"]` lets an attacker replay against all three services until `exp` (60s default). But the bundle *already* had access to all three in the same turn, and the token is regenerated per turn anyway. The attacker with the leaked token gains nothing the bundle didn't already have. Against a realistic adversary (a buggy or compromised bundle), the unified scope is identical to the multi-subkey scheme.

The remaining value of the multi-subkey scheme is symbolic — it expresses "these are distinct authorizations" at the cryptographic layer. We express that at the payload layer instead. Slightly more verbose at verify time (`scope.includes("spine")` vs. relying on HKDF), arguably more explicit.

**Where `BUNDLE_SUBKEY_LABEL` lives.** The string constant `"claw/bundle-v1"` is needed by both the mint half (dispatcher, in `bundle-host`) and the verify half (every host-side service — spine, llm, tavily, and future shape-2 capabilities). Today `SPINE_SUBKEY_LABEL` and `LLM_SUBKEY_LABEL` live next to their WorkerEntrypoint classes in `bundle-host`, which is acceptable because spine/llm services already depend on `bundle-host`. Tavily (and future shape-2 capabilities in `packages/capabilities/*`) cannot take a value-level dep on `bundle-host` without pulling the mint-side API into a package that should only verify. The cleanest placement is `@claw-for-cloudflare/bundle-token` — the verify-only shared package both halves already import from. Export `BUNDLE_SUBKEY_LABEL` from `bundle-token` (sibling to `deriveVerifyOnlySubkey` in `subkey.ts`); both dispatchers import it from there for the mint call; all services import it from there for the verify call. Capabilities only need a `@claw-for-cloudflare/bundle-token: workspace:*` dep to get `verifyToken` + `deriveVerifyOnlySubkey` + the label together — no `bundle-host` dep, which preserves the design invariant that bundle-sdk/bundle-token are the mint-unreachable half. The proposal's earlier phrasing about "re-export `BUNDLE_SUBKEY_LABEL` from `bundle-host`'s barrel" is downgraded to "re-export for backwards-compat with host-side call sites that already import from `bundle-host`"; the authoritative definition lives in `bundle-token`.

### 2. Scope list shape

**Decision: flat `string[]` of kebab-case identifiers.** Reserved strings `"spine"` and `"llm"` for the two core channels. Everything else is a capability id matching a host-side `Capability.id` (already kebab-case by convention, and the catalog proposal input-validated them on the way in).

`"spine"` and `"llm"` are reserved scope strings, not pseudo-capabilities. Rationale: they're not registered as capabilities anywhere, they don't appear in the host's capability registry, and they don't follow the `defineBundleAgent({ capabilities })` pattern. Treating them as pseudo-capabilities would imply the bundle author might list them in `requiredCapabilities` (which they never should — every bundle implicitly uses both). Treating them as reserved strings makes the boundary cleaner: the dispatcher unconditionally prepends them; the author doesn't name them; the catalog validator doesn't see them.

A more structured shape (`{ spine: true, llm: true, capabilities: ["tavily-web-search"] }`) was considered. Rejected: more complex JSON to serialize and compare, harder to grep for, no actual advantage. The flat array is strictly simpler. The only concern with a flat array is collision between a capability id and a reserved scope. With `"spine"` and `"llm"` as the reserved names and kebab-case capability ids as the convention, collision risk is zero in practice — no capability would be named `spine` or `llm`.

**Defense in depth: reject reserved ids at catalog validation.** To make the zero-collision claim load-bearing rather than aspirational, this proposal extends the catalog validator (in both `defineBundleAgent` build-time checks and `BundleRegistry.setActive` promotion-time checks) to reject ids equal to `"spine"` or `"llm"`. The rejection is whole-string equality only — `"spine-agent"` or `"llm-proxy"` are fine, only the exact reserved strings are blocked. Rationale: if a malicious or buggy bundle somehow declared `{ id: "spine" }`, the dispatcher's `scope = ["spine", "llm", ...catalogIds]` computation would duplicate the reserved entry rather than grant new authorization, but the catalog would record a "capability" named `spine` and tooling (`/metadata`, registry listings) would display it as if it were a real capability. The reserved-id rejection closes that display/semantic hole. The companion spec for the catalog capability (`specs/bundle-capability-catalog/spec.md` in this change) captures the declaration-side rule; the `bundle-capability-token` spec captures the token-side invariant that follows from it.

### 3. What tokens does the host mint per turn?

**Decision: exactly one token per turn.** Scope = `["spine", "llm", ...validatedCatalogIds]`. No other tokens. No per-service secondary tokens. The `__BUNDLE_TOKEN` env field is the only token-carrying slot.

Client event dispatch (the `dispatchClientEvent` / inline `bundleClientEventHandler` path, used for steer/abort during a turn) also mints exactly one token with the same scope derivation. Separate mint from the turn-dispatch mint because the timings differ — the client event can arrive mid-turn, before the turn mint's 60s window has elapsed — but same structure.

### 4. Per-service budget preservation

**Decision: unchanged.** The `spineBudget: BudgetTracker` on `AgentRuntime` continues to key on `caller.nonce` and `category`. Each service still reports its own category on the calls it forwards to the DO (SpineService reports `sql`/`kv`/`alarm`/`broadcast` per method; LLM and Tavily emit cost via `spine.emitCost`, which is under `broadcast`).

The unified token carries a single `nonce`, so all three services' calls during a turn share that nonce in the budget. This is the same as today — the budget is already per-turn — and the per-category accounting means SpineService's sql ops don't get crowded out by LlmService's broadcast ops.

No change to `BudgetTracker`, `withSpineBudget`, or the wiring that `move-spine-budget-into-do` landed.

### 5. Nonce uniqueness across services

**Decision: unchanged, and there's no problem to solve.** `NonceTracker` has no production consumers (SpineService and LlmService both skip it explicitly because a single per-turn token carries many RPCs). Shared nonce across services is a non-issue — each tracker instance dedups against its own `consumed` map, so even a hypothetical future service opting in sees each nonce first-time-in-its-own-tracker.

### 6. Migration path

**Decision: breaking change, atomic cutover, no compat shims.**

Per CLAUDE.md, CLAW is greenfield. No `__SPINE_TOKEN` fallback. No dual-issue period during which the dispatcher mints both old-shape and new-shape tokens. No legacy-subkey fallback in the verifier. The cutover is:

1. One release that changes mint, verify, dispatcher, inline dispatch, and Tavily client atomically.
2. Tokens are 60s-lived. After deploy, any in-flight token is rejected within 60s, and the next turn re-mints under the new scheme.
3. No bundle code on disk. Bundles live in R2 bytes + an isolate at dispatch time. After the host redeploys, the next dispatch uses the new env field.

Every file that changes:

- `packages/runtime/bundle-token/src/types.ts` — `TokenPayload.scope: string[]`; `VerifyError.code` union gains `ERR_SCOPE_DENIED`.
- `packages/runtime/bundle-token/src/verify.ts` — `verifyToken` signature gains options object with `requiredScope?: string`; scope check after signature/TTL/nonce checks; returns `ERR_SCOPE_DENIED` on failure. The JSDoc (currently lines 27-30, documenting the now-removed positional `nonceTracker?` parameter) is rewritten to reflect the `VerifyOptions` third arg.
- `packages/runtime/bundle-token/src/subkey.ts` (or a sibling `labels.ts`) — export `BUNDLE_SUBKEY_LABEL = "claw/bundle-v1"` as the canonical home per decision 1 sub-point. Both mint and verify halves import it from here.
- `packages/runtime/bundle-host/src/security/mint.ts` — `MintOptions.scope: string[]` required; payload includes it. Re-export `BUNDLE_SUBKEY_LABEL` from `bundle-token` through the bundle-host barrel so host-side call sites that already import from `bundle-host` keep working.
- `packages/runtime/bundle-host/src/services/spine-service.ts` — `SPINE_SUBKEY_LABEL` renamed to import-rename of `BUNDLE_SUBKEY_LABEL`; `verify` passes `requiredScope: "spine"`.
- `packages/runtime/bundle-host/src/services/llm-service.ts` — `LLM_SUBKEY_LABEL` deleted; service uses `BUNDLE_SUBKEY_LABEL`; `verify` passes `requiredScope: "llm"`.
- `packages/runtime/bundle-host/src/dispatcher.ts` — single `mintToken` call per turn with scope array; writes `env.__BUNDLE_TOKEN`; removes `__SPINE_TOKEN`; no more `SPINE_SUBKEY_LABEL` constant.
- `packages/runtime/agent-runtime/src/agent-do.ts` — `getSpineSubkey` + `getLlmSubkey` collapse to `getBundleSubkey`; two `mintToken` calls collapse to one; `__SPINE_TOKEN` + `__LLM_TOKEN` → `__BUNDLE_TOKEN`; scope derived from validated catalog.
- `packages/runtime/agent-runtime/src/bundle-config.ts` — docstring on `BundleConfig.bundleEnv` updated ("only `__BUNDLE_TOKEN` is injected automatically" instead of listing two).
- `packages/runtime/bundle-sdk/src/types.ts` — `BundleEnv` drops `__SPINE_TOKEN?: string` and `__LLM_TOKEN?: string`; adds `__BUNDLE_TOKEN?: string`. The JSDoc paragraph about "The __SPINE_TOKEN and __LLM_TOKEN fields are reserved..." is rewritten to describe the single unified token.
- `packages/runtime/bundle-sdk/src/define.ts` — `handleTurn` (lines 84-94) currently 401s if either `env.__SPINE_TOKEN` or `env.__LLM_TOKEN` is missing; collapses to a single `env.__BUNDLE_TOKEN` check. The multi-line comment block at lines 84-89 describing the two-token rationale is deleted. `handleSmoke` at line 171 reads `env.__BUNDLE_TOKEN` for its `hasToken` field.
- `packages/runtime/bundle-sdk/src/runtime.ts` — `buildBundleContext` at line 34 reads `env.__BUNDLE_TOKEN`; the error message at line 35 is rewritten. `runBundleTurn` at line 272 reads `env.__BUNDLE_TOKEN` for the LLM call and the error at line 274 is rewritten.
- `packages/runtime/bundle-sdk/src/llm/service-provider.ts` — reads `env.__BUNDLE_TOKEN` at line 46; the file-level docstring at lines 5-6 currently contains an explicit "Do NOT use __SPINE_TOKEN here: SpineService and LlmService verify with different subkeys" warning — that warning is removed and replaced with a note that the unified token carries an `"llm"` scope checked by LlmService. The error message at line 48 is rewritten.
- `packages/runtime/bundle-sdk/src/__tests__/define.test.ts`, `bundle-env.types.test.ts`, `openrouter-integration.test.ts` — every `env: { __SPINE_TOKEN, __LLM_TOKEN }` stub and every type assertion referencing the removed fields is updated to `__BUNDLE_TOKEN` only. Phase 8's audit grep catches any missed hits.
- `packages/capabilities/tavily-web-search/src/service.ts` — deletes `TAVILY_SUBKEY: CryptoKey` from `TavilyServiceEnv`; adds `AGENT_AUTH_KEY: string`; derives subkey lazily with `BUNDLE_SUBKEY_LABEL`; calls `verifyToken(token, subkey, { requiredScope: "tavily-web-search" })`; removes the stub comment.
- `packages/capabilities/tavily-web-search/src/client.ts` — reads `env.__BUNDLE_TOKEN` instead of `env.__SPINE_TOKEN`.
- Tests that mint tokens for test fixtures (search for `mintToken(` in test files) — pass an explicit `scope` array.
- Any `wrangler.jsonc` that declared `TAVILY_SUBKEY` (currently: none verified; an audit in Phase 1 confirms) — delete the binding, wire `AGENT_AUTH_KEY` to the service instead.

### 7. Env variable minting

**Decision: one reserved env field, `__BUNDLE_TOKEN`.** Double-underscore prefix matches the existing convention. Singular "TOKEN" — not "TOKENS" — because there is exactly one per turn.

This is the original motivation for the whole proposal. A single reserved env field means capability client code has a single thing to read:

```ts
const token = env?.__BUNDLE_TOKEN;
if (!token) throw new Error("Missing __BUNDLE_TOKEN");
```

No per-capability token name convention. No "which token do I use for Tavily vs. LLM" cognitive load. Every capability client that needs to call its service reads the same slot.

### 8. Catalog interaction

**Decision: the dispatcher uses the validated catalog to populate scope at mint time.**

The dispatcher already validates the catalog before dispatching (see `validateCatalogCached` in both `BundleDispatcher` and the inline closure in `agent-do.ts`). That validation produces either `{valid: true}` (in which case `validatedVersionId` is set and the bundle's declared ids are trusted) or a mismatch that short-circuits dispatch before any mint happens. By the time the mint call runs, the catalog is known-valid.

Concretely, mint looks like:

```ts
// inside dispatchTurn / bundlePromptHandler, AFTER validateCatalogCached has passed
const version = await registry.getVersion(versionId);
const catalogIds = (version?.metadata?.requiredCapabilities ?? []).map(r => r.id);
const scope = ["spine", "llm", ...catalogIds];
const token = await mintToken({ agentId, sessionId, scope }, bundleSubkey);
```

A bundle that didn't declare `tavily-web-search` gets `scope: ["spine", "llm"]`. Its token calls to `env.TAVILY` are verified by TavilyService, which requires `"tavily-web-search"` in scope, and the call fails with `ERR_SCOPE_DENIED`. The bundle *can't* call Tavily even if the host operator accidentally wired a TAVILY binding into `bundleEnv` — a declaration-free bundle cannot escalate its token scope.

This closes a failure mode the catalog proposal left implicit. The catalog validated "the host supports what the bundle declared" but nothing enforced "the bundle can only use what it declared." The unified token makes the catalog declaration load-bearing at runtime.

**Mid-turn pointer mutation.** An in-flight 60s token honors its as-minted scope. A `notifyBundlePointerChanged` call mid-turn does not retroactively narrow the token's scope — there is no mechanism to revoke a minted token and we are not adding one. The next turn mints a fresh token reflecting the new pointer's catalog. The 60s TTL bounds the staleness window: in the worst case, a bundle whose active version just flipped mid-turn retains its prior scope for up to 60 seconds, then re-mints under the new scope on the subsequent turn. Scope revocation granularity is per-turn, not per-RPC; this is intentional and consistent with the "token is immutable after mint" invariant shared with TTL and nonce handling. Operators who need immediate scope revocation can disable the bundle entirely (`/bundle/disable`), which skips the mint path entirely and falls back to static brain.

### 9. Test surface

Tests to add (minimum):

- **Spine service rejects token scoped only to `["llm"]`.** Mint a token with scope `["llm"]`. Call `SpineService.appendEntry(token, ...)`. Expect `ERR_SCOPE_DENIED`.
- **LLM service rejects token scoped only to `["spine"]`.** Mirror.
- **Tavily service rejects token without `tavily-web-search` scope.** Mint with `scope: ["spine", "llm"]`. Call `TavilyService.search(token, ...)`. Expect `ERR_SCOPE_DENIED`.
- **Tavily service accepts token with `tavily-web-search` scope.** Mint with `scope: ["spine", "llm", "tavily-web-search"]`. Call succeeds end-to-end (mock upstream fetch).
- **Nonce reuse within scope works.** Same token, two calls to the same service. Both succeed (production path: no `NonceTracker`). No cross-call replay interference.
- **Cross-service nonce sharing.** Same token, one call to spine, one to llm. Both succeed. Nonce is the same in both `SpineCaller` contexts — budget tracker dedups correctly by `(nonce, category)`.
- **Expired token rejected by all services.** Mint with `ttlMs: -1000` (past). Each service returns `ERR_TOKEN_EXPIRED` before even reaching scope check.
- **Signature tampering rejected by all services.** Flip a byte in the signature base64url segment. Each service returns `ERR_BAD_TOKEN`.
- **Dispatcher writes `__BUNDLE_TOKEN` only.** Drive `BundleDispatcher.dispatchTurn` with a mock loader; assert the env passed to the loader factory has `__BUNDLE_TOKEN` and does NOT have `__SPINE_TOKEN` / `__LLM_TOKEN` / `__TAVILY_TOKEN`.
- **Inline dispatch writes `__BUNDLE_TOKEN` only.** Mirror in the `bundle-dispatch.test.ts` integration test.
- **Scope derived from catalog.** Bundle declares `[{ id: "tavily-web-search" }]`. Dispatcher mints token, decode payload, assert `scope === ["spine", "llm", "tavily-web-search"]`.
- **Scope omits undeclared capabilities.** Bundle declares nothing. Dispatcher mints token, decode payload, assert `scope === ["spine", "llm"]`. Tavily call with this token fails `ERR_SCOPE_DENIED`.
- **Unknown capability cannot obtain scope.** The catalog proposal already rejects unknown ids at `setActive` and at dispatch-time guard. No new test needed here — the existing catalog test (`bundle-capability-catalog.test.ts` scenario B) covers this. The unified-token proposal assertion is just that the scope array only contains catalog-validated ids, which is true by construction.

## The new `TokenPayload` shape

```ts
// packages/runtime/bundle-token/src/types.ts
export interface TokenPayload {
  /** Agent ID (from mint). */
  aid: string;
  /** Session ID (from mint). */
  sid: string;
  /** Expiration timestamp (ms since epoch). */
  exp: number;
  /** Unique nonce for optional replay protection and budget keying. */
  nonce: string;
  /**
   * Scopes this token authorizes. Reserved: `"spine"`, `"llm"`.
   * Capability scopes are the capability's kebab-case id
   * (e.g. `"tavily-web-search"`). Populated by the dispatcher from the
   * validated capability catalog plus the two reserved core scopes.
   */
  scope: string[];
}

export type VerifyError = {
  valid: false;
  code:
    | "ERR_BAD_TOKEN"
    | "ERR_TOKEN_EXPIRED"
    | "ERR_TOKEN_REPLAY"
    | "ERR_MALFORMED"
    | "ERR_SCOPE_DENIED"; // NEW
};
```

## The new `verifyToken` signature

```ts
export interface VerifyOptions {
  nonceTracker?: NonceTracker;
  /**
   * If provided, `payload.scope` must include this string for the token
   * to verify. Mismatch produces `ERR_SCOPE_DENIED`.
   *
   * Production services pass their service/capability scope:
   *   - SpineService: "spine"
   *   - LlmService: "llm"
   *   - TavilyService: "tavily-web-search"
   *
   * Tests may omit it to exercise signature/TTL semantics in isolation.
   */
  requiredScope?: string;
}

export async function verifyToken(
  token: string,
  subkey: CryptoKey,
  options?: VerifyOptions,
): Promise<VerifyOutcome>;
```

Order of checks inside `verifyToken`:

1. Split on first `.`, base64url-decode halves. Bad → `ERR_MALFORMED`.
2. HMAC verify. Fail → `ERR_BAD_TOKEN`.
3. JSON.parse payload. Fail → `ERR_MALFORMED`.
4. `exp <= Date.now()` → `ERR_TOKEN_EXPIRED`.
5. If `nonceTracker`, `tryConsume(nonce, exp)`. Fail → `ERR_TOKEN_REPLAY`.
6. If `options.requiredScope`, check `payload.scope.includes(options.requiredScope)`. Fail → `ERR_SCOPE_DENIED`.
7. Success → `{ valid: true, payload }`.

Scope check is last so the earlier, cheaper failure modes short-circuit. A malformed token never reaches the scope comparison.

## Mint flow (ASCII)

```
per-turn dispatch:

  agent-do.ts / BundleDispatcher
    │
    ├─ validateCatalogCached(versionId)           [catalog proposal]
    │     └─> { valid: true } (passed)
    │
    ├─ catalogIds = version.metadata.requiredCapabilities.map(r => r.id)
    ├─ scope = ["spine", "llm", ...catalogIds]
    │
    ├─ bundleSubkey = deriveMintSubkey(AGENT_AUTH_KEY, "claw/bundle-v1")  [once, cached]
    ├─ token = await mintToken({ agentId, sessionId, scope }, bundleSubkey)
    │
    └─ loader.get(versionId, () => ({
           env: { ...bundleEnv, __BUNDLE_TOKEN: token },
           globalOutbound: null,
           ...
       }))
```

## Verify flow (ASCII)

```
bundle calls env.SPINE.appendEntry(token, entry)
    │
    ▼
SpineService.appendEntry(token, entry)
    │
    ├─ subkey = deriveVerifyOnlySubkey(AGENT_AUTH_KEY, "claw/bundle-v1") [cached]
    ├─ result = await verifyToken(token, subkey, { requiredScope: "spine" })
    │     ├─ signature ok?            no  → throw SpineError("ERR_BAD_TOKEN")
    │     ├─ exp > now?               no  → throw SpineError("ERR_TOKEN_EXPIRED")
    │     └─ scope.includes("spine")? no  → throw SpineError("ERR_SCOPE_DENIED")
    │
    ├─ caller = { aid, sid, nonce } from result.payload
    └─ return host.spineAppendEntry(caller, entry)       [SpineCaller forwarded to DO]
                                                          [budget tracker on DO side]
```

Same shape for LlmService (`requiredScope: "llm"`) and TavilyService (`requiredScope: "tavily-web-search"`).

## Nonce tracker impact (confirmed none)

`NonceTracker` is a class defined in `packages/runtime/bundle-token/src/verify.ts` (lines 91-143, sibling to `verifyToken` in the same file — there is no separate `nonce-tracker.ts`). It keys on nonce alone and holds `Map<nonce, expiresAt>`. One tracker per consumer. In the current production path no service uses it (spine path explicit, llm path never opted in, tavily path has a stub comment that doesn't invoke it). Shared nonce across services would matter only if two services shared a tracker instance, which they don't.

Test-only consumers (if any) of `NonceTracker` see the same nonce string that the unified token carries. No semantic change: `tryConsume(nonce, exp)` returns `true` the first time, `false` after. A turn that wants single-use-nonce semantics still caps itself at one call per tracker. The same invariant as today.

## Migration impact list (exhaustive)

**Files that move**:
- None. This proposal changes code in place.

**Env fields removed**:
- `__SPINE_TOKEN` — from the bundle isolate's env.
- `__LLM_TOKEN` — same.
- `__TAVILY_TOKEN` — never actually wired, but should be treated as removed so nobody re-introduces it.

**Env fields added**:
- `__BUNDLE_TOKEN` — one slot, replaces the three above.

**HKDF subkey label changes**:
- Delete `SPINE_SUBKEY_LABEL = "claw/spine-v1"`.
- Delete `LLM_SUBKEY_LABEL = "claw/llm-v1"`.
- Delete any (intended) `TAVILY_SUBKEY_LABEL = "claw/tavily-v1"`.
- Add `BUNDLE_SUBKEY_LABEL = "claw/bundle-v1"` exported from `@claw-for-cloudflare/bundle-token` (sibling to `deriveVerifyOnlySubkey` in `subkey.ts`) — the canonical home, since both mint and verify halves need the constant. Re-export from `@claw-for-cloudflare/bundle-host`'s barrel for ergonomics at host-side call sites. Imported directly from `bundle-token` by capability services (Tavily today; shape-2 rollouts tomorrow), which avoids taking a value-level dep on `bundle-host`.

**Wrangler config changes** (examples + test fixtures):
- None expected for the token fields themselves (tokens are Worker Loader env projections, not wrangler bindings).
- Tavily's `TAVILY_SUBKEY: CryptoKey` binding — delete wherever it's declared (audit finds: nowhere in the repo today; the type field is declarative-only). Tavily gains `AGENT_AUTH_KEY: string` wired the same way SpineService and LlmService do.
- Any example `bundleEnv: (env) => ({ ...tokens inserted })` in docs/README — update to mention `__BUNDLE_TOKEN` singular.

**Test call sites**:
- Every `mintToken({ agentId, sessionId })` call — now requires `scope`. Search scope: all test helpers under `packages/runtime/bundle-host/src/__tests__/`, `packages/runtime/agent-runtime/test/`, `packages/capabilities/tavily-web-search/src/__tests__/` (if any).
- Tests that construct a fake `env` with `__SPINE_TOKEN` / `__LLM_TOKEN` — replace with `__BUNDLE_TOKEN`.
- Tests that reference `SPINE_SUBKEY_LABEL` / `LLM_SUBKEY_LABEL` by name — replace with `BUNDLE_SUBKEY_LABEL`.

**Breaking behaviors surfaced to end users**:
- Bundles built against the old API receive `env.__BUNDLE_TOKEN` but not `env.__SPINE_TOKEN`. Capability client code bundled into them will fail to find their tokens. This is the expected failing-loud behavior.
- No compat shim means no grace period. Operators rebuild and redeploy.

## Scope boundaries (what this does NOT do)

- **Does not change the token transport.** Still delivered as a bundle env string. No HTTP headers, no new service-binding field.
- **Does not change the HMAC primitive.** Still HMAC-SHA-256 via HKDF-derived subkey.
- **Does not change TTL.** 60s default, overridable per mint, same as today.
- **Does not change budget enforcement.** Per-DO `BudgetTracker`, keyed on `(nonce, category)`, unchanged.
- **Does not change cost emission.** `spine.emitCost(token, event)` still routes through SpineService, still falls under the `broadcast` budget category.
- **Does not change nonce tracker semantics.** Still verify-time optional, still keyed on nonce alone.
- **Does not introduce typed bundle-side capability clients.** `ctx.capabilities.tavily.search(...)` is a separate follow-up. This proposal just unifies the token.
- **Does not consolidate the two dispatch paths** (`BundleDispatcher` class vs. inline `initBundleDispatch` closure in `agent-do.ts`). Both are updated in lockstep by this proposal, but the architectural question of whether to keep both is out of scope.
- **Does not add scopes for sub-capability gating** (e.g. `tavily-web-search:search` vs. `tavily-web-search:extract`). The scope is per-capability, not per-method. A capability that wants per-method gating can do it internally without a protocol change.
- **Does not add dynamic scope revocation.** A token's scope is fixed at mint. If the host decides mid-turn that the bundle lost authorization for Tavily, the next mint (next turn) will reflect it; the current turn's token is honored to its TTL.

## Token size

Worst-case payload analysis, to confirm the unified token does not blow past any env-injection size ceiling.

**Inputs** (from the catalog validator in `define-bundle-capability-catalog/specs/bundle-capability-catalog/spec.md`):

- Capability id regex `/^[a-z][a-z0-9-]*[a-z0-9]$/`; max length 64 characters.
- Max capability count: 64 entries.
- Reserved scopes: `"spine"` (5 bytes) + `"llm"` (3 bytes), always present.

**JSON encoding of the worst-case `scope` array** (64 max-length 64-char ids plus two reserved):

- Each id is serialized as `"<64 chars>"` — 66 bytes including the surrounding double quotes.
- 64 ids joined by `,` → 64 × 66 + 63 commas = 4224 + 63 = 4287 bytes.
- Plus two reserved: `"spine"` (7) + `,` + `"llm"` (5) + `,` = 7 + 1 + 5 + 1 = 14 bytes prepended.
- Array brackets `[` `]`: +2.
- Total `scope` JSON bytes: 14 + 4287 + 2 = **~4303 bytes**.

**Fixed-width payload overhead**:

- `"aid":"<36-char uuid or dohex>"`: ~50 bytes (dohex is 64 hex chars → ~80 bytes worst case; budget 80).
- `"sid":"<ulid>"`: ~35 bytes.
- `"exp":<13-digit ms timestamp>`: 20 bytes.
- `"nonce":"<36-char uuid>"`: 47 bytes.
- Field separators + outer braces: ~12 bytes.
- Fixed overhead: **~194 bytes**.

**Raw JSON payload worst case**: 4303 + 194 = **~4500 bytes**.

**Base64url-encoded payload**: 4500 × 4/3 ≈ **~6000 bytes**, no padding.

**HMAC-SHA-256 signature**: 32 bytes → base64url 43 bytes.

**Total token string** (`base64url(payload).base64url(signature)`): ~6000 + 1 + 43 = **~6044 bytes**.

**Typical case** (1-3 capabilities, which is what every real-world bundle will ship): `scope` JSON ≈ 50-150 bytes; total token ≈ **350-500 bytes**. Comparable to a JWT.

**Headroom vs. transport constraints**: Worker Loader injects `__BUNDLE_TOKEN` as a string value on the bundle isolate's env. Cloudflare does not publish an explicit env-binding-value size limit for Worker Loader, but the structured-clone path used to project the env has no documented cap below typical Worker request limits (100 MiB). The ~6 KB worst case sits well below any conservative 8 KB HTTP-header-style ceiling and multiple orders of magnitude below the 100 MiB request ceiling; there is no realistic scenario where a max-catalog bundle approaches a size constraint. Typical tokens remain JWT-sized.

**Assertion**: Max token byte size (all 64 capability entries at max-length kebab-case ids) is approximately **6 KB**. Assumed headroom is **~2 KB** against a conservative 8 KB byte ceiling; effectively unbounded against the actual 100 MiB Workers request ceiling.

## Risks and mitigations

1. **The two dispatch paths drift.** Changing both `BundleDispatcher` and the inline `initBundleDispatch` closure in lockstep is error-prone. Mitigation: an integration test exercises each path's bundle env contents explicitly, asserting identical shape (only `__BUNDLE_TOKEN`, no stray `__SPINE_TOKEN`). Any future drift in how tokens are projected fails this test.

2. **Scope check order-sensitivity.** Placing the scope check AFTER signature and TTL means a caller with an expired unified token sees `ERR_TOKEN_EXPIRED` regardless of scope, which is the correct priority. A caller with a wrong-scope token sees `ERR_SCOPE_DENIED` instead of leaking the fact that the token is valid-but-wrong-for-this-service. Intentional: the bundle is already trusted to know what it's authorized for (the scope list is in its own token), so leaking the scope-denial doesn't disclose anything new.

3. **Bundle authors reading undocumented env.** A bundle that explicitly reads `env.__SPINE_TOKEN` (e.g. a third-party capability author who went digging) gets `undefined` after this change. Mitigation: release notes + CLAUDE.md update calling out the rename. Tavily is the only in-tree consumer and we change it in the same commit.

4. **The `ERR_SCOPE_DENIED` code needs to round-trip across the RPC boundary.** `SpineError` forwards known codes; we add `ERR_SCOPE_DENIED` to the `SpineErrorCode` union. `LlmService` throws plain `Error` with `ERR_SCOPE_DENIED` as the message — same pattern as other codes. Tavily mirrors.

5. **Tests that hard-code subkey labels.** A grep for `"claw/spine-v1"` / `"claw/llm-v1"` in tests will find them; each reference gets updated to `"claw/bundle-v1"` (or better, imported from `BUNDLE_SUBKEY_LABEL`).

6. **Key rotation semantics unchanged.** Rotate `AGENT_AUTH_KEY` as before; the unified subkey (`claw/bundle-v1`) re-derives on next call in every service and every dispatcher (each has its own lazy cache keyed on the subkey, not on the master). No per-service coordination needed — there's only one subkey now, so rotation is strictly simpler than pre-change.

7. **Fix stops fewer holes than it sounds.** Only blocks a scope-denied call at the individual service's verify point. A bundle that doesn't have Tavily in scope but has `env.TAVILY` wired in its bundle env can still invoke `env.TAVILY.search(garbage, ...)` and reach Tavily's code; the verify call rejects it with `ERR_SCOPE_DENIED` before any real work. The guarantee is "scope-denied calls never reach the provider API," not "scope-denied calls never cross the service binding." The latter requires bundle-env projection to be catalog-aware too — out of scope for this proposal; the test surface covers the former.

## Where this lands in the sequence

After `define-bundle-capability-catalog` (landed) and `move-spine-budget-into-do` (in flight but orthogonal). Does not block or depend on `switch-spine-bridge-to-direct-rpc` which already landed.

Recommended ordering: land this in the current wave of bundle security refinements while the catalog work is fresh in memory. The scope array in the token payload is a direct read of the catalog declaration; doing them in one mental model reduces the chance of a subtle mistake.
