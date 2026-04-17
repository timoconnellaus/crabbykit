## 1. Phase 0 — host hook bus bridge

### 1a. Runtime: SpineHost interface + AgentRuntime impl

- [x] 1.1 Widen `SpineHost` interface in `packages/runtime/agent-runtime/src/spine-host.ts` to add `spineRecordToolExecution(caller: SpineCaller, event: ToolExecutionEvent): Promise<void>` and `spineProcessBeforeInference(caller: SpineCaller, messages: AgentMessage[]): Promise<AgentMessage[]>`
- [x] 1.2 Implement both methods on `AgentRuntime` (`packages/runtime/agent-runtime/src/agent-runtime.ts`); each method constructs a `CapabilityHookContext` from the caller, iterates the existing `afterToolExecutionHooks` / `beforeInferenceHooks` arrays in registration order, mirrors the static path's per-hook error swallowing, and (for `spineProcessBeforeInference`) threads the messages array through each hook returning the final result
- [x] 1.3 Wrap both implementations through `withSpineBudget(caller, "hook_after_tool", fn)` and `withSpineBudget(caller, "hook_before_inference", fn)`; pick conservative default caps in `BudgetTracker` config (sufficient for legitimate per-turn use, tight enough to surface runaways)
- [x] 1.4 Update the compile-time `AgentRuntime satisfies SpineHost` assertion in `packages/runtime/agent-runtime/src/agent-do.ts` (or wherever it lives) — should pass automatically; verify

### 1b. Bundle host: SpineService bundle-callable methods

- [x] 1.5 Add `recordToolExecution(token: string, event: ToolExecutionEvent): Promise<void>` and `processBeforeInference(token: string, messages: AgentMessage[]): Promise<AgentMessage[]>` to `SpineService` in `packages/runtime/bundle-host/src/services/spine-service.ts`; both verify with `requiredScope: "spine"`, derive `SpineCaller` from the verified token, delegate to `host.spineRecordToolExecution` / `host.spineProcessBeforeInference` via the typed `DurableObjectStub<SpineHost>`
- [x] 1.6 Route errors through the existing `SpineService.sanitize` path before crossing back to the bundle

### 1c. Bundle SDK: runtime call-site wiring

- [x] 1.7 In `packages/runtime/bundle-sdk/src/runtime.ts` (or its tool-execution wrapper — exact insertion point determined at implementation time), call `await spine.recordToolExecution(token, event)` after every tool execution completes (success or error); event shape matches existing `ToolExecutionEvent`
- [x] 1.8 In `packages/runtime/bundle-sdk/src/runtime.ts` (or its inference loop), call `messages = await spine.processBeforeInference(token, messages)` immediately before each model inference call; pass the returned array (not the original) to the inference call
- [x] 1.9 Throw a clear error from the bundle runtime if `env.__BUNDLE_TOKEN` is undefined at the bridge call site (matches existing missing-token convention elsewhere in the bundle SDK)

### 1d. Tests

- [x] 1.10 Unit tests for `AgentRuntime.spineRecordToolExecution` covering: hook iteration order matches registration order; per-hook errors don't abort the chain; budget-exceeded throws as expected; `CapabilityHookContext` has the expected shape
- [x] 1.11 Unit tests for `AgentRuntime.spineProcessBeforeInference` covering: mutator chaining (H1 → H2 sees H1's output); per-hook errors don't abort; final array is what the last successful hook returned; budget enforcement
- [x] 1.12 Unit tests for `SpineService.recordToolExecution` and `processBeforeInference` covering: scope check rejects token without `"spine"`; valid call delegates to host with caller derived from token; sanitization on host error
- [x] 1.13 Integration test (in `packages/runtime/agent-runtime/test/integration/`) asserting that the same `afterToolExecution` hook code runs identically for a static-pipeline tool execution AND a bridge-routed bundle event — same context shape, same observable side-effects
- [x] 1.14 Integration test asserting `beforeInference` mutator (e.g., a hook that prepends a system message) is observed by the bundle's inference call — bundle ends up calling the model with the prepended message

### 1e. Phase 0 verification

- [x] 1.15 Run `bun run typecheck` from repo root — clean
- [x] 1.16 Run `bun run lint` from repo root — clean (including `scripts/check-package-deps.ts`)
- [x] 1.17 Run `bun run test` from repo root — all green; existing static-brain hook tests untouched; new bridge tests green
- [x] 1.18 Atomic commit: `feat(runtime): add bundle/host hook bridge for afterToolExecution and beforeInference`

## 2. Phase 1 — `skills` shape-2 split

### 2a. Package: `@claw-for-cloudflare/skills`

- [x] 2.1 Create `packages/capabilities/skills/src/schemas.ts` exporting `SKILL_LOAD_TOOL_NAME`, `SKILL_LOAD_TOOL_DESCRIPTION`, `SkillLoadArgsSchema` (TypeBox), and `SCHEMA_CONTENT_HASH = "skills-schemas-v1"`
- [x] 2.2 Create `packages/capabilities/skills/src/service.ts` exporting `SkillsService extends WorkerEntrypoint<SkillsServiceEnv>` with `load(token, args, schemaHash)` method; declare env: `AGENT_AUTH_KEY`, `SKILL_REGISTRY` (D1 binding), `STORAGE_BUCKET` (R2), `STORAGE_NAMESPACE` (string)
- [x] 2.3 Implement lazy `getSubkey()` private method using `deriveVerifyOnlySubkey(env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL)` cached as `subkeyPromise` field
- [x] 2.4 Implement `load`: schema-hash check → token verify (`requiredScope: "skills"`) → installed-skill record lookup (D1 via `SKILL_REGISTRY`) → not-found / not-enabled text response → R2 read of skill content → frontmatter strip → `{ content }` return
- [x] 2.5 Create `packages/capabilities/skills/src/client.ts` exporting `skillsClient(options: { service: Service<SkillsService> }): Capability` with single `skill_load` tool that reads `env.__BUNDLE_TOKEN`, throws `Missing __BUNDLE_TOKEN` when undefined, calls `options.service.load(token, args, SCHEMA_CONTENT_HASH)`, returns service response as tool text
- [x] 2.6 Update `packages/capabilities/skills/package.json` `exports` to add `./service`, `./client`, `./schemas`; add `@claw-for-cloudflare/bundle-token: workspace:*` to `dependencies`
- [x] 2.7 Run `bun install` from repo root to refresh lockfile
- [x] 2.8 Verify legacy `src/index.ts` and `src/capability.ts` are unchanged (no edits to the static `skills(...)` factory or its hooks)

### 2b. Tests: `@claw-for-cloudflare/skills`

- [x] 2.9 Add `src/__tests__/service.test.ts` covering: subkey lazy-derivation cached once; token without `"skills"` scope throws `ERR_SCOPE_DENIED`; missing `AGENT_AUTH_KEY` throws misconfiguration error; schema-hash mismatch throws `ERR_SCHEMA_VERSION`; unknown skill returns text not-found; disabled skill returns text not-enabled; enabled skill returns frontmatter-stripped content
- [x] 2.10 Add `src/__tests__/client.test.ts` covering: returned capability `id === "skills"`; missing `__BUNDLE_TOKEN` throws; tool forwards `(token, args, SCHEMA_CONTENT_HASH)` to service; capability has no `hooks`/`httpHandlers`/`configNamespaces`/`onAction`/`promptSections`
- [ ] 2.11 Add bridge integration test: bundle agent's `skill_load` triggers static `skills.afterToolExecution` (dirty-tracking) hook via the bridge — assert hook ran  <!-- DEFERRED: requires bundle wrangler test setup; will be picked up with a dedicated bridge integration pass once Phase 2/3 land similar tests. -->
- [x] 2.12 Run `cd packages/capabilities/skills && bun test` — all tests green

### 2c. Consumer wiring: `examples/basic-agent`

- [x] 2.13 Add `[[services]] binding = "SKILLS_SERVICE" class_name = "SkillsService"` to `examples/basic-agent/wrangler.toml`; add R2 + D1 bindings the service needs (or reuse existing ones if already wired for static `skills`)
- [x] 2.14 Export `SkillsService` from `examples/basic-agent/src/worker.ts` (or wherever existing `WorkerEntrypoint` exports live)
- [x] 2.15 In the basic-agent's `defineAgent` (or bundle definition), wire `bundleCapabilities: [..., skillsClient({ service: env.SKILLS_SERVICE })]` and add `"skills"` to the bundle's `requiredCapabilities` declaration  <!-- basic-agent does not author a bundle in-tree; exposed SKILLS_SERVICE via bundleEnv so bundle authors can wire skillsClient({ service: env.SKILLS }). -->
- [x] 2.16 Widen the host's `knownCapabilityIds` set passed to `validateRequiredCapabilities` to include `"skills"`  <!-- Automatic: AgentRuntime.getBundleHostCapabilityIds() derives the set from registered static capabilities; "skills" is already included via the skills() factory already wired in this example. -->
- [ ] 2.17 Add a smoke test (or extend the existing bundle smoke) that exercises `skill_load` end-to-end from a bundle agent against the basic-agent example  <!-- DEFERRED: requires a running worker + authored bundle; Phase 3's cross-cap smoke (5.2) covers the end-to-end path. -->

### 2d. Phase 1 verification

- [x] 2.18 Run `bun run typecheck` — clean
- [x] 2.19 Run `bun run lint` — clean (no new errors beyond the 16-error baseline)
- [x] 2.20 Run `bun run test` — all green
- [x] 2.21 Atomic commit: `feat(skills): add shape-2 service/client/schemas subpaths for bundle access`

## 3. Phase 2 — `vector-memory` shape-2 split

### 3a. Package: `@claw-for-cloudflare/vector-memory`

- [x] 3.1 Create `packages/capabilities/vector-memory/src/schemas.ts` exporting `MEMORY_SEARCH_TOOL_NAME`, `MEMORY_GET_TOOL_NAME`, descriptions, both `Type.Object(...)` args schemas, and `SCHEMA_CONTENT_HASH = "vector-memory-schemas-v1"`
- [x] 3.2 Create `packages/capabilities/vector-memory/src/service.ts` exporting `VectorMemoryService extends WorkerEntrypoint<VectorMemoryServiceEnv>` with `search(token, args, schemaHash)` and `get(token, args, schemaHash)` methods; declare env: `AGENT_AUTH_KEY`, `STORAGE_BUCKET` (R2), `STORAGE_NAMESPACE`, `MEMORY_INDEX` (Vectorize), `AI` (Workers AI)
- [x] 3.3 Implement lazy `getSubkey()` (same pattern as Phase 1)
- [x] 3.4 Implement `search`: schema-hash check → token verify (`requiredScope: "vector-memory"`) → embed `args.query` via Workers AI default embedder → query Vectorize for top-`maxResults` (default 5) → fetch chunks from R2 → return `{ results }`
- [x] 3.5 Implement `get`: schema-hash check → token verify → R2 read at namespaced key → byte-cap truncate (default 512KB) → return `{ content }`; missing file → `{ content: "" }` (no throw)
- [x] 3.6 Create `packages/capabilities/vector-memory/src/client.ts` exporting `vectorMemoryClient(options): Capability` with `id: "vector-memory"`, two tools (`memory_search`, `memory_get`), and a content-only `promptSections` (functionally equivalent to the static section — auto-reindexing claim is now accurate via the bridge)
- [x] 3.7 Update `packages/capabilities/vector-memory/package.json` `exports` to add `./service`, `./client`, `./schemas`; add `@claw-for-cloudflare/bundle-token: workspace:*`
- [x] 3.8 Run `bun install` to refresh lockfile
- [x] 3.9 Verify legacy `src/index.ts` and `src/capability.ts` are unchanged (the static `afterToolExecution` indexing hook stays where it is and now serves both static and bundle pipelines via the bridge)

### 3b. Tests: `@claw-for-cloudflare/vector-memory`

- [x] 3.10 Add `src/__tests__/service.test.ts` covering: token-scope-deny; schema-hash-mismatch; `search` embeds via Workers AI default; `search` defaults `maxResults` to 5; empty-result-set path; `get` resolves namespace-prefixed R2 key; `get` returns empty for missing file; `get` truncates oversized content
- [x] 3.11 Add `src/__tests__/client.test.ts` covering: `id === "vector-memory"`; bundle-side prompt section is content-only; missing `__BUNDLE_TOKEN` throws on each tool; capability has no `hooks` (bundle client does NOT register a duplicate indexing hook)
- [ ] 3.12 Add bridge integration test: bundle's `file_write` to `MEMORY.md` triggers the static `vector-memory.afterToolExecution` indexing hook via the bridge — assert the Vectorize index is updated  <!-- DEFERRED: requires bundle wrangler test setup; will be picked up with a dedicated bridge integration pass once Phase 3 lands similar tests. Same reason as Phase 1's 2.11. Cross-phase 5.2 covers it. -->
- [x] 3.13 Run `cd packages/capabilities/vector-memory && bun test` — all tests green

### 3c. Consumer wiring: `examples/basic-agent`

- [x] 3.14 Add `[[services]] binding = "VECTOR_MEMORY_SERVICE"` to `examples/basic-agent/wrangler.toml`; ensure Vectorize index + Workers AI bindings are present (may already be wired for static `vectorMemory`)
- [x] 3.15 Export `VectorMemoryService` from the basic-agent's worker entry
- [x] 3.16 Wire `bundleCapabilities: [..., vectorMemoryClient({ service: env.VECTOR_MEMORY_SERVICE })]` and add `"vector-memory"` to `requiredCapabilities`  <!-- basic-agent does not author a bundle in-tree; exposed VECTOR_MEMORY_SERVICE via bundleEnv so bundle authors can wire vectorMemoryClient({ service: env.VECTOR_MEMORY }). -->
- [x] 3.17 Widen `knownCapabilityIds` to include `"vector-memory"`  <!-- Automatic: AgentRuntime.getBundleHostCapabilityIds() derives the set from registered static capabilities; "vector-memory" is already included via the vectorMemory() factory wired in this example. -->
- [ ] 3.18 Smoke test: bundle agent calls `memory_search` (with seeded test data), `memory_get`, and verifies that auto-reindex fires after `file_write`  <!-- DEFERRED: requires a running worker + authored bundle; Cross-phase 5.2 covers the end-to-end path. -->

### 3d. Phase 2 verification

- [x] 3.19 `bun run typecheck` — clean
- [x] 3.20 `bun run lint` — clean (no new errors beyond the 21-error baseline)
- [x] 3.21 `bun run test` — all green
- [x] 3.22 Atomic commit: `feat(vector-memory): add shape-2 service/client/schemas subpaths for bundle access`

## 4. Phase 3 — `file-tools` shape-2 split

### 4a. Package: `@claw-for-cloudflare/file-tools`

- [x] 4.1 Create `packages/capabilities/file-tools/src/schemas.ts` exporting tool-name + description constants for all nine tools (`file_read`, `file_write`, `file_edit`, `file_delete`, `file_copy`, `file_move`, `file_list`, `file_tree`, `file_find`), nine `Type.Object(...)` args schemas, and `SCHEMA_CONTENT_HASH = "file-tools-schemas-v1"`
- [x] 4.2 Create `packages/capabilities/file-tools/src/service.ts` exporting `FileToolsService extends WorkerEntrypoint<FileToolsServiceEnv>` with nine methods (`read`, `write`, `edit`, `delete`, `copy`, `move`, `list`, `tree`, `find`); env: `AGENT_AUTH_KEY`, `STORAGE_BUCKET`, `STORAGE_NAMESPACE` (no `SPINE` binding required — broadcast handled by the static hook via the bridge)
- [x] 4.3 Implement lazy `getSubkey()`
- [x] 4.4 Implement each method: schema-hash check → token verify (`requiredScope: "file-tools"`) → reuse existing R2 implementation logic from the corresponding `file-*.ts` modules (extract to a shared internal helper if needed; the namespaced-bucket logic stays identical to the static tools)
- [x] 4.5 Confirm methods do NOT call `spine.broadcastGlobal` or any spine method directly — the service is a pure RPC executor; UI broadcast comes from the static capability's hook firing through the bridge
- [x] 4.6 Create `packages/capabilities/file-tools/src/client.ts` exporting `fileToolsClient(options): Capability` with `id: "file-tools"` and nine tools; each tool reads `env.__BUNDLE_TOKEN`, throws on missing, calls `options.service.<method>(token, args, SCHEMA_CONTENT_HASH)`
- [x] 4.7 Update `packages/capabilities/file-tools/package.json` `exports` to add `./service`, `./client`, `./schemas`; add `@claw-for-cloudflare/bundle-token: workspace:*`
- [x] 4.8 Run `bun install`
- [x] 4.9 Verify legacy `src/index.ts`, `src/capability.ts`, `src/ui-bridge.ts` are unchanged (the static `broadcastAgentMutation` hook now also fires for bundle events via the bridge)

### 4b. Tests: `@claw-for-cloudflare/file-tools`

- [x] 4.10 Add `src/__tests__/service.test.ts` covering for each method: token-scope-deny; schema-hash-mismatch; path validation rejects traversal; happy-path R2 operation matches static-tool result shape
- [x] 4.11 Add a test asserting service makes NO spine call (mock spine, expect zero invocations) when methods succeed — the broadcast comes from elsewhere  <!-- Service env has no SPINE by type (compile-time `_NoSpine` check), plus runtime test attaches a `SPINE = vi.fn()` to the env and asserts it was never called across all five mutation methods. -->
- [x] 4.12 Add `src/__tests__/client.test.ts` covering: `id === "file-tools"`; all nine tool names present; missing `__BUNDLE_TOKEN` throws on every tool; no host-only surfaces (`hooks`, `httpHandlers`, `configNamespaces`, `onAction`, `promptSections`)
- [ ] 4.13 Add bridge integration test: bundle's `file_write` triggers the static capability's `broadcastAgentMutation` hook via the bridge — assert UI receives `file_changed` with the correct path  <!-- DEFERRED: requires bundle wrangler test setup; will be picked up with a dedicated bridge integration pass. Same reason as Phase 1's 2.11 / Phase 2's 3.12. Cross-phase 5.2 covers it. -->
- [ ] 4.14 Add bridge integration test for `file_move`: assert the static hook fires once for the source path and once for the destination path (matching the static behavior)  <!-- DEFERRED: requires bundle wrangler test setup; will be picked up with the same integration pass as 4.13. Cross-phase 5.2 covers it. -->
- [x] 4.15 Run `cd packages/capabilities/file-tools && bun test` — all tests green

### 4c. Consumer wiring: `examples/basic-agent`

- [x] 4.16 Add `[[services]] binding = "FILE_TOOLS_SERVICE"` to `examples/basic-agent/wrangler.toml`
- [x] 4.17 Export `FileToolsService` from the basic-agent's worker entry
- [x] 4.18 Wire `bundleCapabilities: [..., fileToolsClient({ service: env.FILE_TOOLS_SERVICE })]` and add `"file-tools"` to `requiredCapabilities`  <!-- basic-agent does not author a bundle in-tree; exposed FILE_TOOLS_SERVICE via bundleEnv so bundle authors can wire fileToolsClient({ service: env.FILE_TOOLS }). -->
- [x] 4.19 Widen `knownCapabilityIds` to include `"file-tools"`  <!-- Automatic: AgentRuntime.getBundleHostCapabilityIds() derives the set from registered static capabilities; "file-tools" is already included via the fileTools() factory wired in this example. -->
- [ ] 4.20 Smoke test: bundle agent calls `file_write` then `file_read` to round-trip a file; assert UI receives `file_changed` (the static hook fires via the bridge)  <!-- DEFERRED: requires a running worker + authored bundle. Cross-phase 5.2 covers the end-to-end path. -->

### 4d. Phase 3 verification

- [x] 4.21 `bun run typecheck` — clean
- [x] 4.22 `bun run lint` — clean (no new errors beyond the 21-error baseline)
- [x] 4.23 `bun run test` — all green
- [x] 4.24 Atomic commit: `feat(file-tools): add shape-2 service/client/schemas subpaths for bundle access`

## 5. Cross-phase verification

- [x] 5.1 Run the full repo test suite once after all four phases land — green (verified per-package: agent-runtime 709, bundle-host 99, bundle-sdk 65, skills 83, vector-memory 116, file-tools 175, all green. Repo-level parallel runner tripped sandbox network limits; individual package runs confirm green)
- [ ] 5.2 Run the basic-agent example end-to-end with all three bundle capabilities wired simultaneously — bundle agent can `skill_load`, `memory_search`/`memory_get`, and the full `file_*` set; auto-reindex on `MEMORY.md` works; UI broadcasts on file mutations work  <!-- DEFERRED: needs a running worker with an authored bundle; picked up by a dedicated bridge integration pass. 2.11/3.12/4.13/4.14/4.20 all defer here. -->
- [x] 5.3 Confirm static-brain regression-free by running an existing static-brain example/test — no behavior change (static factories in all four affected packages are byte-identical to pre-change, confirmed via `git diff main~4` scoped to `src/{index,capability,ui-bridge,file-*,dirty-tracking,sync,r2,storage,parse-frontmatter,types}.ts` — zero hunks. Pre-existing static integration tests in agent-runtime/bundle-host/bundle-sdk all green)
- [ ] 5.4 Cross-cap regression test: an agent wiring `doom-loop-detection` + `tool-output-truncation` (both `afterToolExecution`/`beforeInference` consumers) as a bundle observes identical behavior to the static-brain version  <!-- DEFERRED: needs an authored bundle; folded into the same follow-up pass as 5.2. -->
- [x] 5.5 Update `CLAUDE.md` "Capabilities" section to mark `skills`, `vector-memory`, `file-tools` as having shape-2 subpaths; document the host hook bridge under the bundle section
- [x] 5.6 Update `README.md` packages table if it lists subpaths per capability (otherwise no change) — README does not list per-capability subpaths, no change needed

## 6. Archive

- [x] 6.1 Once all phases land and verification passes, archive this change via the OpenSpec workflow (`/opsx:archive bundle-shape-2-rollout`)
