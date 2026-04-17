## ADDED Requirements

<!-- Section: Declaration surface -->

### Requirement: Bundle authors SHALL declare required host capabilities via `requiredCapabilities`

Bundles SHALL be able to declare the host-side capabilities they require via a `requiredCapabilities` field on the `BundleAgentSetup` object passed to `defineBundleAgent`. Each declaration is an object `{ id: string }`, where `id` matches a capability's canonical kebab-case identifier (e.g. `"tavily-web-search"`, `"file-tools"`).

The `@claw-for-cloudflare/bundle-sdk` package SHALL export a `BundleCapabilityRequirement` type with the above shape. `BundleAgentSetup.requiredCapabilities` SHALL be optional; bundles that omit it behave identically to bundles that declare an empty array.

The declaration SHALL be persisted into the built bundle's `BundleMetadata` as `BundleMetadata.requiredCapabilities`. This proposal SHALL NOT repurpose the existing `BundleMetadata.capabilityIds` field — that field retains its existing semantics of "capability ids registered on the agent." The bundle's `/metadata` HTTP endpoint SHALL return `requiredCapabilities` so host-side tooling can inspect declarations without instantiating the bundle isolate.

#### Scenario: Bundle declares a single required capability
- **WHEN** a bundle author writes `defineBundleAgent({ model: ..., requiredCapabilities: [{ id: "tavily-web-search" }] })`
- **THEN** the resulting bundle's `/metadata` response includes `requiredCapabilities: [{ id: "tavily-web-search" }]`
- **AND** `BundleMetadata.capabilityIds` (if present) is NOT populated from the declaration

#### Scenario: Bundle declares multiple capabilities
- **WHEN** a bundle declares `requiredCapabilities: [{ id: "tavily-web-search" }, { id: "file-tools" }]`
- **THEN** both records appear in metadata in declaration order

#### Scenario: Bundle without declaration
- **WHEN** a bundle author omits `requiredCapabilities` entirely from `defineBundleAgent`
- **THEN** the bundle's metadata carries `requiredCapabilities: undefined` (or equivalent empty form) and validation on the host treats it as "no requirements"

<!-- Section: Input validation -->

### Requirement: Declaration entries SHALL be input-validated at build time

`defineBundleAgent` SHALL validate every `requiredCapabilities` entry at build time. Invalid declarations SHALL throw with a clear error naming the offending entry.

The id SHALL match the regex `/^[a-z][a-z0-9-]*[a-z0-9]$/` (kebab-case, 2..64 characters). The list SHALL contain at most 64 entries. Null, undefined, non-string, or non-object entries SHALL be rejected. Duplicate ids SHALL be deduplicated silently (keep-first) rather than rejected, to forgive hand-authoring mistakes.

Validation SHALL protect downstream consumers from malformed input — null bytes, control characters, Unicode tricks, and unbounded length. A malicious or buggy bundle SHALL NOT be able to inject arbitrary strings into metadata.

#### Scenario: Id with invalid charset throws
- **WHEN** a bundle declares `requiredCapabilities: [{ id: "tavily web search" }]` (contains spaces)
- **THEN** `defineBundleAgent` throws at build time with an error naming the invalid id

#### Scenario: Id exceeding length limit throws
- **WHEN** a bundle declares an id longer than 64 characters
- **THEN** `defineBundleAgent` throws at build time

#### Scenario: List exceeding count limit throws
- **WHEN** a bundle declares more than 64 `requiredCapabilities` entries
- **THEN** `defineBundleAgent` throws at build time

#### Scenario: Duplicate ids deduplicate silently
- **WHEN** a bundle declares `[{ id: "tavily-web-search" }, { id: "tavily-web-search" }]`
- **THEN** `defineBundleAgent` writes `[{ id: "tavily-web-search" }]` (deduplicated) to metadata without throwing

#### Scenario: Null entry rejected
- **WHEN** a bundle declares `requiredCapabilities: [null, { id: "tavily-web-search" }]` (via a typed hole)
- **THEN** `defineBundleAgent` throws

<!-- Section: Validation at setActive -->

### Requirement: `BundleRegistry.setActive` SHALL validate capability catalog by default

Both `InMemoryBundleRegistry` and `D1BundleRegistry` SHALL enforce catalog validation in their `setActive` method. The signature SHALL accept `SetActiveOptions { knownCapabilityIds?: string[]; skipCatalogCheck?: boolean; rationale?: string; sessionId?: string }`.

When `versionId !== null` AND `skipCatalogCheck !== true`, the registry SHALL:

1. Require `options.knownCapabilityIds` to be provided. If missing, throw `TypeError("catalog validation requested without knownCapabilityIds")`.
2. Read `getVersion(versionId).metadata.requiredCapabilities`.
3. Compute `missing = required.filter(r => !knownIds.has(r.id))`, deduplicated.
4. If `missing.length > 0`, throw `CapabilityMismatchError { missingIds, versionId }` — the pointer SHALL NOT be flipped.
5. Otherwise flip the pointer as normal.

When `versionId === null` OR `skipCatalogCheck === true`, validation SHALL be skipped. Clearing the pointer always skips validation because there is nothing to validate.

The validation SHALL happen BEFORE any transaction/commit that flips the pointer, so a mismatch SHALL NOT leave the registry in a partially-flipped state.

#### Scenario: Matching catalog promotes successfully
- **WHEN** a bundle declares `[{ id: "tavily-web-search" }]` and the caller passes `knownCapabilityIds: ["tavily-web-search", "file-tools"]`
- **THEN** `setActive` flips the pointer and returns normally

#### Scenario: Missing capability rejects promotion
- **WHEN** a bundle declares `[{ id: "tavily-web-search" }]` and the caller passes `knownCapabilityIds: ["file-tools"]`
- **THEN** `setActive` throws `CapabilityMismatchError` with `missingIds: ["tavily-web-search"]` and the pointer is unchanged

#### Scenario: Caller explicitly opts out
- **WHEN** a caller passes `skipCatalogCheck: true`
- **THEN** `setActive` flips the pointer without reading metadata, regardless of `knownCapabilityIds`

#### Scenario: Clearing to null never validates
- **WHEN** a caller passes `versionId: null` (any `knownCapabilityIds` / `skipCatalogCheck` shape)
- **THEN** `setActive` flips the pointer to null without reading any metadata

#### Scenario: Missing knownCapabilityIds is a type error
- **WHEN** a caller passes `versionId: "v1"` and omits both `knownCapabilityIds` and `skipCatalogCheck`
- **THEN** `setActive` throws `TypeError` forcing the caller to be explicit about intent

#### Scenario: Legacy metadata without requiredCapabilities passes
- **WHEN** a pre-migration bundle version has `requiredCapabilities: undefined` in metadata
- **THEN** `setActive` treats it as "no requirements" and flips the pointer regardless of `knownCapabilityIds`

<!-- Section: Dispatch-time guard -->

### Requirement: `BundleDispatcher` SHALL guard against out-of-band pointer mutations

`BundleDispatcher` SHALL accept a `getHostCapabilityIds: () => string[]` callback at construction. Before each `dispatchTurn` reaches Worker Loader, the dispatcher SHALL compare `state.activeVersionId` against `validatedVersionId`. If they differ, the dispatcher SHALL validate the active version against the current host capability set and cache the result.

On mismatch, the dispatcher SHALL call `registry.setActive(agentId, null, { skipCatalogCheck: true, rationale: <human-readable string>, sessionId })` to clear the pointer, reset internal state, broadcast a `bundle_disabled` event with structured `reason`, and return `{ dispatched: false }` so the turn falls back to static brain.

The guard SHALL cover any pointer mutation that bypassed `setActive` — direct DB writes, schema migrations, misbehaving integrations. It does NOT replace `setActive` validation; it is a backstop.

The `validatedVersionId` cache SHALL short-circuit validation when the active version has not changed since the last successful validation. Each pointer change (via `refreshPointer` or cold-path discovery) SHALL reset `validatedVersionId` to `null`.

#### Scenario: Already-validated version does not re-check
- **WHEN** `dispatchTurn` runs with `state.activeVersionId === validatedVersionId`
- **THEN** no registry metadata read occurs; the turn proceeds to Worker Loader invocation

#### Scenario: Out-of-band pointer mutation caught at guard
- **WHEN** a direct DB write flips `activeVersionId` to a version with a missing capability
- **AND** the dispatcher's `validatedVersionId` is unaware of the new id
- **AND** the next `dispatchTurn` runs
- **THEN** the guard fetches metadata, detects the mismatch, clears the pointer via `setActive(..., null, {skipCatalogCheck: true})`, broadcasts `bundle_disabled` with structured reason, and returns `{ dispatched: false }`

#### Scenario: Pointer refresh resets the cache
- **WHEN** `refreshPointer` observes a new active version id
- **THEN** `validatedVersionId` is reset to `null` so the next turn triggers revalidation

#### Scenario: Cold start with cached pointer against a redeployed host
- **WHEN** a DO cold-starts with `ctx.storage.activeBundleVersionId === "v-old"` from a prior isolate lifetime
- **AND** the host Worker has been redeployed since then with a capability the bundle declares no longer bound
- **AND** the dispatcher's `validatedVersionId` is `null` (fresh isolate, no cache)
- **THEN** the first `dispatchTurn` guard fires because `activeVersionId !== validatedVersionId`
- **AND** validation detects the mismatch, disables the bundle, and broadcasts `bundle_disabled` with `reason.code: "ERR_CAPABILITY_MISMATCH"`
- **AND** the turn falls through to static brain

<!-- Section: Failure mode orthogonal to load failures -->

### Requirement: Catalog mismatches SHALL NOT count toward the `maxLoadFailures` counter

The existing `maxLoadFailures` counter on `BundleDispatcher` applies only to transient load failures (Worker Loader errors, missing bytes, isolate construction failures, runtime exceptions during bundle `/turn`). Catalog mismatches SHALL be routed through the separate `disableForCatalogMismatch` path that immediately clears the pointer without incrementing `consecutiveFailures`.

The `consecutiveFailures` counter SHALL reset to zero whenever the pointer is cleared for any reason, including catalog mismatch.

#### Scenario: Catalog mismatch does not increment load-failure counter
- **WHEN** a bundle has `consecutiveFailures = 2` from prior Worker Loader failures
- **AND** a new version with a catalog mismatch is promoted (via `dispatchTurn` guard, since `setActive` would have rejected)
- **THEN** the guard clears the pointer immediately, `consecutiveFailures` is reset to `0`, and the third-failure auto-revert branch does NOT fire

#### Scenario: Auto-revert still works for transient errors
- **WHEN** three consecutive Worker Loader failures occur for the same version
- **THEN** the existing auto-revert path clears the pointer after the third failure — this proposal does not change that behavior

<!-- Section: Client-facing event -->

### Requirement: `bundle_disabled` event SHALL carry a structured reason for catalog mismatches

When the dispatcher disables a bundle due to catalog mismatch, the broadcast `bundle_disabled` agent event SHALL include a structured `data.reason` field with shape `{ code: "ERR_CAPABILITY_MISMATCH", missingIds: string[], versionId: string }`. The existing `data.rationale` human-readable string SHALL continue to be populated.

`data.reason` SHALL be optional. Existing consumers that read only `rationale` SHALL continue to function unchanged. Future `reason.code` values may be added to the union without breaking existing consumers.

#### Scenario: Catalog mismatch event carries structured reason
- **WHEN** a catalog-mismatch disable fires
- **THEN** the broadcast `bundle_disabled` event has `data.reason = { code: "ERR_CAPABILITY_MISMATCH", missingIds: [...], versionId: "..." }`
- **AND** `data.rationale` is a human-readable string derived from the same fields

#### Scenario: Client UI can discriminate on reason code
- **WHEN** an agent UI receives a `bundle_disabled` event with `data.reason.code === "ERR_CAPABILITY_MISMATCH"`
- **THEN** it can render a structured diagnostic naming the missing ids instead of displaying only the opaque rationale string

<!-- Section: Unknown ids -->

### Requirement: Unknown capability ids SHALL fail validation at the same immediate-disable pathway

A declaration id that does not match any id in the host's known capability set SHALL be treated identically to a missing declared capability. The dispatcher and registry SHALL NOT accept declarations with a "soft" fuzzy match, a warning-only disposition, or any silent-ignore behavior.

The declaration is a contract; violating it by naming an id that does not exist disables the bundle. This protects against typos, against stale declarations referring to renamed capabilities, and against bundles authored for one deployment's capability set that get promoted into a different deployment.

#### Scenario: Typo in capability id
- **WHEN** a bundle declares `requiredCapabilities: [{ id: "tavlly-web-search" }]` (note the typo, passes charset validation)
- **THEN** `setActive` throws `CapabilityMismatchError` with `missingIds: ["tavlly-web-search"]` so the operator can diagnose the typo immediately

#### Scenario: Capability renamed out from under a declaration
- **WHEN** a capability id changes from `"tavily"` to `"tavily-web-search"` in the workspace
- **AND** an older bundle version still declares `{ id: "tavily" }` in its metadata
- **THEN** validation fails on the renamed host and the bundle cannot be promoted without re-authoring

<!-- Section: Workshop advisory + escape hatch -->

### Requirement: `workshop_deploy` SHALL provide a `skipCatalogCheck` escape hatch for cross-deployment promotions

The `workshop_deploy` tool SHALL pass `knownCapabilityIds: getBundleHostCapabilityIds()` and enforce catalog validation by default. The tool SHALL accept a `skipCatalogCheck?: boolean` input that, when `true`, passes `skipCatalogCheck: true` to `setActive`. This supports the use case where an operator promotes a bundle from a workshop whose capability set intentionally differs from the target deployment.

When `skipCatalogCheck` is used, validation falls to the dispatch-time guard in the target deployment; promotion does not validate there.

`workshop_build` SHALL emit an advisory warning line for each declared id not present in the workshop's own capability set. The warning SHALL NOT block the build.

#### Scenario: Default deploy enforces catalog
- **WHEN** `workshop_deploy` runs without `skipCatalogCheck`
- **AND** the bundle declares a capability that is not registered on the workshop's host
- **THEN** `setActive` throws `CapabilityMismatchError` and the tool surfaces the error to the operator; promotion does not happen

#### Scenario: Explicit skip flag allows cross-deployment promotion
- **WHEN** `workshop_deploy` runs with `skipCatalogCheck: true`
- **AND** the workshop's host set does not satisfy the declaration
- **THEN** `setActive` flips the pointer without validating; the target deployment's dispatch-time guard handles validation on first dispatch

#### Scenario: Workshop build warns without blocking
- **WHEN** `workshop_build` completes for a bundle declaring `[{ id: "tavily-web-search" }]` and the workshop host lacks that id
- **THEN** the tool's response includes an advisory warning naming the missing id; the build artifact is produced and can be promoted
