## MODIFIED Requirements

<!-- Section: Package boundaries -->

### Requirement: Bundle authoring SDK is a separate package

The bundle authoring surface SHALL be packaged as `@crabbykit/bundle-sdk`, separate from the host-side dispatcher. This package SHALL contain `defineBundleAgent`, `BundleEnv`, `BundleContext`, `BundleCapability`, `BundleExport`, the bundle's small async runtime (`buildBundleContext`, `runBundleTurn`), the bundle prompt builder, and the bundle-side spine client classes.

`@crabbykit/bundle-sdk` SHALL have zero runtime imports of `cloudflare:workers`. Type-only imports of `Service<T>` from `@cloudflare/workers-types` (as a devDependency) are permitted for authoring ergonomics. The package SHALL be usable in a bundle project's `tsconfig` without requiring `@cloudflare/workers-types` at runtime and without exposing any `WorkerEntrypoint`, `DurableObject`, or `WorkerLoader` symbols.

`@crabbykit/bundle-sdk` SHALL NOT export any function that mints capability tokens. Token minting symbols (`mintToken`, `deriveMintSubkey`) SHALL be unreachable from the bundle-sdk barrel and any of its re-exports. A bundle author importing from `@crabbykit/bundle-sdk` SHALL be structurally incapable of forging tokens.

#### Scenario: Bundle author install footprint
- **WHEN** a developer creates a new bundle project and runs `bun add @crabbykit/bundle-sdk`
- **THEN** the install pulls in `@crabbykit/bundle-token`, `@crabbykit/agent-runtime` (type re-exports), and `@sinclair/typebox` — and does NOT pull in `@crabbykit/bundle-host` as a runtime dependency

#### Scenario: Mint code unreachable from SDK
- **WHEN** bundle-sdk source or tests attempt `import { mintToken } from "@crabbykit/bundle-sdk"`
- **THEN** TypeScript reports an error — the symbol is not exported from the SDK barrel or any subpath

#### Scenario: Bundle authoring without Workers types
- **WHEN** a bundle project's `tsconfig.json` does not include `@cloudflare/workers-types` in `types` and compiles only the bundle's own source using `@crabbykit/bundle-sdk`
- **THEN** type-checking succeeds — every runtime reference in bundle-sdk is substrate-free

### Requirement: Host dispatcher is a separate package

The host-side bundle dispatcher, `SpineService` WorkerEntrypoint, `LlmService` WorkerEntrypoint, budget tracker, in-memory registry test helper, and capability token mint utilities SHALL be packaged as `@crabbykit/bundle-host`. This package SHALL be consumed by the worker hosting agent DOs when bundle brain override is desired.

`@crabbykit/bundle-host` SHALL own the HKDF master-secret handling via its environment (`AGENT_AUTH_KEY`). The master secret SHALL NOT be reachable from `@crabbykit/bundle-sdk` or `@crabbykit/bundle-token` via any import path.

The `BundleConfig` type consumed by `defineAgent`'s `bundle:` field SHALL be exported from `@crabbykit/bundle-host`.

#### Scenario: Worker wires bundle support
- **WHEN** a worker author enables bundle brain override on an agent
- **THEN** they import `BundleConfig` from `@crabbykit/bundle-host` and pass it to `defineAgent({ bundle: ... })`

#### Scenario: SpineService lives in bundle-host
- **WHEN** a worker author exports a `SpineService` as a WorkerEntrypoint class to be bound as a service
- **THEN** the class is imported from `@crabbykit/bundle-host`

#### Scenario: Master secret is host-side only
- **WHEN** a reviewer audits the codebase for uses of `env.AGENT_AUTH_KEY`
- **THEN** all uses are located in `packages/runtime/bundle-host/src/**` — no reference exists in `bundle-sdk` or `bundle-token`

### Requirement: Token primitives live in a dedicated micro-package

Capability token types, HKDF subkey derivation, verification helpers, and nonce tracking SHALL be packaged as `@crabbykit/bundle-token`. This package SHALL be the shared dependency of both `@crabbykit/bundle-sdk` and `@crabbykit/bundle-host`.

`@crabbykit/bundle-token` SHALL export:
- `Token`, `TokenPayload`, `VerifyOutcome` types
- `deriveVerifyOnlySubkey(masterKey: string, label: string): Promise<CryptoKey>` — returns a CryptoKey with `usages: ["verify"]` only
- `verifyToken(token, subkey, nonceTracker): Promise<VerifyOutcome>`
- `NonceTracker` — bounded LRU nonce tracker

`@crabbykit/bundle-token` SHALL NOT export `mintToken`, `deriveMintSubkey`, or any function capable of producing a new signed token. Those symbols live exclusively in `@crabbykit/bundle-host/src/security/mint.ts`.

#### Scenario: Bundle-side verification without host dependency
- **WHEN** bundle-sdk code needs to verify a token received from the host (e.g. validating a response signature)
- **THEN** it imports `verifyToken` and `deriveVerifyOnlySubkey` from `@crabbykit/bundle-token` without pulling in `@crabbykit/bundle-host`

#### Scenario: HKDF derives asymmetric key usages
- **WHEN** the host calls `deriveMintSubkey` (from `bundle-host/security/mint.ts`) with a label like `"claw/spine-v1"`
- **AND** the bundle-sdk or host calls `deriveVerifyOnlySubkey` (from `bundle-token`) with the same label
- **THEN** the resulting CryptoKeys are compatible (same underlying HMAC secret) but have disjoint usage sets: mint key can sign, verify key can verify; neither can do the other

#### Scenario: Token package has zero non-token surface
- **WHEN** a reviewer enumerates the exports of `@crabbykit/bundle-token`
- **THEN** every exported symbol relates to tokens (types, verify, subkey, nonce); no unrelated utilities leak in

### Requirement: SpineHost interface is owned by agent-runtime

The `SpineHost` interface — the contract that a host DO implements to receive bridged SpineService RPC calls — SHALL be exported from `@crabbykit/agent-runtime` alongside the other runtime contract interfaces (`SqlStore`, `KvStore`, `Scheduler`, `Transport`). It SHALL NOT be declared in `@crabbykit/bundle-host`, which merely imports the type.

The `AgentDO` class in `@crabbykit/agent-runtime` SHALL structurally satisfy the `SpineHost` interface. A type-level assertion in the runtime package SHALL enforce this satisfaction at compile time — any drift between `AgentDO` methods and the `SpineHost` interface SHALL produce a TypeScript error.

#### Scenario: SpineService imports interface from runtime
- **WHEN** `packages/runtime/bundle-host/src/services/spine-service.ts` needs to type-check a DO stub it bridges to
- **THEN** it uses `import type { SpineHost } from "@crabbykit/agent-runtime"`

#### Scenario: AgentDO drift surfaces at compile time
- **WHEN** a developer removes the `spineAppendEntry` method from `AgentDO` without updating the `SpineHost` interface
- **THEN** the type-level assertion in `agent-runtime` fails to compile, blocking the change

### Requirement: Deleted `@crabbykit/agent-bundle` package

The package `@crabbykit/agent-bundle` SHALL be deleted in full from the workspace. No stub package, re-export shim, or deprecation alias SHALL be introduced. The directory `packages/runtime/agent-bundle/` SHALL not exist after this change lands. Every file previously in that package SHALL live in one of `bundle-sdk`, `bundle-host`, or `bundle-token`, or in `@crabbykit/agent-runtime` in the case of the `SpineHost` interface.

All internal repository consumers SHALL update their imports in the same change. External consumers (there are none pre-release) SHALL migrate by replacing `@crabbykit/agent-bundle` imports with the appropriate split package identifier.

#### Scenario: Old package unresolvable
- **WHEN** any file attempts `import { anything } from "@crabbykit/agent-bundle"` after this change lands
- **THEN** module resolution fails — the package name is removed from the workspace and does not exist on npm

#### Scenario: Grep for old package name returns nothing
- **WHEN** a developer runs `grep -r "@crabbykit/agent-bundle" --include="*.ts" --include="*.json"` on the repository
- **THEN** the only hits are in git history, archived openspec changes, and this proposal's documentation — no hits in live source code

## ADDED Requirements

<!-- Section: Bundle runtime-source artifact placement -->

### Requirement: Bundle SDK exports a `./runtime-source` subpath with built constants

The `@crabbykit/bundle-sdk` package SHALL expose a `./runtime-source` subpath export that re-exports two constants from a build-time-generated file at `dist/bundle-runtime-source.js`:

- `BUNDLE_RUNTIME_SOURCE: string` — the bundle SDK runtime compiled to JavaScript via `bun build --target=browser`, captured as a string constant. This is the JS that gets injected into every bundle the workshop builds, so that user bundles run on a known SDK version.
- `BUNDLE_RUNTIME_HASH: string` — the SHA-256 hex digest of `BUNDLE_RUNTIME_SOURCE`. Used by the host auto-rebuild path to detect when the injected runtime has drifted from a deployed bundle's stored runtime hash.

The `build.ts` script that produces these constants SHALL live in the `bundle-sdk` package root and SHALL run on `postinstall` to guarantee the artifact is always present in the package's `dist/` directory. The script SHALL produce the corresponding `.d.ts` so TypeScript consumers of the `./runtime-source` subpath get proper types.

`@crabbykit/bundle-host` SHALL import these constants from `@crabbykit/bundle-sdk/runtime-source`. No other package in the workspace SHALL duplicate or re-derive these constants.

#### Scenario: Host reads injected runtime source from SDK
- **WHEN** `bundle-host/src/bundle-builder.ts` needs to rebuild a stale bundle from R2 source
- **THEN** it imports `BUNDLE_RUNTIME_SOURCE` from `@crabbykit/bundle-sdk/runtime-source` and injects it into the rebuilt bundle

#### Scenario: Drift detection compares hashes
- **WHEN** `AgentDO.initBundleDispatch` runs its one-shot drift check on first bundle turn per DO wake
- **THEN** it compares the active bundle version's stored `metadata.runtimeHash` against `BUNDLE_RUNTIME_HASH` imported from `@crabbykit/bundle-sdk/runtime-source`; a mismatch triggers the auto-rebuild path

#### Scenario: Postinstall generates the artifact
- **WHEN** a consumer runs `bun install` in a project depending on `@crabbykit/bundle-sdk`
- **THEN** the `postinstall` script runs `bun build.ts`, producing `dist/bundle-runtime-source.js` and `dist/bundle-runtime-source.d.ts` before any dependent package attempts to import from the subpath

<!-- Section: Circular-dep-break types stay in agent-runtime -->

### Requirement: Minimal bundle types stay in agent-runtime to avoid circular dep

The file `packages/runtime/agent-runtime/src/bundle-config.ts` SHALL continue to exist after the bundle package split. It declares a minimal subset of bundle-related types (`BundleVersionMetadata`, `BundleVersionInfo`, `CreateBundleVersionOpts`) that `AgentDO.initBundleDispatch` references for the drift-detection and auto-rebuild paths.

These types SHALL be declared inline in `agent-runtime` rather than imported from `@crabbykit/bundle-host` or `@crabbykit/bundle-sdk`, because both packages depend on `@crabbykit/agent-runtime` and a reverse dependency would introduce a cycle.

The fuller `BundleConfig<TEnv>` type (the consumer-facing configuration type with `registry`, `loader`, `autoRebuild` fields) SHALL live in `@crabbykit/bundle-host` and import the minimal types from `@crabbykit/agent-runtime` to stay structurally aligned.

The `BundleRegistry` interface declared in `bundle-host/src/bundle-config.ts` SHALL have a shape compatible with the one in `@crabbykit/bundle-registry` such that the D1-backed implementation from `bundle-registry` satisfies it structurally.

#### Scenario: Agent-runtime references types without importing bundle-host
- **WHEN** `agent-runtime/src/agent-do.ts` uses `BundleVersionMetadata` in the `initBundleDispatch` drift-check path
- **THEN** the import is from `./bundle-config.js` (same package), not from `@crabbykit/bundle-host`

#### Scenario: No circular dep at install time
- **WHEN** `bun install` resolves the workspace graph
- **THEN** neither `@crabbykit/agent-runtime` nor `@crabbykit/bundle-host` appears in the other's ancestor dependency chain; the two packages depend on each other only through `bundle-host → agent-runtime`, never `agent-runtime → bundle-host`

#### Scenario: Bundle-host's full BundleConfig imports minimal types from agent-runtime
- **WHEN** `bundle-host/src/bundle-config.ts` declares the `autoRebuild` field type referencing `BundleVersionMetadata`
- **THEN** it imports `BundleVersionMetadata` from `@crabbykit/agent-runtime`, not from a local redeclaration

<!-- Section: Bundle SDK type-check surface -->

### Requirement: Bundle SDK imports are substrate-neutral at type-check time

The package `@crabbykit/bundle-sdk` SHALL type-check successfully under a TypeScript configuration that does NOT include `@cloudflare/workers-types` as a global ambient types source. The package's public API MAY reference `Service<T>` through an explicit type-only import from `@cloudflare/workers-types` (with the package as a devDependency only). No other Workers-specific type SHALL appear in `bundle-sdk`'s public API.

This ensures bundle authors can compile their bundle projects with minimal CF-specific tooling overhead and that `bundle-sdk` is positioned for future portability to non-Cloudflare isolation backends (if such backends are ever added), without any API-level rework.

#### Scenario: Bundle project without Workers types globally
- **WHEN** a bundle project's `tsconfig.json` omits `"types": ["@cloudflare/workers-types"]` from its compiler options
- **AND** the project depends on `@crabbykit/bundle-sdk` for authoring
- **THEN** the project type-checks successfully

#### Scenario: Explicit Service<T> import is allowed
- **WHEN** `bundle-sdk/src/types.ts` uses `Service<T>` to type a field in `BundleEnv`
- **THEN** the file imports `import type { Service } from "@cloudflare/workers-types"` explicitly, not via a global ambient type
