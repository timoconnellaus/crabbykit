## ADDED Requirements

### Requirement: Sync on connect detects new skills
The system SHALL install skills from the declarations array that are not yet present in DO KV. Installation writes content to R2 and creates a metadata entry in DO KV with `origin: "registry"`, `dirty: false`, and the registry version and content hash.

#### Scenario: First install of a declared skill
- **WHEN** a skill ID appears in declarations but has no DO KV entry
- **THEN** the system fetches the skill from the registry, validates capability dependencies, writes content to R2, and creates a DO KV entry with `origin: "registry"`, `enabled: true`, `dirty: false`, `registryVersion` and `registryHash` from the registry record

#### Scenario: Declared skill not found in registry
- **WHEN** a skill ID appears in declarations but `registry.get(id)` returns null
- **THEN** the system logs a warning and skips the skill without creating any state

#### Scenario: Declared skill has missing capability dependencies
- **WHEN** a skill requires capabilities not registered on this agent
- **THEN** the system creates a DO KV entry with `enabled: false` and logs the missing capabilities

### Requirement: Sync auto-updates clean skills
The system SHALL overwrite R2 content and update DO KV metadata when a new registry version is available and the skill is not dirty.

#### Scenario: New version available, skill is clean
- **WHEN** `registryVersion` differs from the registry's current version AND `dirty` is `false`
- **THEN** the system overwrites R2 with the new content, updates `registryVersion` and `registryHash` to the new values

#### Scenario: Same version, no action
- **WHEN** `registryVersion` matches the registry's current version
- **THEN** the system takes no action on R2 or DO KV (except syncing enabled/disabled from declarations)

### Requirement: Sync detects conflicts on dirty skills
The system SHALL create a `SkillConflict` record when a new registry version is available but the skill is dirty.

#### Scenario: New version available, skill is dirty
- **WHEN** `registryVersion` differs from the registry's current version AND `dirty` is `true`
- **THEN** the system stores a `SkillConflict` record in DO KV with the upstream content, version, and hash, and does NOT modify R2 content

#### Scenario: Conflict already exists, newer version arrives
- **WHEN** a conflict record already exists for a skill AND a newer version is available in the registry
- **THEN** the system updates the conflict record with the latest upstream content, version, and hash

### Requirement: Dirty flag tracked at mutation time
The system SHALL update the dirty flag in `afterToolExecution` when `file_write`, `file_edit`, or `file_delete` target a skill path.

#### Scenario: Agent edits a registry-origin skill
- **WHEN** `file_write` or `file_edit` targets `skills/{id}/SKILL.md` AND the skill has `origin: "registry"`
- **THEN** the system hashes the new R2 content and sets `dirty` to `true` if the hash differs from `registryHash`, or `false` if it matches

#### Scenario: Agent edits an agent-origin skill
- **WHEN** `file_write` or `file_edit` targets `skills/{id}/SKILL.md` AND the skill has `origin: "agent"`
- **THEN** the system parses frontmatter and updates DO KV metadata (name, description) but does not set a dirty flag

#### Scenario: Agent creates a new skill
- **WHEN** `file_write` targets `skills/{id}/SKILL.md` AND no DO KV entry exists for that ID
- **THEN** the system parses frontmatter and creates a DO KV entry with `origin: "agent"`, `enabled: true`

### Requirement: Conflict resolution on write
The system SHALL clear a conflict when the agent writes to a conflicted skill.

#### Scenario: Agent writes merged content to a conflicted skill
- **WHEN** `file_write` or `file_edit` targets a skill that has a pending `SkillConflict`
- **THEN** the system clears the conflict record, updates `registryVersion` to the conflict's `upstreamVersion`, sets `registryHash` to the hash of the newly written content, and sets `dirty: false`

### Requirement: Deletion behavior depends on origin
The system SHALL disable registry-origin skills on delete and fully remove agent-origin skills.

#### Scenario: Agent deletes a registry-origin skill
- **WHEN** `file_delete` targets `skills/{id}/SKILL.md` AND the skill has `origin: "registry"`
- **THEN** the system sets `enabled: false` in DO KV and clears any conflict record, but preserves the DO KV entry

#### Scenario: Agent deletes an agent-origin skill
- **WHEN** `file_delete` targets `skills/{id}/SKILL.md` AND the skill has `origin: "agent"`
- **THEN** the system deletes the DO KV entry entirely

### Requirement: Metadata refresh and broadcast after mutations
The system SHALL refresh the in-memory skill cache and broadcast a `skill_list_update` message after any skill state change.

#### Scenario: Any skill mutation completes
- **WHEN** sync completes, or `afterToolExecution` modifies skill state, or a user installs/uninstalls a skill
- **THEN** the system refreshes the cached skills map and broadcasts `skill_list_update` with the current skill list

### Requirement: Conflict surfaced via beforeInference
The system SHALL inject a merge task into the message stream when conflicts exist and the user requests resolution.

#### Scenario: Pending conflict exists during inference
- **WHEN** `beforeInference` runs and there are pending `SkillConflict` records
- **THEN** the system injects a user message describing the conflict, including the current skill content path and the upstream version content, instructing the agent to merge preserving user edits

### Requirement: Skill removal from declarations preserves installed state
The system SHALL NOT delete skills that were previously installed but are no longer in the declarations array.

#### Scenario: Developer removes a skill from declarations
- **WHEN** a skill exists in DO KV with `origin: "registry"` but its ID is no longer in the declarations array
- **THEN** the system takes no action — the skill remains installed and functional, but stops receiving upstream sync
