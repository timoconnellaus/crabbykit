# app-registry Specification

## Purpose
TBD - created by archiving change app-registry. Update Purpose after archive.
## Requirements
### Requirement: App SQL persistence
The app-registry capability SHALL maintain two SQL tables in the agent DO's SQLite database: `apps` (id, name, slug, current_version, has_backend, created_at, updated_at) and `app_versions` (app_id, version, deploy_id, commit_hash, message, files JSON, has_backend, deployed_at). The `AppStore` class SHALL follow the same patterns as `ScheduleStore` -- synchronous reads, transactional writes, row-to-object mapping at the boundary.

#### Scenario: Tables created on first access
- **WHEN** the AppStore is instantiated with a SQL context
- **THEN** the `apps` and `app_versions` tables SHALL be created if they do not exist, with a UNIQUE constraint on `apps.slug`

#### Scenario: App creation
- **WHEN** an app is registered with name "Todo App" and slug "todo-app"
- **THEN** a row SHALL be inserted into `apps` with a generated UUID id, current_version 0, and current timestamps

#### Scenario: Version registration
- **WHEN** a version is registered for an app with commit_hash, message, files, and has_backend
- **THEN** a row SHALL be inserted into `app_versions` with version = previous current_version + 1, and the app's current_version and updated_at SHALL be updated atomically

#### Scenario: Slug uniqueness enforced
- **WHEN** an app is created with a slug that already exists
- **THEN** the operation SHALL fail with an error indicating the slug is taken

### Requirement: Deploy tool with git gate
The `deploy_app` tool SHALL require a clean git working tree before proceeding. It SHALL accept `name` (required on first deploy), `slug` (optional, derived from name), `buildDir` (required), and `backendEntry` (optional). On first deploy to a new slug, the app SHALL be auto-created. On subsequent deploys, the existing app SHALL be updated with a new version.

#### Scenario: Clean working tree allows deploy
- **WHEN** `deploy_app` is called with a valid buildDir and git working tree is clean
- **THEN** the tool SHALL read HEAD commit hash and commit message, build artifacts, copy to R2 at `/{agentDoId}/apps/{slug}/.deploys/v{N}/`, write a `CURRENT` file containing the version number, register the version in SQL, and broadcast the updated app list

#### Scenario: Dirty working tree blocks deploy
- **WHEN** `deploy_app` is called and `git status --porcelain` returns non-empty output
- **THEN** the tool SHALL return an error instructing the agent to commit changes before deploying

#### Scenario: Auto-create app on first deploy
- **WHEN** `deploy_app` is called with a slug that does not exist in the registry
- **THEN** the tool SHALL create the app record, then proceed with version 1 deployment

#### Scenario: Subsequent deploy increments version
- **WHEN** `deploy_app` is called for an app that already has version N deployed
- **THEN** a new version N+1 SHALL be created with the current HEAD commit hash and message

#### Scenario: Backend bundling
- **WHEN** `deploy_app` is called with a `backendEntry` parameter
- **THEN** the tool SHALL bundle the backend using `@cloudflare/worker-bundler`, store `bundle.json` in the version's deploy directory under `.backend/`, and set `has_backend` to true on the version record

#### Scenario: Slug derivation from name
- **WHEN** `deploy_app` is called with name "My Cool App" and no explicit slug
- **THEN** the slug SHALL be derived as "my-cool-app" (lowercase, spaces and special characters replaced with hyphens, consecutive hyphens collapsed)

### Requirement: Rollback to previous version
The `rollback_app` tool SHALL allow reverting an app to a previously deployed version by updating the `CURRENT` file and the app's `current_version` in SQL. No rebuild is performed.

#### Scenario: Rollback to specific version
- **WHEN** `rollback_app` is called with an app slug and target version N
- **THEN** the `CURRENT` file SHALL be updated to N, the app's `current_version` SHALL be updated to N in SQL, and the updated app list SHALL be broadcast

#### Scenario: Rollback to nonexistent version
- **WHEN** `rollback_app` is called with a version that does not exist in `app_versions`
- **THEN** the tool SHALL return an error indicating the version does not exist

#### Scenario: Client-initiated rollback
- **WHEN** a `rollback_app` client message is received with appId and version
- **THEN** the server SHALL execute the rollback and broadcast the updated app list

### Requirement: Delete app
The `delete_app` tool SHALL remove an app and all its versions from SQL, clean up R2 artifacts, and broadcast the updated list.

#### Scenario: Successful deletion
- **WHEN** `delete_app` is called with a valid app slug
- **THEN** all `app_versions` rows for the app SHALL be deleted, the `apps` row SHALL be deleted, R2 artifacts at `/{agentDoId}/apps/{slug}/` SHALL be removed via sandbox, and the updated app list SHALL be broadcast

#### Scenario: Delete nonexistent app
- **WHEN** `delete_app` is called with a slug that does not exist
- **THEN** the tool SHALL return an error indicating the app was not found

#### Scenario: Client-initiated deletion
- **WHEN** a `delete_app` client message is received with appId
- **THEN** the server SHALL execute the deletion and broadcast the updated app list

### Requirement: List and history tools
The capability SHALL provide `list_apps` and `get_app_history` tools for agent use.

#### Scenario: List all apps
- **WHEN** `list_apps` is called
- **THEN** the tool SHALL return all apps with their name, slug, current version, has_backend flag, and last deploy timestamp

#### Scenario: Get version history
- **WHEN** `get_app_history` is called with an app slug
- **THEN** the tool SHALL return all versions for that app ordered by version descending, including version number, commit hash, message, file count, has_backend, and deploy timestamp

### Requirement: App list transport message
The capability SHALL broadcast an `app_list` server message to all connected WebSocket clients on connection open and after any mutation (deploy, rollback, delete).

#### Scenario: Broadcast on connect
- **WHEN** a WebSocket client connects to the agent
- **THEN** the server SHALL broadcast an `app_list` message containing all registered apps with id, name, slug, currentVersion, hasBackend, lastDeployedAt, commitHash, and commitMessage

#### Scenario: Broadcast after deploy
- **WHEN** a successful deploy completes
- **THEN** the server SHALL broadcast an updated `app_list` message to all connected clients

#### Scenario: Broadcast after rollback or delete
- **WHEN** a rollback or delete operation completes
- **THEN** the server SHALL broadcast an updated `app_list` message to all connected clients

### Requirement: Client state management
The agent-runtime client SHALL include app state in the chat reducer and expose it through the useAgentChat hook.

#### Scenario: Reducer handles app list
- **WHEN** an `app_list` message is received by the message handler
- **THEN** a `SET_APPS` action SHALL be dispatched to the reducer, updating `ChatState.apps`

#### Scenario: Hook exposes apps and actions
- **WHEN** a consumer accesses `useChat()`
- **THEN** the return value SHALL include `apps` (array), `deleteApp(appId)` (function), and `rollbackApp(appId, version)` (function)

#### Scenario: Delete action sends client message
- **WHEN** `deleteApp(appId)` is called from the hook
- **THEN** a `delete_app` client message SHALL be sent over the WebSocket

#### Scenario: Rollback action sends client message
- **WHEN** `rollbackApp(appId, version)` is called from the hook
- **THEN** a `rollback_app` client message SHALL be sent over the WebSocket

### Requirement: App serving route
The package SHALL export a `handleAppRequest()` function that resolves `/apps/{slug}/*` URLs to the correct deployed version and serves static assets and backend API routes.

#### Scenario: Serve current version
- **WHEN** a request arrives at `/apps/todo-app/index.html`
- **THEN** the handler SHALL read the `CURRENT` file from R2, resolve the deploy path, and serve the asset using the existing deploy-server internals

#### Scenario: Backend API routing
- **WHEN** a request arrives at `/apps/todo-app/api/items`
- **THEN** the handler SHALL route to the backend Worker bundle for the current version, injecting DbService

#### Scenario: Unknown slug returns 404
- **WHEN** a request arrives at `/apps/nonexistent/`
- **THEN** the handler SHALL return a 404 response

#### Scenario: No CURRENT file returns 404
- **WHEN** a request arrives for a slug whose `CURRENT` file does not exist in R2
- **THEN** the handler SHALL return a 404 response

### Requirement: Capability registration
The `app-registry` capability SHALL be registered via an `appRegistry()` factory function that accepts configuration for sandbox provider, storage bucket, loader, and optional backend services.

#### Scenario: Minimal registration
- **WHEN** `appRegistry({ provider, storage })` is called with a sandbox provider and agent storage
- **THEN** the capability SHALL register with id "app-registry" and provide deploy_app, list_apps, rollback_app, delete_app, and get_app_history tools

#### Scenario: Full-stack registration
- **WHEN** `appRegistry({ provider, storage, backend: { loader, dbService } })` is called
- **THEN** the capability SHALL enable backend bundling in the deploy_app tool

### Requirement: Test compliance
All production code SHALL achieve the project's coverage thresholds and quality gates. Every public function SHALL have at least one test. Tests SHALL be colocated with source code in `__tests__/` directories or as `.test.ts` files alongside the source.

#### Scenario: Coverage thresholds met
- **WHEN** `bun test:coverage` is run for the app-registry package
- **THEN** coverage SHALL meet or exceed 98% statements, 90% branches, 100% functions, 99% lines

#### Scenario: Every public function tested
- **WHEN** the app-registry barrel export is compared against test coverage
- **THEN** every exported function, class, and factory SHALL have at least one test exercising it

#### Scenario: Tests colocated with source
- **WHEN** test files are created for app-registry
- **THEN** they SHALL be placed in `__tests__/` directories adjacent to their source files or as `.test.ts` files alongside the source, not in a separate top-level test directory

### Requirement: Code quality compliance
Production code SHALL contain zero `any` types, pass all biome lint and format checks, use `import type` / `export type` for type-only imports/exports, and follow project naming conventions.

#### Scenario: No any in production code
- **WHEN** biome lint is run against app-registry source files (excluding tests)
- **THEN** zero `noExplicitAny` violations SHALL be reported

#### Scenario: Lint and format clean
- **WHEN** `bun run lint` is run
- **THEN** zero errors SHALL be reported for app-registry source files

#### Scenario: Typecheck clean
- **WHEN** `bun run typecheck` is run
- **THEN** zero TypeScript errors SHALL be reported for the app-registry package

#### Scenario: Import type discipline
- **WHEN** app-registry source files import types
- **THEN** all type-only imports SHALL use `import type` and all type-only re-exports SHALL use `export type`

#### Scenario: ESM import extensions
- **WHEN** app-registry source files import from other modules within the package
- **THEN** imports SHALL use `.js` extensions as required for ESM resolution

### Requirement: Quality check non-regression
The app-registry package SHALL not introduce new warnings as measured by `./tools/quality-check.sh`.

#### Scenario: No new warnings
- **WHEN** `./tools/quality-check.sh` is run after the change is complete
- **THEN** the total warning count SHALL not have increased compared to the baseline captured before implementation began

#### Scenario: Source file length limits
- **WHEN** any app-registry source file is created
- **THEN** it SHALL not exceed 500 lines

#### Scenario: Test file length limits
- **WHEN** any app-registry test file is created
- **THEN** it SHALL not exceed 1500 lines

#### Scenario: No console.log in library code
- **WHEN** app-registry source files (excluding tests) are checked
- **THEN** zero `console.log` statements SHALL be present

#### Scenario: Package has tests
- **WHEN** `./tools/quality-check.sh` checks for packages without tests
- **THEN** the app-registry package SHALL not appear in the "packages without tests" list

