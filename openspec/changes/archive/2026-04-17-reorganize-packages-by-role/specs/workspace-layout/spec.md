## ADDED Requirements

<!-- Section: Role-based package buckets -->

### Requirement: Package directory structure

The repository SHALL organize all workspace packages under `packages/` into exactly seven role-based buckets: `runtime/`, `infra/`, `capabilities/`, `channels/`, `federation/`, `ui/`, and `dev/`. Every package directory SHALL reside at depth two under `packages/` — i.e., `packages/<bucket>/<package-name>/`. No package SHALL live at `packages/<name>/` (depth one).

Every package SHALL belong to exactly one bucket. A package that touches multiple concerns SHALL be placed in the bucket matching its dominant role, not duplicated or split across buckets at the directory level. The 4-subpath capability service pattern (`index`, `service`, `client`, `schemas`) handles multi-tier packages within a single bucket location.

The seven buckets SHALL encode the following roles:

- **`runtime/`** — the agent engine and bundle system plumbing. Includes `agent-runtime`, `agent-core`, `ai`, `ai-proxy`, `agent-bundle`, `bundle-registry`, `agent-workshop`. These packages answer "what runs the agent?"
- **`infra/`** — native-binding-holding, deploy-time-wired providers. Includes storage identity, auth, credential storage, registries (skill, agent, app), container-db, cloudflare-sandbox. These packages answer "what holds the native CF bindings and secrets?"
- **`capabilities/`** — brain-facing tools, hooks, and turn-lifecycle behaviors. Includes Tavily, file-tools, vector-memory, browserbase, skills, prompt-scheduler, task-tracker, sandbox, vibe-coder, batch-tool, subagent, subagent-explorer, doom-loop-detection, tool-output-truncation, compaction-summary, heartbeat. These packages answer "what tools can the brain call?"
- **`channels/`** — input surfaces that deliver messages to agents. Includes `channel-telegram`. These packages answer "how do messages get into agents from outside?"
- **`federation/`** — multi-agent coordination infrastructure. Includes `a2a`, `agent-fleet`, `agent-peering`. These packages answer "how do agents talk to each other?"
- **`ui/`** — client-side React components and hooks. Includes `agent-ui`. These packages answer "what does the end user see in the browser?"
- **`dev/`** — build and development tooling. Includes `vite-plugin`. These packages answer "what's build-time only?"

The `examples/` and `e2e/` directories SHALL remain at the repository root, not inside `packages/`.

#### Scenario: New package placement
- **WHEN** a new package is created that exposes tools to the agent brain via a `Capability` factory
- **THEN** the package SHALL be placed at `packages/capabilities/<name>/`, not at any other bucket

#### Scenario: New native-binding provider
- **WHEN** a new package is created whose primary responsibility is owning a Cloudflare native binding (R2, D1, KV, Vectorize, Container, Queue)
- **THEN** the package SHALL be placed at `packages/infra/<name>/`

#### Scenario: Runtime engine package
- **WHEN** a new package is created that is imported by `@crabbykit/agent-runtime` or the bundle host dispatcher
- **THEN** the package SHALL be placed at `packages/runtime/<name>/`

#### Scenario: Depth-one package rejected
- **WHEN** any package directory is added directly under `packages/` (at depth one, without a bucket parent)
- **THEN** the workspace glob `packages/*/*` SHALL not match it, and `bun install` SHALL fail to include it as a workspace member, surfacing the placement error

### Requirement: Dependency direction rules

The repository SHALL enforce a directed dependency graph between buckets. The following import edges SHALL be allowed:

- `runtime/` packages MAY import from other `runtime/` packages.
- `infra/` packages MAY import from `runtime/` and other `infra/` packages.
- `capabilities/` packages MAY import from `runtime/`, `infra/`, and other `capabilities/` packages.
- `channels/` packages MAY import from `runtime/`, `infra/`, `capabilities/`, and other `channels/` packages.
- `federation/` packages MAY import from `runtime/`, `infra/`, and other `federation/` packages.
- `ui/` packages MAY import transport and protocol types from `runtime/agent-runtime` only. They SHALL NOT import server-side runtime internals or any package outside `runtime/agent-runtime`.
- `dev/` packages MAY import from any bucket (build-time tooling is exempt).

The following import edges SHALL be forbidden:

- `runtime/` SHALL NOT import from `capabilities/`, `channels/`, `federation/`, `ui/`, or `dev/`. The runtime is substrate for capabilities, not a consumer of them.
- `infra/` SHALL NOT import from `capabilities/`, `channels/`, `federation/`, `ui/`, or `dev/`.
- `capabilities/` SHALL NOT import from `channels/`, `federation/`, `ui/`, or `dev/`.
- `channels/` SHALL NOT import from `federation/`, `ui/`, or `dev/`.
- `federation/` SHALL NOT import from `capabilities/`, `channels/`, `ui/`, or `dev/`.
- `ui/` SHALL NOT import from `infra/`, `capabilities/`, `channels/`, `federation/`, or `dev/`.

External dependencies (`@sinclair/typebox`, `cloudflare:workers`, etc.) are not bucketed and are unrestricted.

#### Scenario: Runtime imports capability — forbidden
- **WHEN** a file in `packages/runtime/agent-runtime/src/*.ts` contains `import { tavilyWebSearch } from "@crabbykit/tavily-web-search"`
- **THEN** the dependency-direction CI check SHALL fail with an error identifying the source file, source bucket (`runtime`), target package, and target bucket (`capabilities`)

#### Scenario: Capability imports infra — allowed
- **WHEN** a file in `packages/capabilities/file-tools/src/capability.ts` contains `import type { AgentStorage } from "@crabbykit/agent-storage"`
- **THEN** the dependency-direction CI check SHALL pass

#### Scenario: UI imports transport types — allowed
- **WHEN** a file in `packages/ui/agent-ui/src/hooks/*.ts` contains `import type { ServerMessage } from "@crabbykit/agent-runtime"`
- **THEN** the dependency-direction CI check SHALL pass (type-only imports from `runtime/agent-runtime` are explicitly permitted for the UI bucket)

#### Scenario: Same-bucket import — always allowed
- **WHEN** a file in `packages/capabilities/subagent-explorer/src/*.ts` imports from `@crabbykit/subagent`
- **THEN** the dependency-direction CI check SHALL pass because both packages live in `capabilities/`

### Requirement: Dependency direction enforcement via CI script

The repository SHALL provide an executable script at `scripts/check-package-deps.ts` that statically analyzes all TypeScript source files under `packages/*/*/src/**/*.{ts,tsx}` and reports any import statement that crosses a forbidden bucket boundary per the dependency direction rules. The script SHALL be invoked by `bun run lint` and SHALL fail the lint command on any violation.

The script SHALL:

1. Parse each source file's top-level import specifiers using a regex or lightweight AST walk (full TypeScript parser not required; package name extraction from import strings is sufficient).
2. Resolve each `@crabbykit/*` import specifier to a target package and look up its bucket via the filesystem layout (`packages/<bucket>/<package-name>/package.json`).
3. Resolve the importing source file to its owning package and bucket via the filesystem path.
4. Check the (source bucket → target bucket) pair against the allowed-direction table.
5. On violation, print the source file path, source bucket, import specifier, target bucket, and the specific rule violated; then exit with status 1.
6. On success, exit with status 0.

The script SHALL ignore imports of external npm packages (anything not matching `@crabbykit/*`) and imports of Node / Cloudflare built-ins (`cloudflare:*`, `node:*`).

Test files (`packages/*/*/test/**/*.{ts,tsx}`, `packages/*/*/src/**/__tests__/**/*.{ts,tsx}`) SHALL be subject to the same rules as production source files.

#### Scenario: Lint command enforces direction
- **WHEN** a developer runs `bun run lint` after introducing a cross-bucket import violation
- **THEN** the command SHALL exit non-zero, print the violating file and the rule, and block commit/merge via the CI check

#### Scenario: Clean repository passes silently
- **WHEN** the repository contains no cross-bucket violations and `bun run lint` is invoked
- **THEN** the dependency-direction script SHALL exit zero with no output (or a one-line summary line)

#### Scenario: Type-only import in UI bucket
- **WHEN** `packages/ui/agent-ui/src/hooks/use-chat.ts` contains `import type { ClientMessage } from "@crabbykit/agent-runtime"`
- **THEN** the script SHALL accept the import because `runtime/agent-runtime` is in the UI bucket's allowed-target set

### Requirement: Workspace glob and package discovery

The repository root `package.json` SHALL declare `workspaces: ["packages/*/*", "examples/*", "e2e/*"]` (or equivalent bun workspace configuration). The glob `packages/*/*` SHALL match every package directory at exactly depth two under `packages/` and SHALL NOT match any depth-one directory.

#### Scenario: Bun install discovers all packages
- **WHEN** `bun install` runs from the repository root
- **THEN** every package placed at `packages/<bucket>/<name>/` SHALL be added to the workspace and linked for inter-package imports

#### Scenario: Misplaced package not discovered
- **WHEN** a package directory is accidentally created at `packages/<name>/` (depth one, no bucket)
- **THEN** `bun install` SHALL NOT include it as a workspace member, and any import referencing it SHALL fail with a module-not-found error

### Requirement: CLAUDE.md packages section reflects bucketed layout

The repository's `CLAUDE.md` file SHALL contain a "## Packages" section that lists packages grouped by their bucket, with each bucket as a subsection. The flat alphabetical package listing from the pre-reorganization era SHALL be removed.

Any new package added to the repository in a future change SHALL be added to `CLAUDE.md` under the correct bucket subsection as part of that change.

#### Scenario: Reading CLAUDE.md reveals structure
- **WHEN** a reader (human or AI) opens CLAUDE.md and looks at the packages section
- **THEN** they SHALL see packages grouped under headings for `runtime/`, `infra/`, `capabilities/`, `channels/`, `federation/`, `ui/`, and `dev/`, each with a brief one-line description per package

### Requirement: Rename r2-storage to file-tools

The package formerly at `packages/r2-storage/` SHALL be renamed to `file-tools` and relocated to `packages/capabilities/file-tools/`. The package identifier SHALL change from `@crabbykit/r2-storage` to `@crabbykit/file-tools`. The factory function formerly exported as `r2Storage` SHALL be renamed to `fileTools`. The options type formerly named `R2StorageOptions` SHALL be renamed to `FileToolsOptions`. The capability `id` formerly `"r2-storage"` SHALL become `"file-tools"`.

The package's tool surface (the nine file tools: `file_read`, `file_write`, `file_edit`, `file_delete`, `file_copy`, `file_move`, `file_list`, `file_tree`, `file_find`) and their behaviors SHALL be unchanged. The rename is a package and factory identifier change only.

No deprecation alias or re-export package SHALL be introduced under the old name. The repository is greenfield and does not maintain legacy compatibility shims.

#### Scenario: Consumer uses new name
- **WHEN** an agent definition imports `import { fileTools } from "@crabbykit/file-tools"` and calls `fileTools({ storage })`
- **THEN** the capability factory returns the same nine-tool capability that `r2Storage({ storage })` previously returned

#### Scenario: Old name is unresolvable
- **WHEN** code imports `@crabbykit/r2-storage` after this change lands
- **THEN** module resolution SHALL fail — the old name is gone, not aliased

#### Scenario: Capability id change surfaces in session entries
- **WHEN** a session records tool execution entries from this capability after the rename
- **THEN** the `capabilityId` field SHALL be `"file-tools"`, not `"r2-storage"`
