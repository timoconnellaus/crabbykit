## Context

The skills system has two packages: `skill-registry` (D1-backed catalog) and `skills` (capability that syncs from registry, stores per-agent state in DO KV + R2). Skills are markdown files (SKILL.md) with YAML frontmatter for metadata. The agent sees a menu of skill names/descriptions in the system prompt and lazy-loads full content via `skill_load`.

Currently, skill definitions are inline `SkillSeed[]` arrays in consumer code (e.g., `examples/basic-agent/src/worker.ts`). Sync runs on every `onConnect`, reads every enabled skill from R2 to hash-check for modifications, and handles 5 distinct scenarios in a 185-line function. Conflict resolution injects merge prompts into `beforeInference` and watches for `file_write` tool calls in `afterToolExecution`.

The system works but is fragile, hard to reason about, and has already produced bugs around version propagation.

## Goals / Non-Goals

**Goals:**
- Reduce sync logic from 5 scenarios to 3 (new, update-clean, update-dirty)
- Track dirty state incrementally at mutation time, eliminating R2 reads during sync
- Make skills first-class workspace files in a `skills/` folder
- Handle all mutation edges: agent edit, agent create, agent delete, user install/uninstall, developer declaration changes
- Keep the merge flow where the agent resolves conflicts, but simplify the mechanism

**Non-Goals:**
- Changing the `skill_load` tool behavior or the lazy-loading UX
- Multi-version history or rollback for skills
- Cross-agent skill sharing (skills remain per-agent in R2)
- Changing the D1 registry schema (only the seeding input changes)
- UI redesign (transport message shape changes are minimal)

## Decisions

### D1: Dirty tracking at mutation time, not sync time

**Choice:** The `afterToolExecution` hook watches `file_write`, `file_edit`, and `file_delete` on paths matching `skills/{id}/SKILL.md`. On each write, it hashes the new content and compares to `registryHash` to set/clear the dirty flag.

**Alternative considered:** Continue hashing at sync time (current approach). Rejected because it requires an R2 GET per enabled skill on every connection, and the sync function must handle the "modified since last sync" case inline.

**Alternative considered:** Use R2 object metadata (custom headers) to store the hash. Rejected because it couples the dirty detection to R2's metadata API and doesn't help with the sync complexity.

### D2: Conflicts stored in DO KV, resolved by any write to the skill

**Choice:** When sync detects a dirty skill with a new upstream version, it stores a `SkillConflict` record in DO KV (`conflict:{id}`). The conflict contains the upstream content, version, and hash. When the agent (or user) next writes to that skill's R2 path, `afterToolExecution` detects the conflict exists, clears it, and updates `registryVersion` and `registryHash` to the upstream version with the hash of whatever was just written. The merged result becomes the new base.

**Alternative considered:** Keep the `beforeInference` injection for immediate merge. This works but couples sync timing to inference timing and makes the merge invisible to the UI. The new approach lets the UI show "conflicted" state and the user can trigger the merge when ready.

**Alternative considered:** Dedicated merge tools (`skill_merge`, `skill_accept_upstream`). Rejected because the agent already has `file_write`/`file_edit` and skills are just R2 files. Adding skill-specific write tools creates a parallel mutation path.

### D3: Skills as workspace files, parsed for seeding

**Choice:** A `skills/` folder at workspace root contains authored SKILL.md files organized as `skills/{id}/SKILL.md`. Frontmatter is parsed to extract metadata (`name`, `description`, `version`, `requires`). These replace the `SkillSeed[]` arrays.

The `skill-registry` package exports a `parseSkillFile(content: string): SkillSeed` function. Consumer code (or a build step) reads files from the `skills/` folder and passes parsed seeds to `D1SkillRegistry`.

**Alternative considered:** Automatic file discovery at runtime (glob the skills folder). Rejected because Workers don't have filesystem access — the files must be bundled or read at build time.

### D4: Registry-origin deletion becomes disable

**Choice:** When an agent calls `file_delete` on a registry-origin skill, the `afterToolExecution` hook sets `enabled: false` and clears the R2 content, but preserves the DO KV metadata. Agent-origin skills are fully deleted (DO KV entry removed).

**Rationale:** Registry-origin skills have an upstream identity. Disabling preserves the ability to re-enable or re-sync. Agent-origin skills have no upstream — deletion is final.

### D5: Built-in check via declarations array, not stored flag

**Choice:** Whether a skill is "built-in" (declared by the developer, cannot be uninstalled) is determined at runtime by checking if the skill ID exists in the `declarations` array passed to the capability. No `builtIn` field stored in DO KV.

**Rationale:** The declarations array is available in the capability closure. Storing a flag duplicates state and can drift if the developer changes their declarations.

### D6: Frontmatter parsed on agent writes

**Choice:** When `afterToolExecution` detects a write to a skill path, it reads the new content, parses YAML frontmatter, and updates the DO KV metadata (`name`, `description`). This keeps the prompt menu in sync with agent-edited content.

**Rationale:** The agent may edit frontmatter when customizing or creating skills. Without this, the prompt menu would show stale metadata until next sync.

## Risks / Trade-offs

**[Risk] `afterToolExecution` misses a mutation path** — If R2 content is modified outside of `file_write`/`file_edit`/`file_delete` (e.g., direct R2 API, another capability), the dirty flag won't update.
  Mitigation: Skills are expected to be modified through the r2-storage tools. Document this as a constraint. A periodic hash-check could be added later if needed.

**[Risk] Frontmatter parsing fails on malformed YAML** — Agent-written SKILL.md might have invalid frontmatter.
  Mitigation: Fall back to using the skill ID as the name and an empty description. Log a warning. Don't fail the write.

**[Risk] Conflict stored but never resolved** — User never asks the agent to merge.
  Mitigation: The conflict persists but doesn't block anything. The old version remains functional. The UI shows "update available" status. No automatic degradation.

**[Risk] Race between sync and agent write** — Agent writes to a skill while sync is overwriting it with a new version.
  Mitigation: Both operations are in the same DO, which is single-threaded. No concurrent writes possible within a single DO instance.
