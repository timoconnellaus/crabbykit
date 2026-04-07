## Why

The current skill sync system uses three stores (D1 registry, DO KV metadata, R2 content) with a complex 5-scenario sync function, hash-based merge detection at sync time, and a fragile conflict resolution flow that injects merge prompts into `beforeInference` and watches for `file_write` calls in `afterToolExecution`. The data model has 5 types (`SkillSeed`, `SkillRecord`, `SkillDeclaration`, `InstalledSkill`, `PendingMerge`) for what is fundamentally "a markdown file with a version." Skill definitions are inline strings in the example agent rather than first-class authored files. Version bump propagation has already caused bugs (commit 8ce6621).

## What Changes

- **Simplify data model**: Replace `InstalledSkill` (9 fields), `PendingMerge`, `SkillSeed` with a leaner `InstalledSkill` (origin tracking, dirty flag, registry base hash) and `SkillConflict`.
- **Track dirty state at mutation time** instead of computing it at sync time via R2 reads. The `afterToolExecution` hook watches `file_write`/`file_edit`/`file_delete` on skill paths and maintains the dirty flag incrementally.
- **Simplify sync to 3 scenarios**: new skill, update-clean (auto-overwrite), update-dirty (conflict). Eliminates the current 5-scenario `syncSingleSkill`.
- **Remove `autoUpdate` and `stale` flags**. Auto-update is always on for clean skills. Dirty replaces stale.
- **Remove `PendingMerge` storage prefix**. Conflicts stored as a simpler type, cleared atomically when the agent writes the merged result.
- **Remove `r2Key` and `builtIn` fields**. R2 key is deterministic from skill ID. Built-in status derived from checking the declarations array at runtime.
- **Move skill definitions to workspace `skills/` folder**. Skills become authored SKILL.md files with YAML frontmatter, parsed at seed time instead of constructed as `SkillSeed` objects.
- **Parse frontmatter on agent writes**. When agents edit or create skills, `afterToolExecution` parses frontmatter to keep DO KV metadata (name, description) in sync automatically.
- **Registry-origin deletion becomes disable**. Agent deleting a registry-origin skill sets `enabled: false` rather than removing the DO KV entry. Agent-origin skills are fully deleted.

## Capabilities

### New Capabilities

- `skill-sync`: The core sync mechanism — dirty tracking, conflict detection, conflict resolution, and the `afterToolExecution` hook that watches file mutations on skill paths.
- `skill-storage`: Data model and storage operations for installed skills and conflicts in DO KV, plus R2 read/write/delete.
- `skill-registry-seeding`: Parsing SKILL.md files from the workspace `skills/` folder, extracting frontmatter, and seeding the D1 registry.

### Modified Capabilities

(No existing specs to modify.)

## Impact

- **`packages/skills/`** — Major rewrite of `sync.ts`, `capability.ts`, `storage.ts`, `types.ts`. Simplified data model and sync logic.
- **`packages/skill-registry/`** — `SkillSeed` type replaced by frontmatter parsing. `D1SkillRegistry` seeding updated.
- **`examples/basic-agent/src/worker.ts`** — Inline skill content removed. References workspace `skills/` folder.
- **New `skills/` workspace folder** — First-class location for authored skill SKILL.md files.
- **Transport protocol** — `skill_list_update` message shape changes (fewer fields per skill).
- **UI** — Skill list display may need updating for new status model (dirty/conflicted instead of stale).
- **Tests** — `packages/skills/src/__tests__/` and registry tests need rewriting for new model.
