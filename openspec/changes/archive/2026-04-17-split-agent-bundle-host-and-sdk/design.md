## The real question: where does token verification live?

The split is structurally obvious except for one file: `packages/agent-bundle/src/security/capability-token.ts`. It contains both the mint functions (host-only) and the verify functions (needed by both halves). Splitting it cleanly is the load-bearing decision in this refactor.

Three options were evaluated:

### Option 1: Subpath export from `bundle-host`

```
@claw-for-cloudflare/bundle-host
  index.ts           → dispatcher, SpineService, LlmService, mint
  verify.ts          → verify-only surface (subpath export)

@claw-for-cloudflare/bundle-sdk
  depends on bundle-host (for types + verify via subpath)
```

Bundle authors install `bundle-sdk`, which pulls in `bundle-host` as a transitive dep. At the TypeScript level, bundle source can only `import` from `bundle-host/verify` if they want verify helpers — the main entry-point is typed to not expose mint to callers of the verify subpath.

**Pro:** one fewer package.
**Con:** `bundle-sdk` transitively installs `bundle-host`. The install-footprint benefit of the split is weakened — bundle projects still have all the host source in `node_modules`, they just don't import it at the top level. Tree-shaking at bundle build time removes unused code from the output, but authoring-time type-checking still loads everything.
**Con:** the trust boundary is implicit. A reviewer asking "can a bundle obtain the master secret?" has to read `bundle-host`'s entry-point typing rules to confirm the mint functions are not reachable from `bundle-sdk`. The answer is "no, they're gated", but the mechanism is load-bearing TypeScript, not a package boundary.

### Option 2: Third micro-package `bundle-token`

```
@claw-for-cloudflare/bundle-token          ← new, tiny
  types.ts           → Token, TokenPayload, VerifyOutcome
  subkey.ts          → HKDF subkey derivation (verify-only)
  verify.ts          → verifyToken, NonceTracker

@claw-for-cloudflare/bundle-host
  depends on bundle-token
  index.ts           → dispatcher, SpineService, LlmService
  mint.ts            → mintToken (uses bundle-token types)

@claw-for-cloudflare/bundle-sdk
  depends on bundle-token (only — does NOT depend on bundle-host)
  index.ts           → defineBundleAgent, BundleContext, etc.
```

**Pro:** the trust boundary is a package boundary. `bundle-sdk` has no way to obtain mint code — it is not in its dependency graph at all. Any future attempt to reach it fails at install time, not at type-check time.
**Pro:** install footprint of a bundle project is genuinely minimized. `bundle-sdk` + `bundle-token` + `typebox` — nothing else.
**Pro:** the split's intent is legible to a reviewer — three packages, each with a clear role.
**Con:** one more package in the workspace (now 39 instead of 38).
**Con:** a trivial amount of boilerplate (package.json, tsconfig.json) per micro-package.

### Option 3: Duplicate verify code

Maintain two copies of verify.ts — one in `bundle-host`, one in `bundle-sdk`. No shared package.

**Pro:** absolute isolation between halves.
**Con:** code duplication, which drifts. If a bug is found in verify, both copies must be fixed. Token format changes require coordinated updates in two places.
**Verdict:** rejected immediately. Crypto code duplication is a security anti-pattern.

### Decision: Option 2

The micro-package is the right call. It is one additional package.json of overhead in exchange for:
- A clean trust boundary that is reviewer-legible.
- An install footprint that actually matches the split's stated goal.
- Future-proofing: if token format evolves (e.g., adopting biscuit-auth, switching to Ed25519, adding JWT claims), the change happens in one place and both halves pick it up.

Name: `@claw-for-cloudflare/bundle-token`. Lives in `packages/runtime/bundle-token/` after the reorganize-packages-by-role proposal lands.

Exports:
- `mintToken` — NOT exported here; lives in `bundle-host`. `bundle-token` provides only the types and HKDF subkey helpers plus the verify-only surface.
- `TokenPayload` — shape of the decoded payload.
- `VerifyOutcome` — discriminated union returned by `verifyToken`.
- `NonceTracker` — nonce LRU tracker for replay prevention.
- `deriveVerifyOnlySubkey(masterKey: string, label: string): Promise<CryptoKey>` — used by both halves. Returns a verify-only CryptoKey (`usages: ["verify"]` only), so even if a subkey leaks it cannot mint.
- `verifyToken(token: string, subkey: CryptoKey, nonceTracker: NonceTracker): Promise<VerifyOutcome>`

The mint side lives in `packages/runtime/bundle-host/src/security/mint.ts`:
- `deriveMintSubkey(masterKey: string, label: string): Promise<CryptoKey>` — mint-only (`usages: ["sign"]` only).
- `mintToken(payload, subkey): Promise<string>`

Note the asymmetry: the HKDF derivation itself is duplicated between verify-only and mint-only because the resulting CryptoKey usages differ. Web Crypto keys are type-tagged with their allowed operations. A single shared `deriveSubkey` function would have to accept a usages parameter — that's fine, but splitting into two named helpers makes the intent obvious at call sites. `bundle-token` exports only the verify variant; `bundle-host` has its own mint variant.

## Package shapes

### `@claw-for-cloudflare/bundle-token`

```
packages/runtime/bundle-token/
  package.json       name: "@claw-for-cloudflare/bundle-token"
                     exports: "." → src/index.ts
                     deps: none (uses Web Crypto SubtleCrypto from global)
  tsconfig.json
  src/
    index.ts         barrel
    types.ts         Token, TokenPayload, VerifyOutcome
    subkey.ts        deriveVerifyOnlySubkey
    verify.ts        verifyToken, NonceTracker
  test/
    verify.test.ts   unit tests for the verify-only surface
```

Tiny. Maybe 200 lines total. No runtime deps. Substrate-neutral enough that if CrabbyKit ever goes multi-provider, this package moves to a provider-neutral location unchanged.

### `@claw-for-cloudflare/bundle-sdk`

```
packages/runtime/bundle-sdk/
  package.json       name: "@claw-for-cloudflare/bundle-sdk"
                     exports: "." → src/index.ts
                     deps: @claw-for-cloudflare/bundle-token,
                           @claw-for-cloudflare/agent-runtime (type-only re-exports),
                           @sinclair/typebox
  tsconfig.json
  src/
    index.ts         barrel
    define.ts        defineBundleAgent
    types.ts         BundleEnv, BundleContext, BundleCapability, etc.
    runtime.ts       buildBundleContext, runBundleTurn
    spine-clients.ts BundleSessionStoreClient, BundleKvStoreClient, etc.
    prompt/
      build-system-prompt.ts
      sections.ts
      types.ts
    llm/
      service-provider.ts   bundle-side LLM invocation via LlmService
  test/
    define.test.ts
    runtime.test.ts
    prompt/
```

The `src/bundle/` tree from `agent-bundle` moves here wholesale. Minimal renaming — mostly just the directory move and a new `package.json`.

No `cloudflare:workers` imports. No native binding types. This package can be type-checked in a plain Node `tsconfig` without `@cloudflare/workers-types` being installed.

### `@claw-for-cloudflare/bundle-host`

```
packages/runtime/bundle-host/
  package.json       name: "@claw-for-cloudflare/bundle-host"
                     exports: "." → src/index.ts
                     deps: @claw-for-cloudflare/bundle-token,
                           @claw-for-cloudflare/bundle-sdk (type-only for BundleExport contract),
                           @claw-for-cloudflare/agent-runtime,
                           @claw-for-cloudflare/bundle-registry
  tsconfig.json
  src/
    index.ts              barrel
    dispatcher.ts         BundleDispatcher, per-turn dispatch entry
    bundle-config.ts      BundleConfig type consumed by defineAgent
    budget-tracker.ts     BudgetTracker
    in-memory-registry.ts InMemoryBundleRegistry test helper
    services/
      spine-service.ts    SpineService WorkerEntrypoint
      llm-service.ts      LlmService WorkerEntrypoint
    security/
      mint.ts             mintToken, deriveMintSubkey
  test/
    dispatcher.test.ts
    budget-tracker.test.ts
    in-memory-registry.test.ts
    services/
      spine-service.test.ts
      llm-service.test.ts
    security/
      mint.test.ts
```

This is the only package in the three that imports `cloudflare:workers`. The dependency on `bundle-sdk` is **type-only** — the dispatcher needs to reference the `BundleExport` contract so it can call into a loaded bundle with the right request shape. Using TypeScript's `import type` and marking `bundle-sdk` as a `peerDependencies` + `devDependencies` entry keeps the runtime dep chain one-way: installing `bundle-host` alone does not force `bundle-sdk` into your install tree.

Actually — the peer-dep trick is fiddly. Cleaner: `bundle-sdk` is a regular dep of `bundle-host` but only type imports cross the boundary. Bundle-host's runtime code never calls any function exported from `bundle-sdk`, only uses its type declarations to constrain the shape of loaded bundles. TypeScript strips type-only imports at compile time, so there is no runtime coupling. The transitive install is acceptable because anyone installing `bundle-host` already has bundle authoring ambitions by definition.

## Moving the `SpineHost` interface

Currently at `packages/agent-bundle/src/host/spine-service.ts` in the same file as the `SpineService` WorkerEntrypoint class:

```ts
export interface SpineHost {
  spineAppendEntry(sessionId: string, entry: unknown): unknown;
  spineGetEntries(sessionId: string, options?: unknown): unknown[];
  // ... ~20 methods
}
```

This is a contract the DO implements, not a contract `bundle-host` owns. The symmetric move is to relocate it to `packages/runtime/agent-runtime/src/spine-host.ts` and export it from the agent-runtime package barrel alongside `SqlStore`, `KvStore`, `Scheduler`, `Transport`.

The `bundle-host` SpineService then imports it from agent-runtime:

```ts
import type { SpineHost } from "@claw-for-cloudflare/agent-runtime";
```

`agent-do.ts` in agent-runtime already implements every method on the interface (`spineAppendEntry`, `spineKvGet`, etc. exist as methods on `AgentDO`). Moving the type into agent-runtime makes the implementation relationship visible — the DO `implements SpineHost` structurally, and the check lives in the same package as the DO.

Arguably this should also grow a type-level assertion: `const _check: SpineHost = new AgentDO(...)` or similar. That is nice-to-have, not load-bearing. The current structural satisfaction works.

## Deletion of the old package

`@claw-for-cloudflare/agent-bundle` is deleted in this change. The `packages/runtime/agent-bundle/` directory is removed entirely. This is intentional per CLAUDE.md's "no legacy compat shims" rule and the repo's greenfield status.

Risk of this approach: any forgotten import breaks the build the moment it is touched. Mitigation: a grep pass for `@claw-for-cloudflare/agent-bundle` before the deletion commit, followed by `bun run typecheck` and `bun run test` in CI. If either fails, the import is updated and the commit re-run.

Alternative considered: a stub package that re-exports from the split packages and emits a deprecation warning. Rejected because:
1. CLAUDE.md forbids legacy shims.
2. There are no external consumers (the repo is pre-release).
3. A stub adds ongoing maintenance burden for zero benefit.
4. A clean break is easier to reason about than a gradual migration.

## Test file placement

Every test under `packages/agent-bundle/src/**/__tests__/` is re-homed to either `bundle-sdk`, `bundle-host`, or `bundle-token` based on which half it exercises:

- Tests for `capability-token.ts` split: mint tests to `bundle-host/test/security/mint.test.ts`, verify tests to `bundle-token/test/verify.test.ts`.
- Tests for `define.ts`, `runtime.ts`, prompt builder → `bundle-sdk/test/`.
- Tests for `bundle-dispatcher.ts`, `spine-service.ts`, `llm-service.ts`, `budget-tracker.ts`, `in-memory-registry.ts` → `bundle-host/test/`.

Integration tests in `packages/agent-runtime/test/integration/bundle-dispatch.test.ts` stay where they are but update their imports. This test exercises the full dispatch path from DO to bundle isolate and uses both `bundle-host` and `bundle-sdk`; the two imports make this clear.

## What does NOT change

- The `bundle` config field on `defineAgent` — same shape, same behavior, same fallback semantics. Only the import source for the `BundleConfig` type changes.
- The per-turn capability token protocol — same HKDF scheme, same subkey labels (`claw/spine-v1`, `claw/llm-v1`, `claw/tavily-v1`), same payload shape, same nonce + TTL discipline.
- The SpineService RPC surface — same methods, same signatures, same budget categories, same error codes.
- The LlmService provider surface — same routing, same credential handling.
- The capability service pattern for Tavily — same four subpaths (index, service, client, schemas), same content-hash drift detection.
- The bundle registry protocol — D1 rows, KV bytes, content-addressed version IDs, active pointer. Unchanged.
- The bundle pointer cache invariant on `AgentDO.ctx.storage` — same single-writer rule, same `notifyBundlePointerChanged` / `/bundle/refresh` two channels.
- The workshop capability — same tools, same flow, same security.
- Client-facing event stream shape — bundle dispatch is invisible to observers. Clients see identical `agent_event`, `tool_event`, etc. whether a turn ran static or bundled.

This is deliberately a no-semantic-change refactor. If any behavior difference appears during implementation, stop and investigate — it's a bug, not a feature of the split.

## Risks

1. **Circular dependency discovery.** There is a small risk that `bundle-host` and `bundle-sdk` have a circular type dependency that wasn't visible while they lived in one package. Mitigation: `import type` for all cross-package references; add a package-level dep cycle check to CI via `madge` or similar.
2. **`bundle-host` transitively forcing `cloudflare:workers` on `bundle-sdk`.** If any type in `bundle-sdk` references `Service<T>` (which it does, in `BundleEnv`), the type is from `cloudflare:workers`. `bundle-sdk` is not allowed to import `cloudflare:workers` directly per the portability-aware dep rules. Resolution: `Service<T>` is a generic structural type — `bundle-sdk` declares its own `Service<T> = { [K: string]: (...args: unknown[]) => Promise<unknown> }` stub OR imports the type from `@cloudflare/workers-types` as a devDependency (type-only, no runtime). The latter is cleaner because it keeps the type identical to what consumers use. Add `@cloudflare/workers-types` as a devDependency to `bundle-sdk` and use `import type { Service } from "@cloudflare/workers-types"` where needed.
3. **Test coverage regression.** If test files are moved and renamed, coverage thresholds may temporarily drop. Mitigation: run coverage before and after the split and compare. If thresholds drop, investigate the specific uncovered lines.
4. **Consumer surprise.** Anyone currently watching the repo may have an in-flight PR or local branch that imports `@claw-for-cloudflare/agent-bundle`. Mitigation: announce the split in commit messages; the clean break is fast to adapt to (update one import per consumer).

## Why this is the right time

Two reasons:

1. **The reorg just happened.** Moving packages into the `packages/runtime/` bucket is the cheapest time to also split one of them — the churn is already baked in. Waiting means two distinct waves of import updates.
2. **Shape-2 rollout is next.** The next architectural initiative is generalizing the Tavily capability service pattern to additional capabilities (`file-tools`, `vector-memory`, `browserbase`, etc.). Every new shape-2 capability will import from both `bundle-sdk` (client side) and potentially `bundle-host` (if it ships a service). Doing the split before shape-2 rollout means every new capability is born with the right imports. Doing it after means N capabilities need to update imports twice.

Ordering: this proposal depends on `reorganize-packages-by-role`. Ship the reorg first, ship this split immediately after, before any shape-2 capability work begins.
