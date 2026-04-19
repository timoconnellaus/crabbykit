## ADDED Requirements

### Requirement: bundle_init scaffolding tool

The system SHALL provide a `bundle_init` tool that scaffolds a new bundle workspace inside the agent's sandbox container at a caller-specified path (default `/workspace/bundles/{name}/`). The scaffold SHALL include `package.json` (with workspace dep references via `file:` paths to the read-only vendored snapshot at `/opt/claw-sdk/`), `tsconfig.json` (extending a shared bundle tsconfig base), `src/index.ts` (a starter `defineAgentBundle({...})` call), and `README.md`. After scaffolding, the tool SHALL run `bun install --ignore-scripts` inside the container to populate `node_modules`.

#### Scenario: Workspace created and installable
- **WHEN** an agent calls `bundle_init({ name: "my-bundle" })`
- **THEN** the files listed above exist in the sandbox at `/workspace/bundles/my-bundle/`, `bun install --ignore-scripts` succeeds, and the starter `src/index.ts` compiles without errors

#### Scenario: Init rejects existing name
- **WHEN** an agent calls `bundle_init({ name: "existing" })` on a path that already contains a workspace
- **THEN** the tool returns an error without overwriting any files

### Requirement: bundle_build tool

The system SHALL provide a `bundle_build` tool that runs `bun build src/index.ts --target=browser --format=esm --outfile=dist/bundle.js` (or equivalent) inside the sandbox container for a named workspace. Before invoking `bun build`, the tool SHALL verify the integrity of the vendored `/opt/claw-sdk/` snapshot against a known hash manifest (`/opt/claw-sdk/INTEGRITY.json`) — any tampering SHALL abort the build with a clear error. The tool SHALL return build success/failure plus captured stdout and stderr. On success, the resulting `dist/bundle.js` SHALL be present in the workspace and ready for subsequent `bundle_test` or `bundle_deploy` calls.

#### Scenario: Successful build
- **WHEN** an agent calls `bundle_build({ name: "my-bundle" })` on a workspace containing a valid `src/index.ts`
- **THEN** integrity verification passes, `dist/bundle.js` exists in the workspace, the tool result indicates success, and the captured build log shows no errors

#### Scenario: Build failure with diagnostics
- **WHEN** an agent calls `bundle_build` on a workspace with a TypeScript or bundler error
- **THEN** the tool result indicates failure and includes the diagnostic output from `bun build` identifying the source file, line, and error message

#### Scenario: Vendored package tampering detected
- **WHEN** the `/opt/claw-sdk/` mount has been modified since image build (e.g., by a misconfigured mount or filesystem tampering)
- **THEN** integrity verification fails before `bun build` runs, and the tool returns a clear error identifying the tampered file

### Requirement: bundle_test tool

The system SHALL provide a `bundle_test` tool that loads the workspace's `dist/bundle.js` via Worker Loader in a scratch isolate, with a throwaway in-memory spine (not the parent's session store) and a synthetic capability token scoped to a scratch session ID. The tool SHALL accept a `prompt` argument and optional test configuration, run one turn, and return the transcript to the parent agent. The candidate bundle SHALL run with restricted bindings — no parent credential store, no access to parent file state, and a separate sandbox namespace.

#### Scenario: Test run returns transcript
- **WHEN** an agent calls `bundle_test({ name: "my-bundle", prompt: "hello" })` on a workspace with a successfully built bundle
- **THEN** a loader-loaded scratch instance handles the prompt using the bundle's runtime, and the tool returns a transcript including the assistant's response

#### Scenario: Test isolation from parent session
- **WHEN** a `bundle_test` call completes
- **THEN** no entries are written to the parent agent's session store; the throwaway spine and its in-memory state are discarded

#### Scenario: Test isolation from parent credentials
- **WHEN** a candidate bundle attempts during `bundle_test` to access parent-scoped credentials, parent files, or parent network identity
- **THEN** the bundle's env contains only the scratch token and explicitly-allowed bindings; the parent's credential store and file state are unreachable

#### Scenario: Test surfaces runtime errors
- **WHEN** the bundle loads but throws during turn handling
- **THEN** the tool returns a result indicating test failure with the error message and stack trace preserved

### Requirement: bundle_deploy tool

The system SHALL provide a `bundle_deploy` tool that reads the built `dist/bundle.js` from a workspace, computes its content hash as the version ID, runs the pre-deploy smoke test, calls `registry.createVersion` (which handles KV write + readback verification), and calls `registry.setActive` to update the target agent's pointer. The tool SHALL accept an optional `targetAgentId` argument; if omitted, it SHALL deploy to a named subagent (not to the parent itself).

#### Scenario: Deploy to new subagent
- **WHEN** an agent calls `bundle_deploy({ name: "my-bundle", rationale: "initial version" })` without `targetAgentId`
- **THEN** the bundle is hashed, smoke-tested, stored in KV with readback verification, a `bundle_versions` row is created, the deploy log records the operation with rationale, and the target subagent is configured to use this bundle as its active version

#### Scenario: Deploy fails on oversized bundle
- **WHEN** the built `dist/bundle.js` exceeds Cloudflare KV's per-value size limit (25 MiB)
- **THEN** the tool returns a failure identifying the size as the cause and no KV or registry writes occur

#### Scenario: Deploy blocked if build missing
- **WHEN** an agent calls `bundle_deploy` on a workspace without a built `dist/bundle.js`
- **THEN** the tool returns an error instructing the agent to run `bundle_build` first, and no registry writes occur

### Requirement: Pre-deploy smoke test

The `bundle_deploy` tool SHALL run an automatic smoke test before invoking `registry.createVersion`. The smoke test SHALL load the candidate bundle in a scratch loader isolate with a throwaway spine and synthetic token, issue a minimal `ping` invocation against the bundle's `/tool-execute-smoke` endpoint, and verify the bundle returns a well-formed response. If the smoke test fails, the deploy SHALL abort, no registry writes SHALL occur, and the tool SHALL return an error describing the smoke test failure.

#### Scenario: Healthy bundle passes smoke test
- **WHEN** a bundle that loads correctly and responds to the ping is deployed
- **THEN** the smoke test succeeds and the deploy proceeds to write to KV (with readback) and update the registry

#### Scenario: Broken bundle blocked from deployment
- **WHEN** a bundle that crashes during load or returns a malformed response is deployed
- **THEN** the smoke test fails, the deploy is aborted, and no changes are made to KV or the registry

### Requirement: bundle_rollback tool

The system SHALL provide a `bundle_rollback` tool that invokes the registry's rollback operation for a target agent, swapping `active_version_id` with `previous_version_id`. The tool SHALL accept an optional `rationale` argument that is recorded in the deployment audit log and SHALL signal the target DO to refresh its cached pointer.

#### Scenario: Rollback swaps versions
- **WHEN** an agent calls `bundle_rollback({ targetAgentId: "subagent-1", rationale: "broke tool call" })` while the target has `active = 'B', previous = 'A'`
- **THEN** the target's registry entry is updated to `active = 'A', previous = 'B'`, a rollback row is appended to `bundle_deployments`, and the target DO's cached pointer is invalidated

#### Scenario: Rollback with no previous version
- **WHEN** an agent calls `bundle_rollback` on a target whose `previous_version_id` is NULL
- **THEN** the tool returns an error without modifying registry state

### Requirement: bundle_versions tool

The system SHALL provide a `bundle_versions` tool that lists deployment history for a target agent, returning rows from `bundle_deployments` joined with `bundle_versions.metadata` so the caller can see timestamps, version IDs, rationales, and authored descriptions. The tool SHALL support a `limit` argument (default 20, max 100). Requests with `limit > 100` SHALL be capped at 100 without error.

#### Scenario: List recent deployments
- **WHEN** an agent calls `bundle_versions({ targetAgentId: "subagent-1", limit: 5 })`
- **THEN** the tool returns up to five most-recent deployment records for the target, ordered by `deployed_at` descending, each including the version ID, rationale, metadata summary, and deployment timestamp

#### Scenario: Limit cap enforced
- **WHEN** an agent calls `bundle_versions({ targetAgentId: "subagent-1", limit: 500 })`
- **THEN** the tool returns at most 100 records and the response indicates the limit was capped

### Requirement: Sandbox container workspace dependency

`bundle_init` and `bundle_build` SHALL operate against the agent's sandbox container filesystem via the existing `packages/sandbox` tooling. The workshop package SHALL NOT introduce its own container management — it depends on the agent already having an active sandbox session and the existing `exec` and file tools for container operations.

#### Scenario: Workshop requires sandbox elevation
- **WHEN** an agent attempts `bundle_init` without first elevating a sandbox session
- **THEN** the tool returns an error instructing the agent to elevate a sandbox first

### Requirement: Container workspace package resolution

The sandbox container image SHALL include a vendored snapshot of the `@crabbykit/*` packages needed to author and build a bundle (`agent-runtime/bundle` subpath, `agent-runtime/spine` clients, the `client` and `schemas` subpaths of capability packages that have been split). The snapshot SHALL be mounted **read-only** at `/opt/claw-sdk/` to prevent supply-chain tampering by adversarial bundles. The scaffolded `package.json` produced by `bundle_init` SHALL reference these via `file:/opt/claw-sdk/...` paths so `bun install` resolves them offline. `bun install` SHALL be invoked with `--ignore-scripts` to disable lifecycle hooks.

#### Scenario: Offline bundle build
- **WHEN** `bundle_build` runs inside a sandbox container with no outbound network access
- **THEN** integrity check passes, `bun install --ignore-scripts` and `bun build` complete successfully using only the vendored read-only packages and the workspace's own source files

#### Scenario: Read-only mount enforced
- **WHEN** any process inside the container attempts to write to `/opt/claw-sdk/`
- **THEN** the write fails with EROFS

### Requirement: Deploy rate limiting

`bundle_deploy` SHALL enforce a per-agent deploy rate limit. Default: 5 deploys per minute per token-derived agentId. Limit state SHALL be tracked in DO storage keyed by agentId with sliding window or token bucket semantics. Exceeding the limit SHALL return a structured `ERR_DEPLOY_RATE_LIMITED` error from `bundle_deploy` with the time until next allowed deploy.

#### Scenario: Rate limit enforced
- **WHEN** an agent invokes `bundle_deploy` 6 times within 60 seconds against the same target
- **THEN** the 6th call returns `ERR_DEPLOY_RATE_LIMITED` and no deploy actions are taken

#### Scenario: Limit per-agent, not per-target
- **WHEN** an agent invokes `bundle_deploy` against two different subagent targets within the same minute
- **THEN** each target's deploys count against the same per-agent budget (the rate limit prevents runaway deploy loops, regardless of which target is being deployed to)

### Requirement: Workshop tool audit log

Every invocation of a `bundle_*` workshop tool SHALL append a structured audit log entry to the parent agent's session store as a custom session entry of type `workshop_audit`. The entry SHALL record: tool name, summarized arguments (excluding any blob contents), result status (success/error), error code if applicable, and timestamp. Audit entries SHALL be queryable via the existing session entry tools.

#### Scenario: Successful tool invocation logged
- **WHEN** an agent calls `bundle_deploy({ name: "my-bundle", rationale: "..." })` and it succeeds
- **THEN** a `workshop_audit` custom session entry is appended recording `{tool: "bundle_deploy", args: {name, rationale}, status: "success", versionId, timestamp}`

#### Scenario: Failed tool invocation logged
- **WHEN** `bundle_build` fails due to a tsc error
- **THEN** a `workshop_audit` entry is appended recording `{tool: "bundle_build", args: {name}, status: "error", errorCode: "BUILD_FAILED", timestamp}`

### Requirement: Option A subagent target default

The workshop's default deployment target SHALL be a subagent of the parent that invokes the deploy, not the parent itself. Configuring the workshop to target the invoking parent's own bundle SHALL require explicit opt-in via a `selfEditingEnabled` flag on the workshop capability instantiation in the host worker. Absent that flag, calling `bundle_deploy` without `targetAgentId` SHALL create or update a subagent, and calling `bundle_deploy({ targetAgentId: <parent's own agentId> })` SHALL be rejected.

#### Scenario: Default deploy creates subagent
- **WHEN** a workshop capability is instantiated without `selfEditingEnabled` and an agent calls `bundle_deploy`
- **THEN** the deploy creates or updates a subagent's bundle and never modifies the parent agent's own bundle pointer

#### Scenario: Self-edit requires explicit flag
- **WHEN** a workshop capability is instantiated without `selfEditingEnabled` and an agent calls `bundle_deploy({ targetAgentId: <parent's own agentId> })`
- **THEN** the tool returns an error indicating self-editing is not enabled for this workshop instance
