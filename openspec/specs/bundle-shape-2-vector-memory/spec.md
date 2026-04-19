# bundle-shape-2-vector-memory Specification

## Purpose
TBD - created by archiving change bundle-shape-2-rollout. Update Purpose after archive.
## Requirements
### Requirement: `@crabbykit/vector-memory` SHALL expose four subpaths

The package SHALL expose its public API via four `package.json` `exports` entries: `.` (legacy static factory), `./service` (host-side `WorkerEntrypoint`), `./client` (bundle-side capability factory), and `./schemas` (shared schemas + drift hash). The legacy `.` export SHALL preserve the existing `vectorMemory(options: VectorMemoryOptions): Capability` factory unchanged.

#### Scenario: Package exports map lists four subpaths
- **WHEN** `package.json` is read
- **THEN** the `exports` object contains exactly the keys `"."`, `"./service"`, `"./client"`, `"./schemas"`

#### Scenario: Legacy import behaviour is preserved
- **WHEN** a consumer imports `{ vectorMemory }` from `@crabbykit/vector-memory`
- **THEN** the function returned matches the pre-change `vectorMemory` factory signature and behavior

<!-- Section: Service entrypoint -->

### Requirement: `VectorMemoryService` SHALL verify the unified bundle token with `requiredScope: "vector-memory"`

The `WorkerEntrypoint` exported from `@crabbykit/vector-memory/service` SHALL be a class named `VectorMemoryService`. Its env SHALL include `AGENT_AUTH_KEY: string`, `STORAGE_BUCKET: R2Bucket`, `STORAGE_NAMESPACE: string`, `MEMORY_INDEX: VectorizeIndex`, `AI: Ai`, and `SPINE`. The service SHALL lazily derive a verify-only HKDF subkey from `AGENT_AUTH_KEY` using `BUNDLE_SUBKEY_LABEL` and cache it for the entrypoint instance lifetime.

Every RPC method SHALL call `verifyToken(token, subkey, { requiredScope: "vector-memory" })` before doing other work and SHALL throw `new Error(verifyResult.code)` when verification fails.

#### Scenario: Token without "vector-memory" scope is rejected
- **WHEN** an RPC method is called with a `__BUNDLE_TOKEN` whose `scope` array does NOT contain `"vector-memory"`
- **THEN** the method throws an Error whose message equals `ERR_SCOPE_DENIED`
- **AND** the method does not perform any embedding, Vectorize query, or R2 read

#### Scenario: Subkey derivation cached per entrypoint
- **WHEN** a single `VectorMemoryService` instance receives N RPC calls
- **THEN** `deriveVerifyOnlySubkey` is called exactly once

<!-- Section: search method -->

### Requirement: `VectorMemoryService.search` SHALL embed the query, query Vectorize, and return matched chunk content

`VectorMemoryService` SHALL expose `search(token: string, args: { query: string; maxResults?: number }, schemaHash?: string): Promise<{ results: Array<{ path: string; score: number; content: string }> }>`. After token + schema-hash verification, the method SHALL embed `args.query` via the configured Workers AI binding, query the Vectorize index for top-`maxResults` matches (default 5), fetch matched chunks from R2 by their stored R2 key, and return them with their similarity scores.

#### Scenario: Schema hash mismatch fails closed
- **WHEN** `search` is called with a `schemaHash` that does not equal `SCHEMA_CONTENT_HASH`
- **THEN** the method throws `ERR_SCHEMA_VERSION`

#### Scenario: Query is embedded via Workers AI by default
- **WHEN** `search` is called and the service env's `AI` binding is the default Workers AI binding
- **THEN** the query is embedded via the `@cf/baai/bge-base-en-v1.5` model (matching the static capability's default embedder)

#### Scenario: maxResults defaults to 5 when omitted
- **WHEN** `search` is called with `args.maxResults` undefined
- **THEN** the Vectorize query requests at most 5 matches

#### Scenario: Empty result set returns empty array
- **WHEN** Vectorize returns no matches for the embedded query
- **THEN** the method returns `{ results: [] }`

<!-- Section: get method -->

### Requirement: `VectorMemoryService.get` SHALL return memory file content with a byte cap

`VectorMemoryService` SHALL expose `get(token: string, args: { path: string }, schemaHash?: string): Promise<{ content: string }>`. After token + schema-hash verification, the method SHALL read the R2 object at the namespaced key for `args.path`, decode it as UTF-8, truncate to a configurable byte cap (default 512 KB matching the static capability), and return the result. If the file does not exist, the method SHALL return `{ content: "" }` (or equivalent textual indicator) rather than throw.

#### Scenario: Path under namespace prefix resolves to R2 object
- **WHEN** `get` is called with `args.path = "MEMORY.md"`
- **AND** the namespace prefix is `"agents/abc"`
- **THEN** the R2 lookup uses the key `"agents/abc/MEMORY.md"`

#### Scenario: Missing file returns empty content
- **WHEN** `get` is called for a path with no R2 object
- **THEN** the method returns `{ content: "" }` (or equivalent indicator)
- **AND** the method does not throw

#### Scenario: Oversized content is truncated
- **WHEN** `get` is called for a file larger than the byte cap
- **THEN** the returned content's byte length is at most the byte cap

<!-- Section: Bundle client -->

### Requirement: `vectorMemoryClient` factory SHALL return a `Capability` exposing `memory_search` and `memory_get` tools plus a content-only prompt section

The function exported from `@crabbykit/vector-memory/client` SHALL be `vectorMemoryClient(options: { service: Service<VectorMemoryService> }): Capability`. The returned capability SHALL have `id: "vector-memory"`, SHALL register exactly two tools (`memory_search`, `memory_get`), SHALL include a content-only `promptSections` describing the memory system, and SHALL NOT register `hooks`, `httpHandlers`, `configNamespaces`, or `onAction`.

The bundle-side `promptSections` text SHALL be functionally equivalent to the static capability's section. Auto-reindexing of `MEMORY.md` and `memory/*.md` files works for bundle agents via the `bundle-host-hook-bridging` mechanism (the static capability's `afterToolExecution` indexing hook fires against bundle-originated file mutation events through the bridge), so the prompt MAY accurately describe indexing as automatic.

Both tools' `execute` functions SHALL read `env.__BUNDLE_TOKEN`, throw an Error containing `Missing __BUNDLE_TOKEN` when undefined, and call the corresponding service method with `(token, args, SCHEMA_CONTENT_HASH)`.

#### Scenario: Capability id matches the catalog scope string
- **WHEN** `vectorMemoryClient(...)` is invoked
- **THEN** the returned capability's `id` is the literal string `"vector-memory"`

#### Scenario: Bundle without `__BUNDLE_TOKEN` env field fails fast
- **WHEN** either tool is executed in a context whose `env.__BUNDLE_TOKEN` is undefined
- **THEN** the tool throws an Error containing `Missing __BUNDLE_TOKEN`

#### Scenario: Bundle client registers no host-only surfaces
- **WHEN** the returned capability is inspected
- **THEN** it has no `hooks`, no `httpHandlers`, no `configNamespaces`, and no `onAction` keys

<!-- Section: Shared schemas -->

### Requirement: `@crabbykit/vector-memory/schemas` SHALL export tool names, descriptions, args schemas, and a versioned content hash

The schemas subpath SHALL export named constants for both tool names + descriptions, TypeBox `Type.Object(...)` args schemas for each, and `SCHEMA_CONTENT_HASH: string`. The hash SHALL be initially `"vector-memory-schemas-v1"`.

#### Scenario: Initial schema version constant
- **WHEN** `SCHEMA_CONTENT_HASH` is read
- **THEN** its value is the string `"vector-memory-schemas-v1"`

#### Scenario: search args schema requires query
- **WHEN** the search args schema is used to validate `{ maxResults: 3 }`
- **THEN** validation fails (missing required `query`)

#### Scenario: get args schema requires path
- **WHEN** the get args schema is used to validate `{}`
- **THEN** validation fails (missing required `path`)

<!-- Section: Auto-reindexing parity -->

### Requirement: Bundle agents SHALL receive auto-reindexing equivalent to static agents via the host hook bridge

A bundle agent that wires `vectorMemoryClient(...)` AND uses `fileToolsClient(...)` to mutate memory files SHALL observe the same auto-reindexing behavior a static-brain agent observes. The static `vector-memory` capability's `afterToolExecution` indexing hook fires against bundle-originated `file_write`/`file_edit`/`file_delete` events via the `bundle-host-hook-bridging` bridge.

The bundle-side `vectorMemoryClient` SHALL NOT register an `afterToolExecution` hook of its own. Auto-reindexing is host-driven through the static capability + the bridge.

#### Scenario: Bundle file_write triggers re-indexing
- **WHEN** a bundle agent (with the static `vectorMemory(...)` wired host-side AND `vectorMemoryClient` + `fileToolsClient` wired bundle-side) calls the bundle's `file_write` tool to write `MEMORY.md`
- **THEN** the static `vector-memory` capability's `afterToolExecution` hook fires (via the bridge) for that event
- **AND** the Vectorize index is updated for the written file

#### Scenario: Static brain auto-reindexing is unaffected
- **WHEN** a static-brain agent (no bundle wired) calls `file_write` to write `MEMORY.md`
- **AND** the consumer wired both `fileTools(...)` and `vectorMemory(...)` statically
- **THEN** the static capability's `afterToolExecution` hook fires (via the static path) and re-indexes the file

#### Scenario: Bundle client does not register a duplicate indexing hook
- **WHEN** the returned `vectorMemoryClient` capability is inspected
- **THEN** it has no `hooks` key (or its `hooks.afterToolExecution` is undefined)

