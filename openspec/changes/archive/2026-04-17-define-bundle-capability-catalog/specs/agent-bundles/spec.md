## ADDED Requirements

<!-- Section: Catalog integration with bundle dispatch -->

### Requirement: Bundle dispatch SHALL gate on capability catalog validation at pointer-flip and dispatch time

The `BundleDispatcher` contributed by `@crabbykit/bundle-host` SHALL integrate catalog validation into the bundle dispatch lifecycle via two layers:

1. **Primary validation at `BundleRegistry.setActive`** — every promotion path (workshop_deploy, admin RPC, test harness) validates the catalog before flipping the pointer. A mismatch throws `CapabilityMismatchError`; the pointer does not flip.
2. **Dispatch-time guard in `dispatchTurn`** — before Worker Loader invocation, the dispatcher compares `state.activeVersionId` against `validatedVersionId`. If they differ, it re-validates against the current host capability set to catch out-of-band mutations that bypassed `setActive`.

On dispatch-time mismatch, the dispatcher SHALL clear the pointer via `setActive(agentId, null, { skipCatalogCheck: true, rationale, sessionId })` and broadcast a structured `bundle_disabled` event.

This requirement integrates the catalog capability with the existing bundle-dispatch surface. It does not modify the bundle-side SpineService RPC contract, does not change the capability token model, and does not alter the static-fallback path except to route catalog mismatches through it automatically.

#### Scenario: Promotion with matching catalog flips pointer
- **WHEN** `workshop_deploy` (or any caller) invokes `setActive` with a bundle whose declaration matches the host's capabilities
- **THEN** the pointer flips and the dispatcher picks up the new version on the next turn without a separate validation step

#### Scenario: Promotion with mismatching catalog rejects at source
- **WHEN** `setActive` is called with a bundle whose declaration includes an id not in `knownCapabilityIds`
- **THEN** `setActive` throws `CapabilityMismatchError`, the pointer stays at its previous value, and the dispatcher never sees the mismatched version

#### Scenario: Out-of-band pointer mutation caught at dispatch
- **WHEN** a test or admin script directly flips the pointer without going through `setActive`
- **AND** the mutated version has a declaration mismatched with the host
- **THEN** the next `dispatchTurn` guard detects the mismatch, clears the pointer via `setActive(..., null, { skipCatalogCheck: true })`, broadcasts `bundle_disabled` with `reason.code: "ERR_CAPABILITY_MISMATCH"`, and falls back to static

#### Scenario: Catalog validation is separate from load failures
- **WHEN** a bundle fails catalog validation at the dispatch-time guard
- **AND** a different bundle version fails Worker Loader instantiation on a later turn
- **THEN** the two failure modes route through different paths: the first through `disableForCatalogMismatch` (immediate, no failure counting), the second through the existing `autoRevert` path (counted against `maxLoadFailures`)

## MODIFIED Requirements

<!-- Section: Auto-revert scope -->

### Requirement: Auto-revert applies only to transient load failures

The existing `maxLoadFailures` counter and `autoRevert` behavior on `BundleDispatcher` SHALL apply only to non-deterministic failures that might succeed on retry — Worker Loader errors, missing bytes in the registry, isolate construction errors, runtime exceptions during bundle `/turn` invocation. It SHALL NOT apply to catalog mismatches, which are deterministic and handled by the separate immediate-disable path (either `setActive` throwing at promotion time, or the dispatch-time guard clearing the pointer).

The consecutive-failure counter SHALL NOT increment on catalog-mismatch events. The counter SHALL reset to zero whenever the pointer is cleared for any reason (including catalog mismatch).

#### Scenario: Load failures counted, catalog mismatches not counted
- **WHEN** a bundle has suffered 2 consecutive Worker Loader failures
- **AND** the dispatch-time guard subsequently detects a catalog mismatch on a new active version
- **THEN** the catalog mismatch clears the pointer immediately and resets `consecutiveFailures` to 0; the "third failure" auto-revert branch is NOT triggered

#### Scenario: Auto-revert still works for transient errors
- **WHEN** three consecutive Worker Loader failures occur for the same version
- **THEN** the existing auto-revert path clears the pointer after the third failure — this proposal does not change that behavior

<!-- Section: bundle_disabled event payload -->

### Requirement: The `bundle_disabled` agent event SHALL carry a structured reason in addition to the existing rationale string

The agent event broadcast when a bundle is disabled (via manual disable, auto-revert, or catalog mismatch) SHALL carry both:

- `data.rationale: string` — the existing human-readable field, preserved unchanged for consumers that only read strings.
- `data.reason?: { code: string; ...extra }` — a new optional structured field. In v1 the only defined code is `"ERR_CAPABILITY_MISMATCH"`, whose payload extends the base shape with `missingIds: string[]` and `versionId: string`. Other disable paths (manual, auto-revert) MAY omit `reason` or populate it with a different code in future proposals.

Consumers that switch on `data.reason.code` SHALL NOT treat absence of the field as an error; the field is optional and absent values are preserved legacy behavior.

#### Scenario: Catalog mismatch event carries structured reason
- **WHEN** a catalog-mismatch disable fires
- **THEN** the broadcast `bundle_disabled` event has `data.reason = { code: "ERR_CAPABILITY_MISMATCH", missingIds: [...], versionId: "..." }` and `data.rationale` is a human-readable string derived from the same fields

#### Scenario: Manual disable omits structured reason
- **WHEN** an operator calls `POST /bundle/disable` on an agent
- **THEN** the event's `data.rationale` says `"manual disable"` (or the caller-supplied string) and `data.reason` is absent or `undefined` — backward-compatible with the existing manual-disable flow

#### Scenario: Client UI can discriminate on reason code
- **WHEN** an agent UI receives a `bundle_disabled` event
- **AND** `data.reason?.code === "ERR_CAPABILITY_MISMATCH"`
- **THEN** it can render a structured diagnostic naming the missing ids instead of only displaying the opaque rationale string
