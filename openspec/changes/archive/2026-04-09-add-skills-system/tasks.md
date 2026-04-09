## 1. Transport Type Extension

- [x] 1.1 Add `SkillListMessage` type to `packages/agent-runtime/src/transport/types.ts` — `{ type: "skill_list"; skills: SkillListEntry[] }` — and add it to the `ServerMessage` union
- [x] 1.2 Add `SkillListEntry` type: `{ id, name, description, version, enabled, autoUpdate, stale }`
- [x] 1.3 Export new types from `packages/agent-runtime/src/index.ts` barrel
- [x] 1.4 Update client message handler in `packages/agent-runtime/src/client/message-handler.ts` to handle `skill_list` messages
- [x] 1.5 Add tests for the new message type discrimination and client handler

## 2. Skill Registry Package

- [x] 2.1 Scaffold `packages/skill-registry` — package.json, tsconfig.json, vitest.config.ts, src/index.ts barrel
- [x] 2.2 Define `SkillRecord` type and `SkillRegistry` interface in `src/types.ts`
- [x] 2.3 Implement `D1SkillRegistry` in `src/d1-registry.ts` — constructor, `ensureTable()`, `list()`, `get()`, `getVersion()`, `upsert()`, `delete()`
- [x] 2.4 Implement SHA-256 content hash computation in `upsert()` using Web Crypto API
- [x] 2.5 Add description length validation (max 250 chars) in `upsert()`
- [x] 2.6 Add tests: `src/__tests__/d1-registry.test.ts` — cover all CRUD operations, hash computation, description validation, empty state, idempotent table creation. Use miniflare D1 or in-memory mock.
- [x] 2.7 Add `seeds` option to `D1SkillRegistry` constructor — accepts an array of skill definitions. On `ensureTable()`, idempotently upserts all seeds (insert new, update changed via hash comparison, skip unchanged).
- [x] 2.8 Add `SkillSeed` type: `Omit<SkillRecord, "contentHash" | "createdAt" | "updatedAt">` — the input shape for seed definitions
- [x] 2.9 Add tests for seeding: seeds inserted on first boot, unchanged seeds skipped, changed seeds updated, new seeds added on subsequent boot

## 3. Skills Capability Package — Core

- [x] 3.1 Scaffold `packages/skills` — package.json (depends on `@claw-for-cloudflare/skill-registry`, `@claw-for-cloudflare/agent-storage`), tsconfig.json, vitest.config.ts, src/index.ts barrel
- [x] 3.2 Define `SkillsOptions` type in `src/types.ts`: `{ storage: AgentStorage, registry: SkillRegistry, skills: Array<{ id: string, enabled?: boolean, autoUpdate?: boolean }> }`
- [x] 3.3 Define `InstalledSkill` type for DO state entries: `{ name, description, version, enabled, autoUpdate, stale, originalHash, r2Key, requiresCapabilities }`
- [x] 3.4 Implement `skills()` factory function in `src/capability.ts` returning a `Capability` with id `"skills"`

## 4. Skills Capability — Storage Layer

- [x] 4.1 Implement skill index read/write helpers using scoped `CapabilityStorage` — `getInstalledSkill(storage, id)`, `putInstalledSkill(storage, id, record)`, `listInstalledSkills(storage)`, `deleteInstalledSkill(storage, id)`
- [x] 4.2 Implement R2 read/write helpers — `writeSkillToR2(bucket, namespace, skillId, content)`, `readSkillFromR2(bucket, namespace, skillId)`, `deleteSkillFromR2(bucket, namespace, skillId)`, `hashSkillContent(content)` using SHA-256
- [x] 4.3 Add tests for storage helpers: index CRUD, R2 operations with mock bucket, hash consistency

## 5. Skills Capability — Sync Engine

- [x] 5.1 Implement `syncSkills()` — the core sync logic called from `onConnect`. For each declared skill: fetch from registry, compare versions, detect user modifications via hash, apply update or mark stale
- [x] 5.2 Implement capability dependency validation — cross-reference skill `requiresCapabilities` against resolved capability IDs, keep ineligible skills disabled with warning
- [x] 5.3 Implement pending merge storage — `setPendingMerge(storage, skillId, newContent, newVersion)`, `getPendingMerges(storage)`, `clearPendingMerge(storage, skillId)`
- [x] 5.4 Add tests for sync scenarios: no updates, clean update, user-modified with autoUpdate on/off, registry unreachable, missing capability dependency

## 6. Skills Capability — Tools and Prompt

- [x] 6.1 Implement `skill_load` tool using `defineTool()` — reads from R2, strips frontmatter, returns body as text. Validates skill exists and is enabled.
- [x] 6.2 Implement `promptSections()` — reads installed skills from DO state, formats enabled skills as name + description list, includes `skill_load` usage instruction
- [x] 6.3 Add tests for `skill_load`: happy path, disabled skill, missing skill, frontmatter stripping
- [x] 6.4 Add tests for `promptSections`: enabled skills listed, disabled excluded, empty state returns empty array

## 7. Skills Capability — Hooks

- [x] 7.1 Implement `onConnect` hook — calls `syncSkills()`, broadcasts `skill_list` message
- [x] 7.2 Implement `beforeInference` hook — checks for pending merges, injects hidden merge instruction message with new version content
- [x] 7.3 Implement `afterToolExecution` hook — detects `file_write` to skill R2 paths, clears pending merge and updates `originalHash`
- [x] 7.4 Implement `onConfigChange` hook — handles enable/disable transitions (R2 write/delete) and autoUpdate toggle changes
- [x] 7.5 Add tests for hooks: onConnect sync + broadcast, beforeInference merge injection, afterToolExecution merge completion, onConfigChange state transitions

## 8. Skills Capability — Config Integration

- [x] 8.1 Implement `configNamespaces` — expose per-skill `enabled` and `autoUpdate` toggles via config_get/config_set
- [x] 8.2 Add tests for config integration: get returns current state, set triggers state transitions

## 9. UI — SkillPanel Component

- [x] 9.1 Add `skill_list` handling to `useAgentChat` hook in `packages/agent-ui` — store skill list in state, update on `skill_list` messages
- [x] 9.2 Create `SkillPanel` component — displays skill list with name, description, version, enabled/autoUpdate toggles, stale indicator, and a "View" button
- [x] 9.3 Create `SkillViewer` component — modal or expandable panel that loads and displays SKILL.md content (read-only)
- [ ] 9.4 Add tests for SkillPanel: renders skill list, shows stale indicator, toggle callbacks

## 10. Example App Integration

- [x] 10.1 Add `SKILL_DB` D1 binding to `examples/basic-agent/wrangler.jsonc`
- [x] 10.2 Add `skills()` capability to `BasicAgent.getCapabilities()` with 1-2 example skills
- [x] 10.3 Define example skill content inline in `worker.ts` and pass as `seeds` to `D1SkillRegistry` constructor
- [x] 10.4 Add SkillPanel to the example app's UI layout
- [ ] 10.5 Verify end-to-end: skill appears in prompt, agent can load it, UI shows skill list

## 11. Documentation

- [x] 11.1 Update CLAUDE.md — add `packages/skill-registry` and `packages/skills` to "What the SDK Provides Today" and "Project Structure"
- [x] 11.2 Update README.md — add both packages to the packages table
