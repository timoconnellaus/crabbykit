## 1. Phase 1 — Preflight

- [x] 1.1 Confirm `reorganize-packages-by-role` has landed. `packages/runtime/agent-bundle/` should exist (not `packages/agent-bundle/`).
- [x] 1.2 Run `bun run test` and `bun run typecheck` from a clean tree. Both must pass before this split begins — otherwise any failures during the split are hard to attribute.
- [x] 1.3 Grep repo for all current imports of `@claw-for-cloudflare/agent-bundle`. Record the file list as a baseline — every entry on this list will be updated by the end of this change.
- [x] 1.4 Confirm test coverage baseline for `agent-bundle` before the split, so it can be compared after.

## 2. Phase 2 — Scaffold `bundle-token` micro-package

- [x] 2.1 Create `packages/runtime/bundle-token/` with `package.json` (`name: "@claw-for-cloudflare/bundle-token"`, exports `.` → `src/index.ts`, no dependencies beyond dev tooling)
- [x] 2.2 Create `packages/runtime/bundle-token/tsconfig.json` extending the workspace base
- [x] 2.3 Create `packages/runtime/bundle-token/src/index.ts` as barrel
- [x] 2.4 Create `packages/runtime/bundle-token/src/types.ts` — move `Token`, `TokenPayload`, `VerifyOutcome` types from `agent-bundle/src/security/capability-token.ts`
- [x] 2.5 Create `packages/runtime/bundle-token/src/subkey.ts` — implement `deriveVerifyOnlySubkey(masterKey: string, label: string): Promise<CryptoKey>` using `crypto.subtle.importKey` + HKDF with `usages: ["verify"]` only. Copy the HKDF logic from existing `capability-token.ts` but constrain the resulting CryptoKey usages.
- [x] 2.6 Create `packages/runtime/bundle-token/src/verify.ts` — move `verifyToken` and `NonceTracker` from `agent-bundle/src/security/capability-token.ts`
- [x] 2.7 Create `packages/runtime/bundle-token/src/__tests__/verify.test.ts` — move verify-only test cases from `agent-bundle/src/security/__tests__/capability-token.test.ts` (replay rejection, expiry, tampered payload, wrong subkey, valid roundtrip — the roundtrip test temporarily imports mint from the old location and should be rehomed to `bundle-host` in Phase 4)
- [x] 2.8 `bun install` — confirm the new package is discovered
- [x] 2.9 `cd packages/runtime/bundle-token && bun run typecheck` — PASS
- [x] 2.10 `cd packages/runtime/bundle-token && bun run test` — PASS (some tests may skip if they need mint; those move in Phase 4)
- [x] 2.11 Commit: "feat(bundle-token): extract verify-only token primitives to micro-package"

## 3. Phase 3 — Scaffold `bundle-sdk` package (move bundle authoring side)

- [x] 3.1 Create `packages/runtime/bundle-sdk/` with `package.json`:
  - `name: "@claw-for-cloudflare/bundle-sdk"`
  - `exports`:
    - `.` → `src/index.ts` (authoring barrel: `defineBundleAgent`, types)
    - `./runtime-source` → `dist/bundle-runtime-source.js` (with `.d.ts` alongside) — the built-string form of the SDK used by host injection
  - `dependencies`: `@claw-for-cloudflare/bundle-token`, `@claw-for-cloudflare/agent-runtime` (for type re-exports), `@claw-for-cloudflare/agent-core` (pi-agent-core fork for in-isolate LLM loop), `@claw-for-cloudflare/ai` (pi-ai providers for model access), `@sinclair/typebox`
  - `devDependencies`: `@cloudflare/workers-types` (type-only, needed for `Service<T>`)
  - `scripts`:
    - `build`: `bun build.ts`
    - `postinstall`: `bun build.ts` (preserves the current agent-bundle postinstall behavior so the `dist/bundle-runtime-source.js` artifact always exists)
    - `test`, `typecheck`: standard
- [x] 3.2 Create `packages/runtime/bundle-sdk/tsconfig.json`
- [x] 3.3 Move `packages/runtime/agent-bundle/src/bundle/` to `packages/runtime/bundle-sdk/src/` preserving subdirectories (`bundle/`, `bundle/prompt/`, `bundle/llm/`)
- [x] 3.4 Actually — flatten the move. The old `src/bundle/` was a subfolder only because it coexisted with `src/host/` in the same package. Now that it's its own package, drop the `bundle/` layer. Files go directly under `packages/runtime/bundle-sdk/src/`:
  - `agent-bundle/src/bundle/define.ts` → `bundle-sdk/src/define.ts`
  - `agent-bundle/src/bundle/runtime.ts` → `bundle-sdk/src/runtime.ts`
  - `agent-bundle/src/bundle/types.ts` → `bundle-sdk/src/types.ts`
  - `agent-bundle/src/bundle/spine-clients.ts` → `bundle-sdk/src/spine-clients.ts`
  - `agent-bundle/src/bundle/index.ts` → `bundle-sdk/src/index.ts`
  - `agent-bundle/src/bundle/prompt/*` → `bundle-sdk/src/prompt/*`
  - `agent-bundle/src/bundle/llm/*` → `bundle-sdk/src/llm/*`
- [x] 3.4a Move the `build.ts` script from `packages/runtime/agent-bundle/build.ts` → `packages/runtime/bundle-sdk/build.ts`. Update its `entry` constant to point at `src/index.ts` (the new barrel location after flattening). Output paths (`dist/bundle-runtime.js`, `dist/bundle-runtime-source.js`, `dist/bundle-runtime-source.d.ts`) remain the same. The script SHALL continue to emit both `BUNDLE_RUNTIME_SOURCE` and `BUNDLE_RUNTIME_HASH` constants.
- [x] 3.4b Run `bun packages/runtime/bundle-sdk/build.ts` — expect the dist artifacts to regenerate successfully from the new location
- [x] 3.5 Update every `import` inside `bundle-sdk/src/**` that referenced `../host/...` or `../security/...` to instead import from:
  - `@claw-for-cloudflare/bundle-token` (for token types, verify, subkey derivation)
  - `@claw-for-cloudflare/agent-runtime` (for runtime types — `AgentEvent`, `SessionEntry`, etc.)
- [x] 3.6 Move corresponding tests: `agent-bundle/src/bundle/__tests__/*` → `bundle-sdk/src/__tests__/*` or `bundle-sdk/test/*` (align with package conventions)
- [x] 3.7 Confirm `bundle-sdk` has zero `cloudflare:workers` runtime imports. Only `import type { Service } from "@cloudflare/workers-types"` is allowed (type-only).
- [x] 3.8 Create `packages/runtime/bundle-sdk/src/index.ts` as barrel — re-export `defineBundleAgent`, all public types, bundle context types, bundle capability types
- [x] 3.9 `bun install` — confirm discovery
- [x] 3.10 `cd packages/runtime/bundle-sdk && bun run typecheck` — PASS
- [x] 3.11 `cd packages/runtime/bundle-sdk && bun run test` — PASS
- [x] 3.12 Commit: "feat(bundle-sdk): extract bundle authoring SDK from agent-bundle"

## 4. Phase 4 — Scaffold `bundle-host` package (move host dispatcher side)

- [x] 4.1 Create `packages/runtime/bundle-host/` with `package.json`:
  - `name: "@claw-for-cloudflare/bundle-host"`
  - `exports`: `.` → `src/index.ts`
  - `dependencies`: `@claw-for-cloudflare/bundle-token`, `@claw-for-cloudflare/bundle-sdk` (used at runtime for the `./runtime-source` subpath carrying `BUNDLE_RUNTIME_SOURCE` and `BUNDLE_RUNTIME_HASH` constants — type-only for everything else), `@claw-for-cloudflare/agent-runtime`, `@claw-for-cloudflare/bundle-registry`, `@cloudflare/worker-bundler` (for the auto-rebuild path in `bundle-builder.ts`)
- [x] 4.2 Create `packages/runtime/bundle-host/tsconfig.json`
- [x] 4.3 Move files from `agent-bundle/src/host/` to `bundle-host/src/` (flatten similarly):
  - `bundle-dispatcher.ts` → `bundle-host/src/dispatcher.ts`
  - `bundle-config.ts` → `bundle-host/src/bundle-config.ts` — the fuller `BundleConfig<TEnv>` type with `registry`, `loader`, `autoRebuild` fields. Imports `BundleVersionMetadata`/`BundleVersionInfo`/`CreateBundleVersionOpts` from `@claw-for-cloudflare/agent-runtime` (which holds the minimal circular-dep-break types in `agent-runtime/src/bundle-config.ts`).
  - `budget-tracker.ts` → `bundle-host/src/budget-tracker.ts`
  - `in-memory-registry.ts` → `bundle-host/src/in-memory-registry.ts`
  - `bundle-builder.ts` → `bundle-host/src/bundle-builder.ts` — the auto-rebuild helper (added in commit `a70d70b`). Uses `@cloudflare/worker-bundler` to rebuild a bundle when the runtime source hash drifts. Host-side because it needs R2 bucket access and the full `BundleRegistry.createVersion` surface.
  - `spine-service.ts` → `bundle-host/src/services/spine-service.ts`
  - `llm-service.ts` → `bundle-host/src/services/llm-service.ts`
  - `index.ts` → `bundle-host/src/index.ts`
- [x] 4.3a Move host-side test files:
  - `agent-bundle/src/host/__tests__/bundle-builder.test.ts` → `bundle-host/src/__tests__/bundle-builder.test.ts`
  - `agent-bundle/src/host/__tests__/decode-bundle-payload.test.ts` → `bundle-host/src/__tests__/decode-bundle-payload.test.ts`
  - Other `agent-bundle/src/host/__tests__/*.test.ts` files similarly
- [x] 4.4 Move mint-side security code:
  - `agent-bundle/src/security/capability-token.ts` — extract the mint-side functions (`mintToken`, `deriveMintSubkey`) into `bundle-host/src/security/mint.ts`
  - `bundle-host/src/security/mint.ts` imports types from `@claw-for-cloudflare/bundle-token` and implements mint using HKDF with `usages: ["sign"]`
  - Corresponding mint tests → `bundle-host/src/security/__tests__/mint.test.ts`
- [x] 4.5 Update `spine-service.ts` imports: `SpineHost` interface now imported from `@claw-for-cloudflare/agent-runtime` (see Phase 5), verify utilities from `@claw-for-cloudflare/bundle-token`
- [x] 4.6 Update `llm-service.ts` imports analogously
- [x] 4.7 Update `dispatcher.ts` imports to reference `bundle-sdk` for `BundleExport` contract type (`import type { BundleExport } from "@claw-for-cloudflare/bundle-sdk"`) and `BUNDLE_RUNTIME_SOURCE`/`BUNDLE_RUNTIME_HASH` runtime constants from the `./runtime-source` subpath (`import { BUNDLE_RUNTIME_SOURCE, BUNDLE_RUNTIME_HASH } from "@claw-for-cloudflare/bundle-sdk/runtime-source"`)
- [x] 4.7a Update `bundle-builder.ts` imports to reference the same `./runtime-source` subpath for the drift-detection check. The previous import (from `agent-bundle/bundle-runtime-source` subpath) becomes `@claw-for-cloudflare/bundle-sdk/runtime-source`.
- [x] 4.8 Update `bundle-host/src/index.ts` barrel to re-export the dispatcher, `BundleConfig`, `BundleDispatcher`, `SpineService`, `LlmService`, `BudgetTracker`, `InMemoryBundleRegistry`
- [x] 4.9 Move host-side tests:
  - `agent-bundle/src/host/__tests__/*` → `bundle-host/src/__tests__/*` or `bundle-host/test/*`
  - `agent-bundle/src/security/__tests__/capability-token.test.ts` (mint tests only) → `bundle-host/src/security/__tests__/mint.test.ts`
- [x] 4.10 `bun install`
- [x] 4.11 `cd packages/runtime/bundle-host && bun run typecheck` — PASS
- [x] 4.12 `cd packages/runtime/bundle-host && bun run test` — PASS
- [x] 4.13 Commit: "feat(bundle-host): extract host dispatcher and services from agent-bundle"

## 5. Phase 5 — Extract `SpineHost` interface into `agent-runtime`

- [x] 5.1 Create `packages/runtime/agent-runtime/src/spine-host.ts` containing the `SpineHost` interface (moved from its current location in `bundle-host/src/services/spine-service.ts`)
- [x] 5.2 Re-export `SpineHost` from `packages/runtime/agent-runtime/src/index.ts` as a named type export
- [x] 5.3 Update `bundle-host/src/services/spine-service.ts` to import `SpineHost` from `@claw-for-cloudflare/agent-runtime` instead of declaring it inline
- [x] 5.4 Verify that `agent-runtime/src/agent-do.ts` structurally satisfies `SpineHost` — every method declared in the interface (`spineAppendEntry`, `spineGetEntries`, `spineKvGet`, `spineBroadcast`, `spineEmitCost`, etc.) already exists on the DO class
- [x] 5.5 Add a type-level assertion in a dedicated test file or at the top of `agent-do.ts`: `const _spineHostCheck: (x: AgentDO<any>) => SpineHost = (x) => x;` — if AgentDO drifts from the interface, this line fails to compile
- [x] 5.6 `cd packages/runtime/agent-runtime && bun run typecheck` — PASS
- [x] 5.7 `cd packages/runtime/agent-runtime && bun run test` — PASS
- [x] 5.8 `cd packages/runtime/bundle-host && bun run typecheck` — PASS
- [x] 5.9 Commit: "refactor(agent-runtime): move SpineHost interface from bundle-host"

## 6. Phase 6 — Update all consumers

- [x] 6.1 Update `packages/runtime/agent-workshop/src/**`: imports from `@claw-for-cloudflare/agent-bundle` split across `bundle-host` (for `BundleConfig`, `BundleDispatcher` types used in the workshop tools) and `bundle-sdk` (for authoring-side types used in the test harness)
- [x] 6.2 Update `packages/runtime/bundle-registry/src/**`: audit imports, update to reference `bundle-sdk` for `BundleMetadata` and related authoring-side types
- [x] 6.3 Update `packages/runtime/agent-runtime/test/integration/bundle-dispatch.test.ts`: imports split — use `bundle-host` for dispatcher helpers, `bundle-sdk` for bundle authoring in test fixtures
- [x] 6.4 Update `packages/runtime/agent-runtime/src/test-helpers/fake-worker-loader.ts` (added in commit `61b806c`): imports updated to reference the split packages
- [x] 6.4a Update `packages/runtime/agent-runtime/src/test-helpers/test-bundle-agent-do.ts` (added in commit `61b806c`): imports updated
- [x] 6.4b Update `packages/runtime/agent-runtime/src/test-helpers/test-agent-do.ts`: any bundle-related imports updated
- [x] 6.5 Update `packages/runtime/agent-runtime/test/fixtures/bundle-sources.ts` (added in commit `61b806c`): update fixture imports — fixtures reference `defineBundleAgent` which now comes from `@claw-for-cloudflare/bundle-sdk`
- [x] 6.5a Update `packages/runtime/agent-runtime/test/helpers/bundle-client.ts` (added in commit `61b806c`): update imports
- [x] 6.6 Update `packages/capabilities/tavily-web-search/src/client.ts`: bundle-side client imports `Capability`, `BundleContext`, etc. from `@claw-for-cloudflare/bundle-sdk`
- [x] 6.7 Update `packages/capabilities/tavily-web-search/package.json`: replace `@claw-for-cloudflare/agent-bundle` dep (if present) with `@claw-for-cloudflare/bundle-sdk`
- [x] 6.8 Update `examples/basic-agent/**`: grep for `@claw-for-cloudflare/agent-bundle`, update any hits to the appropriate split package
- [x] 6.9 Update `e2e/agent-runtime/**`: grep and update
- [x] 6.10 Grep entire repo one more time: `grep -r "@claw-for-cloudflare/agent-bundle" --include="*.ts" --include="*.tsx" --include="*.json"` — expect zero hits except in the soon-to-be-deleted `packages/runtime/agent-bundle/` directory and historical docs
- [x] 6.11 Run `bun run typecheck` at repo root — expect PASS
- [x] 6.12 Run `bun run test` at repo root — expect PASS
- [x] 6.13 Commit: "refactor: update consumers to split bundle packages"

## 7. Phase 7 — Delete old `agent-bundle` package

- [x] 7.1 Confirm `packages/runtime/agent-bundle/` has no files that haven't been moved to one of `bundle-sdk`, `bundle-host`, `bundle-token`. Remaining files should be limited to `package.json`, `tsconfig.json`, `README.md`, `vitest.config.ts`, empty `src/` scaffolding.
- [x] 7.2 Confirm no remaining imports of `@claw-for-cloudflare/agent-bundle` anywhere in the repo (re-run grep)
- [x] 7.3 `git rm -r packages/runtime/agent-bundle/`
- [x] 7.4 Update root `package.json` if it has any explicit reference (unlikely — bun workspace glob handles it)
- [x] 7.5 `bun install` — confirm workspace no longer contains `@claw-for-cloudflare/agent-bundle`
- [x] 7.6 `bun run typecheck` — PASS
- [x] 7.7 `bun run test` — PASS
- [x] 7.8 `bun run lint` — PASS (including the dependency-direction check added by the reorganize proposal)
- [x] 7.9 Commit: "chore: delete obsolete agent-bundle package"

## 8. Phase 8 — Verify security invariants

- [x] 8.1 Grep `packages/runtime/bundle-sdk/src/**` for any reference to `mintToken`, `deriveMintSubkey`, or `"sign"` — expect zero hits. The bundle SDK must have no path to mint code.
- [x] 8.2 Grep `packages/runtime/bundle-token/src/**` for `mintToken` — expect zero hits. The token micro-package must be verify-only.
- [x] 8.3 Grep `packages/runtime/bundle-host/src/security/mint.ts` for exports — confirm `mintToken` and `deriveMintSubkey` are exported ONLY from this file
- [x] 8.4 Check `packages/runtime/bundle-host/package.json`: `dependencies` should NOT list `@claw-for-cloudflare/bundle-sdk` as a runtime dep (type-only import is fine via the `dependencies` list, but verify no runtime-side pull)
- [x] 8.5 Check `packages/runtime/bundle-sdk/package.json`: `dependencies` should NOT list `@claw-for-cloudflare/bundle-host`. The whole point is that bundle-sdk is independent.
- [x] 8.6 Run the dep cycle check (`madge` or equivalent) across the three packages — expect no cycles
- [x] 8.7 Add a unit test in `bundle-sdk` that imports the barrel and asserts `typeof mintToken === "undefined"` and `typeof deriveMintSubkey === "undefined"` — document the security property as a test

## 9. Phase 9 — Documentation

- [x] 9.1 Update `CLAUDE.md` "Bundle brain override" section: replace references to `@claw-for-cloudflare/agent-bundle` with the appropriate split package
- [x] 9.2 Update `CLAUDE.md` "Capability service pattern" section: mention that bundle-side clients import from `@claw-for-cloudflare/bundle-sdk`
- [x] 9.3 Update `CLAUDE.md` packages list (runtime bucket): add `bundle-sdk`, `bundle-host`, `bundle-token`; remove `agent-bundle`
- [x] 9.4 Update `README.md` packages table analogously
- [x] 9.5 Update any example code in `README.md` or `CLAUDE.md` that shows bundle authoring imports — point at `bundle-sdk`
- [x] 9.6 Commit: "docs: update bundle system references after host/sdk split"

## 10. Phase 10 — Final verification

- [x] 10.1 Clean install: `rm -rf node_modules packages/*/*/node_modules && bun install`
- [x] 10.2 `bun run typecheck` — PASS
- [x] 10.3 `bun run lint` — PASS (dependency-direction check included)
- [x] 10.4 `bun run test` — PASS
- [x] 10.5 Coverage thresholds (agent-runtime + new bundle packages) meet or exceed previous baseline (statements 98%, branches 90%, functions 100%, lines 99%)
- [x] 10.6 `cd examples/basic-agent && bun run typecheck && bun run build` — PASS
- [x] 10.7 `cd e2e/agent-runtime && bun test` — PASS
- [x] 10.8 Grep confirmation: `grep -r "agent-bundle" --include="*.ts" --include="*.json"` returns no hits in source (archived proposals and git history excluded)
- [x] 10.9 Manual smoke test: run `examples/basic-agent` locally with `bun dev`, invoke a static turn, confirm no regressions
- [x] 10.10 If an existing bundle-enabled example exists, run it end-to-end: bundle loads via Worker Loader, dispatches a turn, SpineService bridges back to DO, events stream to client. Confirm byte-identical behavior to pre-split
