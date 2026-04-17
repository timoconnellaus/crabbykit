## MODIFIED Requirements

<!-- Section: Reserved scope id rejection -->

### Requirement: Declaration entries SHALL be input-validated at build time

`defineBundleAgent` SHALL validate every `requiredCapabilities` entry at build time. Invalid declarations SHALL throw with a clear error naming the offending entry.

The id SHALL match the regex `/^[a-z][a-z0-9-]*[a-z0-9]$/` (kebab-case, 2..64 characters). The list SHALL contain at most 64 entries. Null, undefined, non-string, or non-object entries SHALL be rejected. Duplicate ids SHALL be deduplicated silently (keep-first) rather than rejected, to forgive hand-authoring mistakes.

Validation SHALL protect downstream consumers from malformed input — null bytes, control characters, Unicode tricks, and unbounded length. A malicious or buggy bundle SHALL NOT be able to inject arbitrary strings into metadata.

In addition to the charset, length, and count rules above, the validator SHALL reject ids that collide with the reserved scope strings used by the unified capability token. Specifically, the literal strings `"spine"` and `"llm"` SHALL NOT be accepted as capability ids. These strings are reserved for the two non-negotiable bundle→host channels (DO state/RPC and LLM inference) and are unconditionally prepended to every minted token's `scope` array by the dispatcher. Allowing a capability id to collide with a reserved scope would let a bundle obtain a reserved-scope-authorized token via a declaration that looks like a capability requirement — breaking the invariant that reserved scopes are author-independent.

The reserved-id check SHALL run at both layers: `defineBundleAgent` build-time validation AND `BundleRegistry.setActive` catalog validation. Both SHALL surface the same class of error naming the reserved collision.

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

#### Scenario: Reserved id `"spine"` rejected at build time
- **WHEN** a bundle declares `requiredCapabilities: [{ id: "spine" }]`
- **THEN** `defineBundleAgent` throws at build time with an error naming the reserved-scope collision

#### Scenario: Reserved id `"llm"` rejected at build time
- **WHEN** a bundle declares `requiredCapabilities: [{ id: "llm" }]`
- **THEN** `defineBundleAgent` throws at build time with an error naming the reserved-scope collision

#### Scenario: Reserved id rejected at `setActive`
- **WHEN** a bundle's metadata declares `requiredCapabilities: [{ id: "spine" }]` (e.g. hand-crafted metadata bypassing build-time validation)
- **AND** a caller invokes `BundleRegistry.setActive(bundleId, versionId, { knownCapabilityIds: [...] })`
- **THEN** `setActive` throws with an error naming the reserved-scope collision
- **AND** the active-version pointer is NOT flipped

#### Scenario: Reserved id rejected even with `skipCatalogCheck: true`
- **WHEN** a caller invokes `setActive(..., { skipCatalogCheck: true })` for a version whose metadata declares `{ id: "spine" }`
- **THEN** the reserved-id check still runs and rejects — `skipCatalogCheck` opts out of known-id validation, not out of reserved-string rejection
- **AND** the pointer is NOT flipped
