## 1. Phase 1 — Preflight

- [x] 1.1 Confirm `define-bundle-capability-catalog` has landed. `BundleAgentSetup.requiredCapabilities` is exported from `bundle-sdk`; `BundleMetadata.requiredCapabilities` is persisted into the registry; `BundleDispatcher` and the inline `initBundleDispatch` closure both run a catalog guard and cache `validatedVersionId`. Grep: `grep -rn "validatedVersionId" packages/runtime/bundle-host/src packages/runtime/agent-runtime/src` — hits in both dispatch paths.
- [x] 1.2 Confirm `move-spine-budget-into-do` status. This proposal does NOT depend on it, but the `AgentRuntime.spineBudget` field and `SpineCaller` context are adjacent. If move-spine-budget is in flight, rebase on its interface. If not yet landed, this proposal works against the pre-change signatures (identity extracted in SpineService, passed positionally to the DO).
- [x] 1.3 Run `bun run typecheck && bun run lint && bun run test` from repo root — clean baseline. Capture pre-existing flakes (miniflare flakes in bundle-registry / cloudflare-sandbox / e2e; the `plan-mode.test.ts` `readFileSync` issue). These are pre-existing and are not attributed to this change downstream.
- [x] 1.4 `grep -rn "__SPINE_TOKEN\|__LLM_TOKEN\|__TAVILY_TOKEN" packages/ examples/` — capture every read and write site. Expect: mint sites in `dispatcher.ts` and `agent-do.ts`; read sites in `tavily-web-search/src/client.ts`; tests under `bundle-host/src/__tests__/` and `agent-runtime/test/`; docstring references in `bundle-config.ts` and example `bundleEnv` docs. Track the list — Phase 7 grep-checks it returns zero hits.
- [x] 1.5 `grep -rn "claw/spine-v1\|claw/llm-v1\|claw/tavily-v1\|SPINE_SUBKEY_LABEL\|LLM_SUBKEY_LABEL\|TAVILY_SUBKEY_LABEL" packages/` — every subkey-label reference. Phase 7 grep-checks that zero of these survive.
- [x] 1.6 `grep -rn "TAVILY_SUBKEY" packages/` — should hit only `tavily-web-search/src/service.ts` (the declarative `TAVILY_SUBKEY: CryptoKey` env field) and possibly a wrangler example. Confirm no runtime code actually *uses* the field (it's a declared-but-unread hole today); Phase 5 deletes it.
- [x] 1.7 Read `packages/runtime/bundle-token/src/verify.ts` and confirm `verifyToken` currently takes `(token, subkey, nonceTracker?)`. The Phase 2 signature change must preserve every current call site's behavior when the new `requiredScope` option is omitted.
- [x] 1.8 Open `packages/capabilities/tavily-web-search/src/service.ts` and confirm the token-verification stub comment at lines 38-39 ("Token verification would happen here via TAVILY_SUBKEY (simplified for initial implementation — full verify in integration)"). Phase 6 deletes the stub and replaces it with a real verify call.

## 2. Phase 2 — Widen `bundle-token` payload and verify signature

Single-commit phase. All edits inside `packages/runtime/bundle-token/`.

- [x] 2.1 In `src/types.ts`, add `scope: string[]` to `TokenPayload`:
  ```ts
  export interface TokenPayload {
    aid: string;
    sid: string;
    exp: number;
    nonce: string;
    /** Scopes this token authorizes. Reserved: "spine", "llm". Capability
     *  scopes use the capability's kebab-case id. */
    scope: string[];
  }
  ```
- [x] 2.2 In `src/types.ts`, extend `VerifyError.code` union with `"ERR_SCOPE_DENIED"`. Update JSDoc to describe the new code.
- [x] 2.3 In `src/verify.ts`, change the `verifyToken` signature from `(token, subkey, nonceTracker?)` to `(token, subkey, options?: VerifyOptions)`:
  ```ts
  export interface VerifyOptions {
    nonceTracker?: NonceTracker;
    /** Required scope; `payload.scope.includes(requiredScope)` must be true. */
    requiredScope?: string;
  }
  ```
  The positional `nonceTracker?` parameter is deleted — no overload, no compat shim. Every existing caller passes either nothing or an options-form.
- [x] 2.4 Insert the scope check as step 6 in `verifyToken`:
  ```ts
  if (options?.requiredScope) {
    if (!Array.isArray(payload.scope) || !payload.scope.includes(options.requiredScope)) {
      return { valid: false, code: "ERR_SCOPE_DENIED" };
    }
  }
  ```
  Position: AFTER signature/TTL/nonce checks, so earlier cheaper failures short-circuit and `ERR_SCOPE_DENIED` is only surfaced for tokens that are otherwise valid.
- [x] 2.5 Update the `VerifyResult` JSDoc in `src/types.ts` to reflect that `payload` carries `scope`.
- [x] 2.5b Rewrite the JSDoc on `verifyToken` itself (currently lines 27-30 in `src/verify.ts`) — the existing comment documents a positional `nonceTracker?: NonceTracker` third parameter that no longer exists. Replace with the new three-param contract: `token`, `subkey`, `options?: VerifyOptions`. Document each option field (`nonceTracker`, `requiredScope`) and the error codes the function returns. The outdated `@param nonceTracker` line is deleted.
- [x] 2.5c Export `BUNDLE_SUBKEY_LABEL = "claw/bundle-v1"` from `@crabbykit/bundle-token`. Concrete placement: add to `src/subkey.ts` (sibling to `deriveVerifyOnlySubkey`); re-export through `src/index.ts`. Rationale: both mint (bundle-host) and verify (every service) sides need the constant, and capabilities that verify SHOULD depend only on `bundle-token` (not `bundle-host`, which would pull the mint-side API into a package that only verifies). Placing the label in `bundle-token` keeps capabilities on a single `bundle-token` dep. See design decision 1 sub-point.
- [x] 2.5d **Catalog validator: reject reserved scope strings.** Amend the `requiredCapabilities` entry validator in `@crabbykit/bundle-sdk` (the build-time check inside `defineBundleAgent`) to reject ids equal to `"spine"` or `"llm"` with an error naming the reserved-scope collision. Mirror the same check in `@crabbykit/bundle-registry`'s `setActive` catalog validation so that a metadata record bypassing build-time validation is still rejected at promotion time (the reserved-id check runs independently of `skipCatalogCheck` — see companion `specs/bundle-capability-catalog/spec.md`). Unit tests: declare `[{ id: "spine" }]` → throw; declare `[{ id: "llm" }]` → throw; declare `[{ id: "spine-like" }]` → accepted (prefix match only, not whole-string equality). Rationale: closes the collision loophole where a bundle could obtain a reserved-scope authorization via a capability declaration (see design decision 2 and spec requirement "Reserved scope strings SHALL NOT be used as capability ids").
- [x] 2.6 Unit tests in `src/__tests__/verify.test.ts` (or a new `scope.test.ts`):
  - Token with `scope: ["spine"]` verifies with `requiredScope: "spine"` → valid.
  - Token with `scope: ["spine"]` verifies with `requiredScope: "llm"` → `ERR_SCOPE_DENIED`.
  - Token with `scope: []` verifies with `requiredScope: "spine"` → `ERR_SCOPE_DENIED`.
  - Token with `scope: ["spine", "llm", "tavily-web-search"]` verifies with each of those as `requiredScope` → all valid.
  - Token with no `requiredScope` option → scope check skipped, valid even if `scope` is empty.
  - Signature-tampered token with otherwise-valid scope → `ERR_BAD_TOKEN` (signature checked first).
  - Expired token with otherwise-valid scope → `ERR_TOKEN_EXPIRED` (TTL checked before scope).
  - Nonce-replay with otherwise-valid scope → `ERR_TOKEN_REPLAY` (nonce checked before scope).
- [x] 2.7 `cd packages/runtime/bundle-token && bun run typecheck && bun run test` — PASS. `bundle-token` still exports no mint functions (`grep -rn "mintToken\|mintTokenFor\|sign.*payload" src/` — zero hits). Verify-only invariant preserved.
- [x] 2.8 Commit: "feat(bundle-token): add scope field and requiredScope option to verify"

## 3. Phase 3 — Mint side gains required `scope` parameter

Single-commit phase. All edits inside `packages/runtime/bundle-host/`.

- [x] 3.1 In `src/security/mint.ts`, add `scope: string[]` to `MintOptions` (required, not optional):
  ```ts
  export interface MintOptions {
    agentId: string;
    sessionId: string;
    scope: string[];
    ttlMs?: number;
  }
  ```
- [x] 3.2 In `mintToken`, include `scope: opts.scope` in the constructed payload:
  ```ts
  const payload: TokenPayload = {
    aid: opts.agentId,
    sid: opts.sessionId,
    exp: Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
    nonce: crypto.randomUUID(),
    scope: opts.scope,
  };
  ```
- [x] 3.3 `BUNDLE_SUBKEY_LABEL` is now defined in `@crabbykit/bundle-token` (see task 2.5c). Re-export it from `@crabbykit/bundle-host`'s barrel (`src/index.ts`) so existing host-side call sites that already import from `bundle-host` keep compiling — the authoritative definition is `bundle-token`, but host-side code can import it from either package.
- [x] 3.4 Delete `SPINE_SUBKEY_LABEL` constant wherever it currently lives in `bundle-host/src/services/spine-service.ts` (line 36 as of this writing). Delete `LLM_SUBKEY_LABEL` in `bundle-host/src/services/llm-service.ts` (line 14). Delete the `SPINE_SUBKEY_LABEL` import in `bundle-host/src/dispatcher.ts` and the local redeclaration at line 15.
- [x] 3.5 Already handled in 3.3. Capability services import `BUNDLE_SUBKEY_LABEL` directly from `@crabbykit/bundle-token` (no `bundle-host` value dep needed at the capability layer). The inline dispatch closure in `agent-do.ts` may import from either; prefer `bundle-host` for symmetry with its `mintToken` / `deriveMintSubkey` imports.
- [x] 3.6 Unit test in `src/security/__tests__/mint.test.ts` (or wherever existing mint tests live):
  - `mintToken({ agentId, sessionId, scope: ["spine"] }, subkey)` produces a token whose payload (decoded without verification for test purposes) contains `scope: ["spine"]`.
  - `mintToken` with empty `scope: []` succeeds (no implicit scope).
  - Omitting `scope` is a TypeScript error (test by `@ts-expect-error`).
- [x] 3.7 `cd packages/runtime/bundle-host && bun run typecheck` — EXPECT FAILURES in `spine-service.ts`, `llm-service.ts`, and `dispatcher.ts` because they still reference the deleted `SPINE_SUBKEY_LABEL` / `LLM_SUBKEY_LABEL`. This is the atomic-migration property. Phase 4+ fix each caller.
- [x] 3.8 Do NOT commit at end of Phase 3. Phases 3-7 form an atomic breaking change and land together. (Rationale: deleting per-service labels in Phase 3 leaves the tree broken; committing partial state would leave the trunk un-buildable.)

**Alternative:** If single-commit atomicity is too large to review, an earlier-but-compatible commit point is end of Phase 2. Phases 3-7 still land together. See Phase 8 for the final commit structure.

## 4. Phase 4 — Migrate SpineService to `BUNDLE_SUBKEY_LABEL` and `requiredScope: "spine"`

- [x] 4.1 Open `packages/runtime/bundle-host/src/services/spine-service.ts`.
- [x] 4.2 Replace the deleted `SPINE_SUBKEY_LABEL = "claw/spine-v1"` import with `import { BUNDLE_SUBKEY_LABEL } from "../security/mint.js"` (or from the barrel).
- [x] 4.3 Update `getSubkey()` to derive from `BUNDLE_SUBKEY_LABEL` instead of the deleted constant.
- [x] 4.4 In `verify(token)`, change the verify call from `verifyToken(token, subkey)` to `verifyToken(token, subkey, { requiredScope: "spine" })`.
- [x] 4.5 Add `"ERR_SCOPE_DENIED"` to the `SpineErrorCode` union (currently lines 40-48). The `result.code as SpineErrorCode` cast at line 119 then covers it without additional logic.
- [x] 4.6 Update the JSDoc on `verify` — remove the legacy comment about "cached for the life of the WorkerEntrypoint instance" being subkey-cache-specific (it's still accurate, but the label context has changed); confirm it still reads coherently. Update the class-level JSDoc where it references the `"claw/spine-v1"` label — replace with `"claw/bundle-v1"` + scope-check note.
- [x] 4.7 `cd packages/runtime/bundle-host && bun run typecheck` — SpineService compiles cleanly. LlmService and dispatcher still broken; fixed in Phase 5 and 7.

## 5. Phase 5 — Migrate LlmService to `BUNDLE_SUBKEY_LABEL` and `requiredScope: "llm"`

- [x] 5.1 Open `packages/runtime/bundle-host/src/services/llm-service.ts`.
- [x] 5.2 Replace the deleted `LLM_SUBKEY_LABEL = "claw/llm-v1"` with an import of `BUNDLE_SUBKEY_LABEL`.
- [x] 5.3 Update `getSubkey()` to use `BUNDLE_SUBKEY_LABEL`.
- [x] 5.4 In both `infer(token, request)` and `inferStream(token, request)`, change `verifyToken(token, subkey)` to `verifyToken(token, subkey, { requiredScope: "llm" })`.
- [x] 5.5 On scope-denied: the existing code calls `throw new Error(result.code)` when `result.valid === false`. With the new code `"ERR_SCOPE_DENIED"` added to `VerifyError`, the throw already propagates the right string. No additional error handling needed.
- [x] 5.6 Update the JSDoc on `getSubkey` — remove the HKDF-label comment referencing `claw/llm-v1`. Replace with a note that the label is the shared `claw/bundle-v1`.
- [x] 5.7 Update the JSDoc on the `LlmEnv` interface — the doc comment on `AGENT_AUTH_KEY` currently says `claw/llm-v1`; replace with the unified label.
- [x] 5.8 `cd packages/runtime/bundle-host && bun run typecheck` — LlmService compiles cleanly.

## 6. Phase 6 — Give Tavily a real verify (first time) and migrate it to `BUNDLE_SUBKEY_LABEL` + `requiredScope: "tavily-web-search"`

This phase is best read as "Tavily ships a working token verify for the first time, under the unified token shape from day one." There is no working `claw/tavily-v1`-scoped token to migrate FROM: the service's current `verify` at `service.ts:38-39` is a stubbed comment above an empty check, and the client (`client.ts:33, 46, 70`) currently reads `__SPINE_TOKEN` opportunistically because no dedicated Tavily token was ever wired. Per CLAUDE.md's greenfield stance — no compat shims — the real-verify work and the unify work land in the same commit touching the same three lines of `service.ts`.

- [x] 6.0 **Workspace dependency wiring (must run before any import work in 6.4/6.5).** Edit `packages/capabilities/tavily-web-search/package.json` — add `"@crabbykit/bundle-token": "workspace:*"` to `dependencies`. Do NOT add a dep on `@crabbykit/bundle-host` (capabilities are verify-only; the label and verify primitives both live in `bundle-token` per design decision 1 sub-point and task 2.5c). Run `bun install` from the repo root so the workspace symlink materializes before the `service.ts` imports resolve.
- [x] 6.1 Open `packages/capabilities/tavily-web-search/src/service.ts`.
- [x] 6.2 Update `TavilyServiceEnv`:
  - DELETE `TAVILY_SUBKEY: CryptoKey` — the field was declaratively present but never populated at runtime. Same pattern as the `SPINE_SUBKEY: CryptoKey` / `LLM_SUBKEY: CryptoKey` fields that the services already fixed by switching to `AGENT_AUTH_KEY: string` + lazy HKDF derivation.
  - ADD `AGENT_AUTH_KEY: string` with a JSDoc matching the SpineEnv / LlmEnv docs.
- [x] 6.3 Add a private `subkeyPromise: Promise<CryptoKey> | null = null` field on `TavilyService`, mirroring the pattern in `SpineService.getSubkey()`.
- [x] 6.4 Add a private `getSubkey()` method that lazy-derives via `deriveVerifyOnlySubkey(this.env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL)`. Import both `deriveVerifyOnlySubkey` and `BUNDLE_SUBKEY_LABEL` from `@crabbykit/bundle-token`. Do not import from `@crabbykit/bundle-host` here — that would pull mint-side API into a capability that only verifies.
- [x] 6.5 Replace the stub comment ("Token verification would happen here via TAVILY_SUBKEY") and the empty verify at lines 38-39 with a real verify:
  ```ts
  const subkey = await this.getSubkey();
  const result = await verifyToken(token, subkey, { requiredScope: "tavily-web-search" });
  if (!result.valid) {
    throw new Error(result.code);
  }
  ```
  Apply to both `search(token, args, schemaHash?)` and `extract(token, args, schemaHash?)`.
- [x] 6.6 Open `packages/capabilities/tavily-web-search/src/client.ts`. Change `env.__SPINE_TOKEN` to `env.__BUNDLE_TOKEN` in both tool handlers (lines 33, 46, 70 as of this writing). Update the error message `"Missing __SPINE_TOKEN"` → `"Missing __BUNDLE_TOKEN"`. Update the module JSDoc at the top: "Reads the capability token from env.__SPINE_TOKEN" → "Reads the capability token from env.__BUNDLE_TOKEN."
- [x] 6.7 `cd packages/capabilities/tavily-web-search && bun run typecheck` — PASS.
- [x] 6.8 Unit tests for `TavilyService.verify` path: valid token with `"tavily-web-search"` scope succeeds; token without the scope throws `ERR_SCOPE_DENIED`; expired token throws `ERR_TOKEN_EXPIRED`.

## 7. Phase 7 — `bundle-sdk` author-surface migration

The proposal's earliest drafts called `bundle-sdk` "unchanged." It is not. `BundleEnv` exposes the token env fields as public typed surface, and the four source files under `bundle-sdk/src/` that read or describe those fields all reference `__SPINE_TOKEN` / `__LLM_TOKEN` by name. This phase migrates the bundle authoring package to the unified `__BUNDLE_TOKEN` field atomically with the dispatcher work in Phase 8.

Acceptance gate: `bun run --cwd packages/runtime/bundle-sdk typecheck && bun run --cwd packages/runtime/bundle-sdk test` passes with all references to `__SPINE_TOKEN` / `__LLM_TOKEN` deleted.

- [x] 7.1 **`src/types.ts` — `BundleEnv` typed fields.** Drop `__SPINE_TOKEN?: string;` and `__LLM_TOKEN?: string;` from the `BundleEnv` interface (lines 32-36 as of this writing). Add `__BUNDLE_TOKEN?: string;` in their place. Rewrite the JSDoc paragraph on lines 26-30 (the "The `__SPINE_TOKEN` and `__LLM_TOKEN` fields are reserved..." block) to describe the unified token: single reserved field injected by the dispatcher, carrying the per-turn HMAC token whose payload `scope` array lists which services it authorizes.
- [x] 7.2 **`src/define.ts` — `handleTurn` 401 checks.** Delete the multi-line comment block at lines 84-89 (the "__SPINE_TOKEN authenticates...__LLM_TOKEN is a separate capability token..." block — obsolete under the unified token). Collapse the two 401 checks at lines 90-95 into a single check on `env.__BUNDLE_TOKEN`. The 401 response body becomes `{ error: "Missing __BUNDLE_TOKEN" }`.
- [x] 7.3 **`src/define.ts` — `handleSmoke`.** At line 171, change `hasToken: Boolean(env.__SPINE_TOKEN)` to `hasToken: Boolean(env.__BUNDLE_TOKEN)`.
- [x] 7.4 **`src/runtime.ts` — `buildBundleContext`.** At line 34, replace `env.__SPINE_TOKEN` with `env.__BUNDLE_TOKEN`. Update the error message at line 35 from `"Missing __SPINE_TOKEN"` to `"Missing __BUNDLE_TOKEN"`.
- [x] 7.5 **`src/runtime.ts` — `runBundleTurn` LLM token read.** At line 272, replace `env.__LLM_TOKEN` with `env.__BUNDLE_TOKEN`. Rename the local `llmToken` variable → `bundleToken` for clarity (it's no longer LLM-specific). Update the error at line 274 (`"Missing __LLM_TOKEN in bundle env"` → `"Missing __BUNDLE_TOKEN in bundle env"`). At line 299, the `llm.inferStream(llmToken, ...)` call reads from the renamed variable.
- [x] 7.6 **`src/llm/service-provider.ts` — file-level docstring.** Lines 5-6 currently contain an explicit warning: "Reads the capability token from env.__LLM_TOKEN — a per-service token signed with the LLM HKDF subkey. Do NOT use __SPINE_TOKEN here: SpineService and LlmService verify with different subkeys, so mixing tokens fails with ERR_BAD_TOKEN." This is false under the unified token. Rewrite to: "Reads the capability token from env.__BUNDLE_TOKEN — a per-turn unified token whose payload carries a `scope: string[]`. LlmService verifies with `requiredScope: \"llm\"`; the dispatcher unconditionally prepends `\"llm\"` to every minted token's scope." Remove the warning paragraph about "different subkeys" entirely.
- [x] 7.7 **`src/llm/service-provider.ts` — token read.** At line 46, replace `env.__LLM_TOKEN` with `env.__BUNDLE_TOKEN`. Update the error at line 48 (`"Missing __LLM_TOKEN — cannot call LlmService without a token"` → `"Missing __BUNDLE_TOKEN — cannot call LlmService without a token"`).
- [x] 7.8 **Tests.** Scan `packages/runtime/bundle-sdk/src/__tests__/` for every reference to the removed fields:
  - `define.test.ts` — every fake `env` fixture with `__SPINE_TOKEN` / `__LLM_TOKEN` collapses to one `__BUNDLE_TOKEN` entry. 401 assertions updated.
  - `bundle-env.types.test.ts` — any `ValidateBundleEnv<...>` assertion that mentions the removed fields is updated; add a positive assertion that `__BUNDLE_TOKEN?: string` is accepted.
  - `openrouter-integration.test.ts` — the fake `env` passed to `createServiceLlmProvider` / bundle fetch handler uses `__BUNDLE_TOKEN`.
  - Any other hits found by `bun run --cwd packages/runtime/bundle-sdk grep '__SPINE_TOKEN\|__LLM_TOKEN' src/` are updated.
- [x] 7.9 `bun run --cwd packages/runtime/bundle-sdk typecheck && bun run --cwd packages/runtime/bundle-sdk test` — PASS. This is the acceptance gate for the phase.

## 8. Phase 8 — Unify dispatcher mint calls + remove per-service env fields

- [x] 8.1 Open `packages/runtime/bundle-host/src/dispatcher.ts` (BundleDispatcher — the test/reference path).
- [x] 8.2 Remove the local `SPINE_SUBKEY_LABEL` constant at line 15. Replace `spineSubkey` private field with `bundleSubkey`. Replace the `ensureInitialized` line that derives from `SPINE_SUBKEY_LABEL` with `BUNDLE_SUBKEY_LABEL`:
  ```ts
  if (!this.bundleSubkey) {
    this.bundleSubkey = await deriveMintSubkey(this.masterKey, BUNDLE_SUBKEY_LABEL);
  }
  ```
- [x] 8.3 In `dispatchTurn`, compute the scope array before the mint call:
  ```ts
  const version = await this.registry?.getVersion?.(versionId);
  const catalogIds = (version?.metadata?.requiredCapabilities ?? []).map(r => r.id);
  const scope = ["spine", "llm", ...catalogIds];
  const token = await mintToken({ agentId: this.agentId, sessionId, scope }, this.bundleSubkey!);
  ```
  Rationale: the catalog validation already ran via `validateCatalogCached` upstream in this method (Phase 5 of the catalog proposal). By the time we reach mint, the catalog is valid, so the ids can be read directly into scope.
- [x] 8.4 Replace `env: { ...bundleEnv, __SPINE_TOKEN: token }` at line 284 with `env: { ...bundleEnv, __BUNDLE_TOKEN: token }`. Same at line 349 in `dispatchClientEvent`.
- [x] 8.5 Open `packages/runtime/agent-runtime/src/agent-do.ts` and the `_initBundleDispatch` closure starting ~line 480.
- [x] 8.6 Collapse `getSpineSubkey` and `getLlmSubkey` (lines 506-524) into a single `getBundleSubkey`:
  ```ts
  let bundleSubkeyPromise: Promise<CryptoKey> | null = null;
  const getBundleSubkey = async (): Promise<CryptoKey> => {
    if (!bundleSubkeyPromise) {
      bundleSubkeyPromise = (async () => {
        const { deriveMintSubkey, BUNDLE_SUBKEY_LABEL } = await import("@crabbykit/bundle-host");
        return deriveMintSubkey(masterKey, BUNDLE_SUBKEY_LABEL);
      })();
    }
    return bundleSubkeyPromise;
  };
  ```
- [x] 8.7 In `bundlePromptHandler` (the production turn handler, ~line 744), replace the two-mint block (lines 778-786) with one mint:
  ```ts
  const bundleSubkey = await getBundleSubkey();
  const { mintToken } = await import("@crabbykit/bundle-host");
  const version = await registry.getVersion?.(versionId);
  const catalogIds = (version?.metadata?.requiredCapabilities ?? []).map(r => r.id);
  const scope = ["spine", "llm", ...catalogIds];
  const token = await mintToken({ agentId, sessionId, scope }, bundleSubkey);
  ```
  Replace the `env: { ...projectedEnv, __SPINE_TOKEN: spineToken, __LLM_TOKEN: llmToken }` block (lines 809-813) with `env: { ...projectedEnv, __BUNDLE_TOKEN: token }`.
- [x] 8.8 In `bundleClientEventHandler` (~line 866), mirror the same change: single mint + single env field (lines 874-895).
- [x] 8.9 Open `packages/runtime/agent-runtime/src/bundle-config.ts`. Update the docstring on `BundleConfig.bundleEnv` (lines 204-209) from "__SPINE_TOKEN and __LLM_TOKEN are injected automatically" to "__BUNDLE_TOKEN is injected automatically. Native bindings that aren't structured-cloneable cause DataCloneError → fallback to static brain."
- [x] 8.10 `bun run typecheck` from repo root — PASS. At this point the mint, verify, dispatch, and capability paths are all unified. The tree is buildable.

## 9. Phase 9 — Integration tests for the unified token

- [x] 9.1 Open `packages/runtime/agent-runtime/test/integration/bundle-dispatch.test.ts`. Every test that mints a token currently passes `{ agentId, sessionId }`; update to pass `{ agentId, sessionId, scope: [...] }` — with appropriate scope for each test case.
- [x] 9.2 Update every test helper and integration test that constructs a fake `env` with `__SPINE_TOKEN` / `__LLM_TOKEN` to use `__BUNDLE_TOKEN`. This audit list is exhaustive against the Phase 1.4 baseline grep — every file listed here must be visited. If a file not listed here shows a hit, append it and visit it. **In `packages/runtime/`:**
  - `packages/runtime/agent-runtime/src/test-helpers/test-bundle-agent-do.ts`
  - `packages/runtime/agent-runtime/test/helpers/bundle-client.ts`
  - `packages/runtime/agent-runtime/test/fixtures/bundle-sources.ts`
  - `packages/runtime/agent-runtime/test/integration/bundle-dispatch.test.ts`
  - `packages/runtime/agent-runtime/test/integration/bundle-spine-bridge.test.ts` — grep confirms a documentation comment at line 7 references `__SPINE_TOKEN`; the test body also references it where the bundle env is projected.
  - `packages/runtime/bundle-host/src/__tests__/bundle-dispatcher-integration.test.ts` — 12 occurrences per the audit grep.
  - `packages/runtime/bundle-host/src/__tests__/llm-service-providers.test.ts` — covers `claw/llm-v1` references and LLM token stubs.
  - `packages/runtime/bundle-host/src/__tests__/dispatcher.test.ts` (if present).
  - `packages/runtime/bundle-host/src/security/__tests__/mint.test.ts` — references old subkey labels and tests `mintToken` call shape.
  - `packages/runtime/bundle-token/src/__tests__/verify.test.ts` — `claw/spine-v1` / `claw/llm-v1` hard-coded label references (4 per the audit grep); update to `claw/bundle-v1` and add `requiredScope` exercises where appropriate.
  - **In `packages/runtime/bundle-sdk/` (owned by Phase 7 but re-checked here):**
  - `packages/runtime/bundle-sdk/src/__tests__/define.test.ts`
  - `packages/runtime/bundle-sdk/src/__tests__/bundle-env.types.test.ts`
  - `packages/runtime/bundle-sdk/src/__tests__/openrouter-integration.test.ts`
  - **In `packages/capabilities/tavily-web-search/`:**
  - `packages/capabilities/tavily-web-search/src/__tests__/tavily-bundle-integration.test.ts`
  - `packages/capabilities/tavily-web-search/src/__tests__/client-rpc.test.ts`
  - `packages/capabilities/tavily-web-search/src/__tests__/client.test.ts`
  - `packages/capabilities/tavily-web-search/src/__tests__/service.test.ts`
- [x] 9.3 New file `packages/runtime/bundle-host/src/__tests__/unified-token-scope.test.ts`:
  - **A: SpineService rejects token missing "spine" scope.** Mint token with `scope: ["llm"]`. `appendEntry(token, ...)` throws `ERR_SCOPE_DENIED`.
  - **B: LlmService rejects token missing "llm" scope.** Mint with `scope: ["spine"]`. `infer(token, ...)` throws with message `"ERR_SCOPE_DENIED"`.
  - **C: TavilyService rejects token missing "tavily-web-search" scope.** Mint with `scope: ["spine", "llm"]`. `search(token, ...)` throws `ERR_SCOPE_DENIED`.
  - **D: TavilyService accepts token with the scope.** Mint with `scope: ["spine", "llm", "tavily-web-search"]`. Mock upstream `fetch` returns a valid Tavily response. `search` returns results.
  - **E: Same nonce used across services succeeds.** Mint with `scope: ["spine", "llm", "tavily-web-search"]`. Call spine, llm, tavily in sequence with the same token. All succeed. Assert the nonce is identical in each `caller` / payload.
  - **F: Expired token rejected before scope check.** Mint with `ttlMs: -1000`, any scope. Each service throws `ERR_TOKEN_EXPIRED` (not `ERR_SCOPE_DENIED`), proving ordering.
  - **G: Signature-tampered token rejected before scope check.** Flip a byte in the signature. Each service throws `ERR_BAD_TOKEN`.
  - **H: Empty scope array.** Mint with `scope: []`. Every service rejects with `ERR_SCOPE_DENIED`.
  - **I: `ERR_SCOPE_DENIED` survives SpineService `sanitize`.** Call `env.SPINE.emitCost(bundleToken, costEvent)` with a token that lacks the `"spine"` scope. Expect the thrown `SpineError` to carry `code === "ERR_SCOPE_DENIED"`, not `ERR_INTERNAL`. Rationale: the verify call inside `SpineService` throws `SpineError` directly, which the `sanitize` branch at `spine-service.ts:345-363` passes through unchanged — this scenario locks in that the error round-trip doesn't erase the code on the way back to the bundle.
- [x] 9.4 New file `packages/runtime/agent-runtime/test/integration/bundle-token-env-projection.test.ts`:
  - **I: Inline dispatch writes `__BUNDLE_TOKEN` only.** Run `bundlePromptHandler` through the test harness. Capture the env passed to the loader factory. Assert it contains `__BUNDLE_TOKEN` and does NOT contain `__SPINE_TOKEN`, `__LLM_TOKEN`, or `__TAVILY_TOKEN`.
  - **J: BundleDispatcher writes `__BUNDLE_TOKEN` only.** Same assertion against `BundleDispatcher.dispatchTurn`.
  - **K: Scope derived from catalog.** Deploy a bundle with `requiredCapabilities: [{ id: "tavily-web-search" }]`. Run a turn, capture the token, decode the payload (use a test helper that reads the payload without verifying — test-only). Assert `payload.scope === ["spine", "llm", "tavily-web-search"]` in order.
  - **L: Undeclared bundle gets minimal scope.** Deploy a bundle with no `requiredCapabilities`. Run a turn, decode, assert `payload.scope === ["spine", "llm"]`.
  - **M: Client event mint uses the same scope logic.** Trigger `bundleClientEventHandler`; assert the minted token has the catalog-derived scope.
  - **N: Catalog validation failure does NOT mint.** Deploy a bundle whose active version declares an id the host does not know. Trigger a turn. Assert (a) no `mintToken` call occurs, (b) the env passed to the loader factory does NOT include `__BUNDLE_TOKEN`, (c) the turn falls back to static brain. Rationale: the load-bearing safety claim in `specs/agent-bundles/spec.md` — "WHEN catalog validation fails THEN the dispatcher does NOT call `mintToken`, does NOT write `__BUNDLE_TOKEN` into the bundle env, and falls back to static brain" — needs an explicit test.
- [x] 9.5 Update `packages/runtime/bundle-host/src/__tests__/dispatcher.test.ts` (or equivalent) for the single-token env shape. Any test that asserts on both `__SPINE_TOKEN` and `__LLM_TOKEN` being present collapses to a single `__BUNDLE_TOKEN` assertion.
- [x] 9.6 `cd packages/runtime/bundle-host && bun test` — PASS.
- [x] 9.7 `cd packages/runtime/agent-runtime && bun test` — PASS. New scope-isolation scenarios all pass.
- [x] 9.8 `cd packages/capabilities/tavily-web-search && bun test` — PASS. Scope-denial scenarios pass.
- [x] 9.9 Reserved-scope rejection test (catalog amendment): `packages/runtime/bundle-registry/src/__tests__/set-active-reserved-scopes.test.ts` (new) — declare `requiredCapabilities: [{ id: "spine" }]` and expect `setActive` to throw with a clear error naming the reserved collision. Mirror for `{ id: "llm" }`. Also add a `defineBundleAgent` build-time validator test — `defineBundleAgent({ requiredCapabilities: [{ id: "spine" }] })` throws at build time (per the catalog proposal's build-time input validation).

## 10. Phase 10 — Documentation and final verification

- [x] 10.1 Update `CLAUDE.md` "Bundle brain override (opt-in)" section. Current text mentions per-service HKDF subkeys; replace with: "per-turn HMAC token with a single HKDF subkey `claw/bundle-v1`. The token payload carries a `scope: string[]` of authorized services — reserved `\"spine\"` and `\"llm\"` for the two core channels, plus each `requiredCapabilities` id from the validated catalog. Each host-side service checks its scope on verify. Delivered to the bundle as `env.__BUNDLE_TOKEN`."
- [x] 10.2 Update `README.md` `defineBundleAgent` example if it references bundle-side token reading (currently should not — the Tavily client handles it).
- [x] 10.3 Update `packages/runtime/bundle-host/README.md` (if present) with the single-label, single-env-field model.
- [x] 10.4 Update `packages/capabilities/tavily-web-search/README.md` (if present) with the new `AGENT_AUTH_KEY: string` env requirement for the service.
- [x] 10.5 `examples/basic-agent/src/worker.ts` at line 132 — the `bundleEnv` factory. No change needed (it already spreads only the user bindings; the dispatcher injects `__BUNDLE_TOKEN` automatically). Confirm.
- [x] 10.6 Audit `examples/` for any docs that mention `__SPINE_TOKEN` / `__LLM_TOKEN` in user-facing text — update to `__BUNDLE_TOKEN`.
- [x] 10.7 Add a line to the "Known Constraints" or "Bundle brain override" section of `CLAUDE.md` noting the breaking change: "Bundles and capability clients built prior to this change that read `env.__SPINE_TOKEN`, `env.__LLM_TOKEN`, or `env.__TAVILY_TOKEN` get `undefined`. Rebuild against the current SDK."
- [x] 10.8 Clean install: `rm -rf node_modules packages/*/*/node_modules && bun install`.
- [x] 10.9 `bun run typecheck` — PASS across all packages.
- [x] 10.10 `bun run lint` — PASS. No new errors vs. baseline.
- [x] 10.11 `bun run test` — PASS across bundle-token, bundle-host, agent-runtime integration, tavily-web-search, agent-workshop, bundle-sdk. Pre-existing miniflare flakes unchanged.
- [x] 10.12 Grep confirmations:
  - `grep -rn "__SPINE_TOKEN\|__LLM_TOKEN\|__TAVILY_TOKEN" packages/ examples/` — zero hits outside this proposal's openspec changes directory.
  - `grep -rn "claw/spine-v1\|claw/llm-v1\|claw/tavily-v1" packages/` — zero hits.
  - `grep -rn "SPINE_SUBKEY_LABEL\|LLM_SUBKEY_LABEL\|TAVILY_SUBKEY_LABEL\|TAVILY_SUBKEY" packages/` — zero hits.
  - `grep -rn "BUNDLE_SUBKEY_LABEL" packages/` — hits in `bundle-token/src/subkey.ts` (export, canonical), `bundle-host/src/index.ts` (re-export), `bundle-host/src/services/spine-service.ts` (import), `bundle-host/src/services/llm-service.ts` (import), `bundle-host/src/dispatcher.ts` (import), `agent-runtime/src/agent-do.ts` (import), `tavily-web-search/src/service.ts` (import — from `bundle-token`), and tests. No orphans.
  - `grep -rn "__BUNDLE_TOKEN" packages/` — hits in the two dispatch paths (mint write side), bundle-sdk (`types.ts` field declaration, `define.ts` 401 check + smoke, `runtime.ts` token reads, `llm/service-provider.ts` token read), tavily client (read), tests (stubbed env + assertions). No orphans.
  - `grep -rn "requiredScope" packages/` — hits in `bundle-token/src/verify.ts` + types, the three services' verify call sites, tests. No orphans.
  - `grep -rn "ERR_SCOPE_DENIED" packages/` — hits in `bundle-token/src/types.ts`, the three services (error code unions / throw sites), tests including the sanitize-round-trip scenario. No orphans.
- [x] 10.13 Manual smoke test on `examples/basic-agent`:
  - Build and deploy a bundle with `requiredCapabilities: [{ id: "tavily-web-search" }]`.
  - Verify a turn that calls `web_search` succeeds end-to-end.
  - Disable Tavily's declaration in the bundle (empty `requiredCapabilities`), redeploy, verify the bundle's `web_search` call fails with a scope-denial error visible in the agent's log. Confirms the scope enforcement bites at runtime.

## 11. Commit structure

The exact commit structure depends on reviewer preference:

**Option A (preferred): one atomic commit covering Phases 3-10.** Single logical change ("unify bundle capability token"). Easy to revert. Hard to review for large repos. Phase 2 is a separate commit because `bundle-token` can widen its API independently without breaking anyone.

**Option B: two commits.**
  1. Phases 2-3: widen `bundle-token` and `mintToken` signature with `scope`. All existing callers pass `scope` already but consumers still read per-service env fields — the tree typechecks and tests pass because the old labels still exist.
  2. Phases 4-10: delete per-service labels, rewrite dispatchers and capability clients, consolidate env field, migrate bundle-sdk, update tests and docs.

Option B is reviewable; Option A is atomic. Default to Option B unless the reviewer requests a single commit.

- [x] 11.1 Commit (Option B boundary 1, after Phase 3): "feat(bundle-token, bundle-host): add scope field to token payload and mint signature"
- [x] 11.2 Commit (Option B boundary 2, after Phase 10): "feat(bundle): unify per-service capability tokens into single __BUNDLE_TOKEN with scope check"
