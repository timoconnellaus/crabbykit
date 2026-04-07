## 1. Data Model & Storage

- [ ] 1.1 Replace `InstalledSkill` type in `packages/skills/src/types.ts` with new model (origin, dirty, registryVersion, registryHash; remove autoUpdate, stale, originalHash, r2Key, builtIn)
- [ ] 1.2 Replace `PendingMerge` type with `SkillConflict` type (skillId, upstreamContent, upstreamVersion, upstreamHash)
- [ ] 1.3 Update `packages/skills/src/storage.ts` — replace `merge:` prefix operations with `conflict:` prefix operations (setConflict, getConflicts, clearConflict)
- [ ] 1.4 Remove `SkillSeed` type from `packages/skill-registry/src/types.ts` and replace with frontmatter-parsed equivalent

## 2. Frontmatter Parsing

- [ ] 2.1 Add `parseSkillFile(id: string, content: string): SkillSeed` to `packages/skill-registry/src/` — extracts name, description, version, requires from YAML frontmatter
- [ ] 2.2 Add `parseFrontmatter(content: string): { name?: string; description?: string; version?: string; requires?: string[] }` to `packages/skills/src/` for use in afterToolExecution hook (lenient, no throws)
- [ ] 2.3 Write tests for both parsers in colocated `__tests__/` dirs. Cover: valid frontmatter, missing fields, malformed YAML, no frontmatter, empty content, CRLF line endings. Follow patterns from `packages/r2-storage/src/__tests__/`

## 3. Workspace Skills Folder

- [ ] 3.1 Create `skills/vibe-webapp/SKILL.md` — move content from `VIBE_WEBAPP_SKILL_MD` in worker.ts, add proper frontmatter
- [ ] 3.2 Create `skills/code-review/SKILL.md` and `skills/debug-systematic/SKILL.md` from inline definitions in worker.ts
- [ ] 3.3 Update `examples/basic-agent/src/worker.ts` — read skill files and pass parsed seeds to `D1SkillRegistry` instead of inline `SkillSeed[]`

## 4. Sync Rewrite

- [ ] 4.1 Rewrite `packages/skills/src/sync.ts` with 3 scenarios: new skill, update-clean (auto-overwrite), update-dirty (create conflict)
- [ ] 4.2 Handle edge cases: skill not in registry (skip), missing capability deps (install disabled), skill removed from declarations (no-op)
- [ ] 4.3 Write tests for all sync scenarios in `packages/skills/src/__tests__/sync.test.ts` using `createMockStorage()` from test-utils. Cover: first install (happy path), first install with missing caps (disabled), not in registry (skip), update-clean (overwrite), update-dirty (conflict created), same version (no-op), declaration removed (no-op), conflict already exists with newer version (update conflict), registry failure (non-fatal)

## 5. Dirty Tracking & Conflict Resolution

- [ ] 5.1 Implement `afterToolExecution` hook watching `file_write`/`file_edit`/`file_delete` on `skills/{id}/SKILL.md` paths
- [ ] 5.2 Handle registry-origin writes: hash content, update dirty flag, parse frontmatter for metadata
- [ ] 5.3 Handle agent-origin writes: parse frontmatter, update metadata, create DO KV entry for new skills
- [ ] 5.4 Handle conflict resolution: on write to conflicted skill, clear conflict, update registryVersion/registryHash, set dirty=false
- [ ] 5.5 Handle deletions: registry-origin → disable, agent-origin → delete DO KV entry
- [ ] 5.6 Write tests for all afterToolExecution scenarios in `packages/skills/src/__tests__/dirty-tracking.test.ts`. Cover: file_write to registry-origin (dirty=true), file_write matching registryHash (dirty=false, revert case), file_edit on registry-origin, file_write creating new agent-origin skill, file_write to conflicted skill (conflict cleared, registryVersion updated), file_delete on registry-origin (disabled), file_delete on agent-origin (removed), file_write/edit to non-skill path (ignored), frontmatter parse failure (fallback metadata)

## 6. Capability Integration

- [ ] 6.1 Update `packages/skills/src/capability.ts` — remove autoUpdate/stale logic, wire new sync and afterToolExecution hook
- [ ] 6.2 Simplify `beforeInference` — check for `conflict:` entries instead of `merge:` entries
- [ ] 6.3 Update `promptSections()` — use new InstalledSkill shape
- [ ] 6.4 Update HTTP handlers — replace builtIn check with declarations-array check for uninstall guard
- [ ] 6.5 Update `onConfigChange` hook for new data model
- [ ] 6.6 Remove `buildSkillList` / update transport message shape for fewer fields

## 7. Cleanup & Verification

- [ ] 7.1 Remove dead code: old sync scenarios, PendingMerge storage ops, stale/autoUpdate/builtIn references
- [ ] 7.2 Write tests for HTTP handlers in `packages/skills/src/__tests__/http-handlers.test.ts`. Cover: GET /skills/registry (filters installed), POST /skills/install (happy path, already installed, not in registry, missing caps), POST /skills/uninstall (user-installed allowed, declared skill blocked, agent-origin allowed, not found)
- [ ] 7.3 Write tests for promptSections() — enabled skills listed, disabled skills excluded, conflicted skills still listed, empty cache returns empty, frontmatter metadata reflected
- [ ] 7.4 Write tests for beforeInference conflict injection — no conflicts (passthrough), single conflict (message injected with upstream content), multiple conflicts
- [ ] 7.5 Update existing tests in `packages/skills/src/__tests__/capability.test.ts` for new model
- [ ] 7.6 Run full test suite (`bun run test`) and fix any breakage
- [ ] 7.7 Run typecheck (`bun run typecheck`) across workspaces
- [ ] 7.8 Update CLAUDE.md — skills package description, data model changes
