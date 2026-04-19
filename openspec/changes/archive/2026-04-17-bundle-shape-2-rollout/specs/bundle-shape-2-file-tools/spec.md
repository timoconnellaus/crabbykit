## ADDED Requirements

<!-- Section: Package layout -->

### Requirement: `@crabbykit/file-tools` SHALL expose four subpaths

The package SHALL expose its public API via four `package.json` `exports` entries: `.` (legacy static factory), `./service` (host-side `WorkerEntrypoint`), `./client` (bundle-side capability factory), and `./schemas` (shared schemas + drift hash). The legacy `.` export SHALL preserve the existing `fileTools(options: FileToolsOptions): Capability` factory unchanged.

#### Scenario: Package exports map lists four subpaths
- **WHEN** `package.json` is read
- **THEN** the `exports` object contains exactly the keys `"."`, `"./service"`, `"./client"`, `"./schemas"`

#### Scenario: Legacy import behaviour is preserved
- **WHEN** a consumer imports `{ fileTools }` from `@crabbykit/file-tools`
- **THEN** the function returned matches the pre-change `fileTools` factory signature and behavior

<!-- Section: Service entrypoint -->

### Requirement: `FileToolsService` SHALL verify the unified bundle token with `requiredScope: "file-tools"`

The `WorkerEntrypoint` exported from `@crabbykit/file-tools/service` SHALL be a class named `FileToolsService`. Its env SHALL include `AGENT_AUTH_KEY: string`, `STORAGE_BUCKET: R2Bucket`, and `STORAGE_NAMESPACE: string`. (No `SPINE` binding required — UI mutation broadcast is handled by the static capability's `afterToolExecution` hook firing via the host hook bridge, not by the service.) The service SHALL lazily derive a verify-only HKDF subkey from `AGENT_AUTH_KEY` using `BUNDLE_SUBKEY_LABEL` and cache it for the entrypoint instance lifetime.

Every RPC method SHALL call `verifyToken(token, subkey, { requiredScope: "file-tools" })` before doing other work and SHALL throw `new Error(verifyResult.code)` when verification fails.

#### Scenario: Token without "file-tools" scope is rejected
- **WHEN** any RPC method is called with a `__BUNDLE_TOKEN` whose `scope` array does NOT contain `"file-tools"`
- **THEN** the method throws an Error whose message equals `ERR_SCOPE_DENIED`
- **AND** the method does not perform any R2 operation

#### Scenario: Subkey derivation cached per entrypoint
- **WHEN** a single `FileToolsService` instance receives N RPC calls
- **THEN** `deriveVerifyOnlySubkey` is called exactly once

#### Scenario: Service env does not require SPINE
- **WHEN** `FileToolsService` is instantiated with an env containing only `AGENT_AUTH_KEY`, `STORAGE_BUCKET`, and `STORAGE_NAMESPACE`
- **THEN** all nine RPC methods execute successfully (no spine call is required from inside the service)

<!-- Section: Tool methods -->

### Requirement: `FileToolsService` SHALL expose nine RPC methods, one per file-tools tool

The service SHALL expose nine async methods matching the static capability's nine tools: `read`, `write`, `edit`, `delete`, `copy`, `move`, `list`, `tree`, `find`. Each SHALL accept `(token: string, args: <method-specific>, schemaHash?: string)` and return a method-specific result. Each method SHALL verify the token (per the prior requirement), validate the schema hash against `SCHEMA_CONTENT_HASH`, and execute the same R2 operation the static tool of the same name performs against the namespaced R2 bucket. Path validation, byte limits, and binary detection SHALL match the static capability's behavior.

Methods SHALL NOT emit UI broadcasts directly. UI mutation broadcasts for bundle-originated tool executions are produced by the static `fileTools(...)` capability's `broadcastAgentMutation` hook firing via the host hook bridge — the service is a pure RPC executor.

#### Scenario: Per-tool method shape mirrors the static tool
- **WHEN** the bundle calls `service.read(token, { path: "foo.md" }, hash)`
- **THEN** the result is the same shape the static `file_read` tool returns for the same path under the same R2 namespace

#### Scenario: Schema hash mismatch fails closed for every method
- **WHEN** any of the nine methods is called with a `schemaHash` that does not equal `SCHEMA_CONTENT_HASH`
- **THEN** the method throws `ERR_SCHEMA_VERSION`

#### Scenario: Path validation rejects traversal attempts
- **WHEN** any method is called with a path that escapes the namespace (e.g., contains `..` or starts with `/`)
- **THEN** the method throws an Error matching the static capability's path-validation error

#### Scenario: Service does not invoke spine for UI broadcast
- **WHEN** any of the five mutation methods (`write`, `edit`, `delete`, `copy`, `move`) succeeds
- **THEN** the service makes no `spine.broadcastGlobal` (or equivalent) call
- **AND** the UI broadcast fires elsewhere — through the host hook bridge invoking the static capability's `afterToolExecution` hook

<!-- Section: Bundle client -->

### Requirement: `fileToolsClient` factory SHALL return a `Capability` exposing nine `file_*` tools

The function exported from `@crabbykit/file-tools/client` SHALL be `fileToolsClient(options: { service: Service<FileToolsService> }): Capability`. The returned capability SHALL have `id: "file-tools"`, SHALL register exactly nine tools (`file_read`, `file_write`, `file_edit`, `file_delete`, `file_copy`, `file_move`, `file_list`, `file_tree`, `file_find`), and SHALL NOT register `hooks`, `httpHandlers`, `configNamespaces`, `onAction`, or `promptSections`.

Each tool's `execute` function SHALL read `env.__BUNDLE_TOKEN`, throw an Error containing `Missing __BUNDLE_TOKEN` when undefined, and call the corresponding service method with `(token, args, SCHEMA_CONTENT_HASH)`.

#### Scenario: Capability id matches the catalog scope string
- **WHEN** `fileToolsClient(...)` is invoked
- **THEN** the returned capability's `id` is the literal string `"file-tools"`

#### Scenario: Bundle without `__BUNDLE_TOKEN` env field fails fast
- **WHEN** any of the nine tools is executed in a context whose `env.__BUNDLE_TOKEN` is undefined
- **THEN** the tool throws an Error containing `Missing __BUNDLE_TOKEN`

#### Scenario: All nine tool names are registered
- **WHEN** the returned capability's `tools(context)` is enumerated
- **THEN** the returned array's tool names are exactly the set `{file_read, file_write, file_edit, file_delete, file_copy, file_move, file_list, file_tree, file_find}`

#### Scenario: Bundle client registers no host-only surfaces
- **WHEN** the returned capability is inspected
- **THEN** it has no `hooks`, no `httpHandlers`, no `configNamespaces`, no `onAction`, and no `promptSections` keys

<!-- Section: Shared schemas -->

### Requirement: `@crabbykit/file-tools/schemas` SHALL export per-tool schemas and a versioned content hash

The schemas subpath SHALL export named constants for each of the nine tool names + descriptions, a TypeBox `Type.Object(...)` args schema for each tool, and `SCHEMA_CONTENT_HASH: string` initially `"file-tools-schemas-v1"`.

#### Scenario: Initial schema version constant
- **WHEN** `SCHEMA_CONTENT_HASH` is read
- **THEN** its value is the string `"file-tools-schemas-v1"`

#### Scenario: write args schema requires path and content
- **WHEN** the write args schema is used to validate `{ path: "x" }` (missing `content`)
- **THEN** validation fails

#### Scenario: move args schema requires source and destination
- **WHEN** the move args schema is used to validate `{ source: "a" }` (missing `destination`)
- **THEN** validation fails

<!-- Section: Static capability invariants under bundle wiring -->

### Requirement: Static `fileTools(...)` factory hooks and onAction SHALL remain host-side and fire for both static and bundle tool events

Wiring the bundle-side `fileToolsClient(...)` SHALL NOT alter, suppress, or duplicate the static capability's `afterToolExecution` mutation-broadcast hook or its `onAction` UI bridge dispatcher. Both SHALL continue to function on the host pipeline regardless of whether a bundle brain is also wired.

For mutations originating in a bundle agent's tool calls, the static capability's `afterToolExecution` hook SHALL fire via the host hook bridge (per the `bundle-host-hook-bridging` capability), producing the same `file_changed` broadcast that static-brain mutations produce. The UI SHALL receive identical wire format whether the mutating tool call originated in the static brain or a bundle brain.

#### Scenario: Static hook fires for static-brain mutations
- **WHEN** a static-brain agent calls `file_write`
- **THEN** the static capability's `afterToolExecution` hook fires (via the static path)
- **AND** the bundle's `FileToolsService` is not invoked

#### Scenario: Static hook fires for bundle-brain mutations via the bridge
- **WHEN** a bundle-brain agent calls `file_write` (via `fileToolsClient` → `FileToolsService.write`)
- **THEN** the static capability's `afterToolExecution` hook fires (via the host hook bridge) for that event
- **AND** the UI receives the resulting `file_changed` broadcast

#### Scenario: UI receives the same wire format regardless of brain
- **WHEN** the UI subscribes to `capability_state` events for `file-tools`
- **AND** a `file_changed` event arrives
- **THEN** the event payload shape is identical whether the mutating call originated in the static brain or a bundle brain
