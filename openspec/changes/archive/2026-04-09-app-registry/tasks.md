## 1. Package Scaffold

- [x] 1.1 Create `packages/app-registry/` with package.json, tsconfig.json, biome config, and vitest config (model on existing capability packages like `packages/prompt-scheduler/`)
- [x] 1.2 Create barrel export `src/index.ts` and type definitions `src/types.ts` (AppRegistryOptions, AppRecord, AppVersion, DeployMetadata)
- [x] 1.3 Wire workspace dependency in root package.json and verify `bun install` resolves

## 2. App Store (SQL)

- [x] 2.1 Implement `AppStore` class with `apps` and `app_versions` table creation, modeled on `ScheduleStore` pattern (synchronous reads, transactional writes, row-to-object mapping)
- [x] 2.2 Implement `create(name, slug)`, `getBySlug(slug)`, `list()`, `delete(id)`, `update(id, updates)` methods on AppStore
- [x] 2.3 Implement `addVersion(appId, { commitHash, message, files, hasBackend })` and `getVersions(appId)` and `getVersion(appId, version)` methods
- [x] 2.4 Implement slug derivation utility: lowercase, replace spaces/special chars with hyphens, collapse consecutive hyphens, trim leading/trailing hyphens
- [x] 2.5 Write tests for AppStore: table creation, CRUD, version incrementing, slug uniqueness constraint, slug derivation. Target 100% function coverage, 90%+ branch coverage.

## 3. Tools

- [x] 3.1 Implement `deploy_app` tool: git status check, HEAD read, build via sandbox exec, copy to R2 `/{agentDoId}/apps/{slug}/.deploys/v{N}/`, write CURRENT file, backend bundling (optional), SQL registration, broadcast
- [x] 3.2 Implement `list_apps` tool: query AppStore.list(), return formatted results
- [x] 3.3 Implement `get_app_history` tool: query AppStore.getVersions(appId), return version list with commit hash, message, file count, timestamps
- [x] 3.4 Implement `rollback_app` tool: validate version exists, update CURRENT file via sandbox, update app current_version in SQL, broadcast
- [x] 3.5 Implement `delete_app` tool: remove SQL records, clean up R2 artifacts via sandbox `rm -rf`, broadcast
- [x] 3.6 Write tests for all tools: happy path, error cases (dirty git, nonexistent app/version, slug taken), edge cases (first deploy auto-create, backend bundling). Use `createMockStorage`, `textOf`, `TOOL_CTX` test helpers.

## 4. Capability Integration

- [x] 4.1 Implement `appRegistry()` factory function returning a Capability with id "app-registry", tools from step 3, and onConnect hook for broadcasting app list
- [x] 4.2 Implement `broadcastAppList()` as a context broadcast method, filtering to registered apps with their latest version info
- [x] 4.3 Implement `handleAppRequest()` exported function for Worker-level routing: parse `/apps/{slug}/*`, read CURRENT from R2, resolve deploy path, delegate to existing deploy-server internals for static and backend serving
- [x] 4.4 Write tests for capability registration, broadcast on connect, and handleAppRequest route resolution

## 5. Transport & Client State

DESIGN CHANGE: Using custom events (capability pattern) instead of first-class transport messages. The app list is broadcast as a `"app_list"` custom event via `context.broadcast()`. Client handles via `onCustomEvent`. No changes to agent-runtime transport types, reducer, message handler, or agent-do needed.

- [x] 5.1-5.7 Not needed — app-registry uses custom events, consistent with the capability pattern (like vibe-coder's preview_open/preview_close)

## 6. Vibe-Coder Modification

- [x] 6.1 Remove `deploy_app` tool import from vibe-coder capability (tool file kept for reference)
- [x] 6.2 Remove `deploy` configuration option from `VibeCoderOptions` type and capability factory
- [x] 6.3 deploy-server.ts kept in vibe-coder for backward compatibility; app-server.ts created in app-registry with parallel implementation
- [x] 6.4 Update vibe-coder tests to reflect removed deploy functionality
- [x] 6.5 Update vibe-coder package exports and barrel file (removed DeployOptions)

## 7. Example App Integration

- [x] 7.1 Update `examples/basic-agent/src/worker.ts` to register `appRegistry()` capability with provider, sql, storage, and backend options
- [x] 7.2 Add `handleAppRequest()` route in Worker fetch alongside existing `handleDeployRequest()`
- [x] 7.3 Remove `deploy` option from vibe-coder registration in example
- [ ] 7.4 Verify full flow: create app, deploy, list, rollback, delete via claw CLI

## 8. Compliance Validation

- [x] 8.1 Run `bun run typecheck` and fix any TypeScript errors across all affected packages
- [x] 8.2 Run `bun run lint` and fix all biome violations (zero `any` in production, `import type` / `export type` discipline, `.js` extensions on imports, naming conventions)
- [x] 8.3 Run `bun test` across all affected packages and fix failures
- [ ] 8.4 Verify app-registry coverage meets thresholds: 98% statements, 90% branches, 100% functions, 99% lines
- [x] 8.5 Verify every exported public function has at least one test
- [x] 8.6 Verify all source files are under 500 lines and test files under 1500 lines
- [x] 8.7 Verify zero `console.log` in app-registry library source files
- [x] 8.8 Verify tests are colocated with source (`__tests__/` or `.test.ts` alongside)
- [x] 8.9 Run `./tools/quality-check.sh` and confirm warning count has not increased from baseline (7 → 7)
- [ ] 8.10 Update CLAUDE.md: add app-registry to "What the SDK Provides Today" and "Project Structure" sections
- [ ] 8.11 Update README.md: add app-registry to packages table
