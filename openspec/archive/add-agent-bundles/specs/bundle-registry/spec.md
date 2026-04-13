## ADDED Requirements

### Requirement: BundleRegistry interface

The system SHALL provide a `BundleRegistry` interface with methods for bundle version creation, active-version pointer management, deployment audit logging, and version listing. A D1-backed reference implementation (`D1BundleRegistry`) SHALL ship as the default. The interface SHALL support in-memory implementations for unit testing. The interface SHALL encapsulate both D1 metadata and KV bundle bytes operations behind a single object so consumers do not handle KV and D1 separately.

#### Scenario: Registry contract implementable
- **WHEN** a developer writes a custom `InMemoryBundleRegistry` class that implements the `BundleRegistry` interface
- **THEN** the class satisfies the TypeScript interface and can be passed to `defineLoaderAgent`'s `registry` factory

### Requirement: Content-addressed bundle version IDs

The system SHALL compute bundle version IDs as SHA-256 hashes (hex-encoded) of compiled bundle artifact bytes. Two identical artifacts SHALL produce the same version ID. A version ID SHALL be used as both the KV key suffix for the bundle bytes and the Worker Loader cache key.

#### Scenario: Deterministic version ID
- **WHEN** the same artifact bytes are hashed twice
- **THEN** both hashes produce the identical version ID string

#### Scenario: Version ID reuse across agents
- **WHEN** two agents deploy the same bundle content
- **THEN** they share the same version ID, the same KV entry, and the same Worker Loader cache slot

### Requirement: D1 schema self-seeding

The `D1BundleRegistry` SHALL self-seed its schema on first use by running CREATE TABLE IF NOT EXISTS statements for `bundle_versions`, `agent_bundles`, and `bundle_deployments` tables, plus the required indexes. The schema migration SHALL follow the pattern established by `packages/skill-registry`.

#### Scenario: First use against empty D1
- **WHEN** a worker with a fresh D1 binding first constructs a `D1BundleRegistry` and issues a query
- **THEN** all three tables and their indexes are created if absent, and the query then succeeds against the initialized schema

### Requirement: bundle_versions table schema

The `bundle_versions` table SHALL store one row per unique bundle artifact with columns: `version_id` (TEXT PRIMARY KEY — content hash), `kv_key` (TEXT NOT NULL), `size_bytes` (INTEGER NOT NULL), `created_at` (INTEGER NOT NULL — unix millis), `created_by` (TEXT NULL — agent ID of deployer), and `metadata` (TEXT NULL — JSON string containing declared model, capability names, author name, description).

#### Scenario: New version inserted
- **WHEN** a deploy operation calls `registry.createVersion({ versionId, kvKey, sizeBytes, createdBy, metadata })`
- **THEN** a row is inserted into `bundle_versions` with the specified values and the same `version_id` cannot be inserted again without a conflict error

### Requirement: agent_bundles table schema

The `agent_bundles` table SHALL store one row per agent with columns: `agent_id` (TEXT PRIMARY KEY), `active_version_id` (TEXT NOT NULL REFERENCES bundle_versions.version_id), `previous_version_id` (TEXT NULL REFERENCES bundle_versions.version_id), and `updated_at` (INTEGER NOT NULL).

#### Scenario: Setting active version updates previous
- **WHEN** `registry.setActive(agentId, newVersionId)` is called while the agent currently has `active_version_id = 'A'`
- **THEN** the row is updated to `active_version_id = newVersionId`, `previous_version_id = 'A'`, and `updated_at` is set to the current time

### Requirement: bundle_deployments append-only log

The `bundle_deployments` table SHALL store an append-only audit log with columns: `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `agent_id` (TEXT NOT NULL), `version_id` (TEXT NOT NULL REFERENCES bundle_versions.version_id), `deployed_at` (INTEGER NOT NULL), `deployed_by_session_id` (TEXT NULL), and `rationale` (TEXT NULL). Rows SHALL never be updated or deleted during normal operation.

#### Scenario: Deploy creates deployment log entry
- **WHEN** a deploy operation completes
- **THEN** a new row is inserted into `bundle_deployments` with the agent_id, the deployed version_id, the current timestamp, the originating session ID, and optionally a rationale string authored by the deploying agent

#### Scenario: Deployment history queryable
- **WHEN** `registry.listDeployments(agentId, { limit: 10 })` is called
- **THEN** the method returns the most recent ten deployment rows for that agent, ordered by `deployed_at` descending

### Requirement: D1 batch atomicity for multi-statement operations

Operations that touch multiple D1 rows (`setActive` and its associated `bundle_deployments` insert; `rollback` and its associated insert) SHALL use D1's `db.batch([...])` API to wrap the statements in a single atomic transaction. Sequential `.prepare().run()` calls SHALL NOT be used for multi-statement operations because D1 does not provide implicit transactions across separate calls.

#### Scenario: setActive uses batch
- **WHEN** `registry.setActive(agentId, newVersionId)` is invoked
- **THEN** the implementation issues a single `db.batch([updateAgentBundles, insertDeployment])` call; if any statement fails, neither change persists

### Requirement: Rollback atomicity

A rollback operation SHALL atomically swap `active_version_id` and `previous_version_id` in `agent_bundles` for the target agent, append a new row to `bundle_deployments` describing the rollback, and update `updated_at`. The operation SHALL be implemented via `db.batch([...])`.

#### Scenario: Successful rollback
- **WHEN** `registry.rollback(agentId, { rationale: "reverting broken deploy" })` is called while the agent has `active = 'B', previous = 'A'`
- **THEN** after the call the agent has `active = 'A', previous = 'B'`, and a new `bundle_deployments` row records the rollback to version A; both changes happen atomically

#### Scenario: Rollback with no previous version
- **WHEN** `registry.rollback(agentId)` is called on an agent whose `previous_version_id` is NULL
- **THEN** the method returns an error indicating no previous version exists and the registry state is unchanged

### Requirement: KV bundle bytes storage

Compiled bundle bytes SHALL be stored in a KV namespace using keys of the form `bundle:{versionId}`. The bytes SHALL be stored as binary values. Writes SHALL use no explicit TTL (indefinite retention). Reads SHALL return the bytes directly to the caller. Bundle bytes operations SHALL be exposed through the registry interface (`registry.putBytes`, `registry.getBytes`) so callers do not need direct KV namespace access.

#### Scenario: Write and read bundle bytes
- **WHEN** a deploy writes `registry.putBytes(versionId, bytes)` and a later turn reads `registry.getBytes(versionId)`
- **THEN** the read returns the identical byte content that was written

#### Scenario: KV size limit enforcement
- **WHEN** a deploy attempts to write a bundle whose size exceeds Cloudflare KV's 25 MiB per-value limit
- **THEN** the deploy fails with a clear error identifying the size as the cause and no partial state is left in the registry

### Requirement: Deploy read-back verification

`registry.createVersion` (or its higher-level wrapper invoked by `bundle_deploy`) SHALL NOT consider a bundle byte write successful when `kv.put` returns. The implementation SHALL poll `kv.get(bundleKey)` after the put with exponential backoff (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms — capped at ~5 seconds total) until the bytes are visible. Only after a successful readback SHALL the implementation insert the `bundle_versions` row and proceed to `setActive`. If readback fails within the timeout, the operation SHALL return an error and the registry state SHALL remain unchanged. Orphan KV entries from failed readbacks SHALL be tolerated (they are unreferenced by any pointer and will be cleaned up by the eventual GC tool).

#### Scenario: Readback succeeds on first poll
- **WHEN** a deploy calls `registry.createVersion` with bundle bytes and KV happens to be immediately consistent
- **THEN** the first `kv.get` returns the expected bytes, the `bundle_versions` row is inserted, and the deploy proceeds normally

#### Scenario: Readback succeeds after backoff
- **WHEN** KV's cross-location replication takes 300ms before the bytes are visible to the deploying isolate's KV reads
- **THEN** the deploy's polling sequence (50, 100, 200, ...) succeeds on the third attempt, and the deploy proceeds

#### Scenario: Readback fails after timeout
- **WHEN** KV's bytes are not visible within ~5 seconds
- **THEN** `registry.createVersion` returns an error identifying readback timeout as the cause; no `bundle_versions` row is inserted; the active pointer is unchanged; the deploy fails

### Requirement: Metadata JSON schema

The `bundle_versions.metadata` column SHALL store a JSON object describing the bundle's declared identity: `{ name?, description?, modelProvider?, modelId?, capabilities?: string[], authoredBy?, buildTimestamp? }`. Consumers SHALL be able to query the registry to produce human-readable bundle listings without re-reading the compiled bytes.

#### Scenario: Metadata populated on create
- **WHEN** the workshop's deploy tool calls `registry.createVersion` with metadata extracted from the bundle's `/metadata` endpoint
- **THEN** `bundle_versions.metadata` contains the JSON object and can be retrieved via `registry.getVersion(versionId)`
