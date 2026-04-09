# skills Specification

## Purpose
TBD - created by archiving change add-skills-system. Update Purpose after archive.
## Requirements
### Requirement: Skills capability factory
The system SHALL export a `skills()` factory function that returns a `Capability` with id `"skills"`. It SHALL accept options: `storage` (AgentStorage), `registry` (SkillRegistry), and `skills` (array of `{ id: string, enabled?: boolean, autoUpdate?: boolean }`).

#### Scenario: Capability registration
- **WHEN** a consumer includes `skills({ storage, registry, skills: [...] })` in `getCapabilities()`
- **THEN** the returned Capability has id `"skills"`, a `tools()` method, a `promptSections()` method, and `hooks`

### Requirement: Skill index stored in DO state
The skills capability SHALL maintain an index of all declared skills in scoped capability storage (`cap:skills:installed:{id}`). Each index entry SHALL contain: `name`, `description`, `version`, `enabled`, `autoUpdate`, `stale`, `originalHash`, `r2Key`, and `requiresCapabilities`.

#### Scenario: Index populated on first connect
- **WHEN** the agent receives its first WebSocket connection
- **THEN** the `onConnect` hook fetches all declared skills from the registry and writes index entries to DO storage

#### Scenario: Index survives DO restarts
- **WHEN** the DO hibernates and wakes
- **THEN** the skill index is still in DO storage and promptSections reads from it without re-fetching

### Requirement: Enabled skills written to R2
When a skill is enabled, the capability SHALL write its SKILL.md content to R2 at the path `skills/{skill-id}/SKILL.md` under the agent's storage namespace. When a skill is disabled, the capability SHALL delete the SKILL.md from R2.

#### Scenario: Enable a skill
- **WHEN** a skill transitions from disabled to enabled
- **THEN** its SKILL.md content is written to R2 and `r2Key` is set in the index

#### Scenario: Disable a skill
- **WHEN** a skill transitions from enabled to disabled
- **THEN** its SKILL.md is deleted from R2 and `r2Key` is cleared in the index

### Requirement: promptSections injects skill list
The `promptSections()` method SHALL return a section listing all enabled skills with their names and descriptions (max 250 chars each). The section SHALL instruct the agent to use the `skill_load` tool to load a skill into context when its description matches the current task. The section SHALL read from DO state only (no R2 or registry calls).

#### Scenario: Prompt with enabled skills
- **WHEN** the agent has 2 enabled skills: "code-review" and "debug-memory"
- **THEN** the prompt section lists both with descriptions and a `skill_load` instruction

#### Scenario: Prompt with no enabled skills
- **WHEN** all skills are disabled
- **THEN** the prompt section is omitted (empty array returned)

#### Scenario: Disabled skills excluded from prompt
- **WHEN** 3 skills are declared but 1 is disabled
- **THEN** only the 2 enabled skills appear in the prompt section

### Requirement: skill_load tool
The capability SHALL provide a `skill_load` tool that accepts a skill name (string) and returns the SKILL.md content from R2. The tool SHALL only load enabled skills. The tool result SHALL contain the markdown body of the SKILL.md (excluding frontmatter).

#### Scenario: Load an enabled skill
- **WHEN** the agent calls `skill_load({ name: "code-review" })`
- **THEN** the tool reads `skills/code-review/SKILL.md` from R2 and returns the content as text

#### Scenario: Load a disabled skill
- **WHEN** the agent calls `skill_load({ name: "vibe-webapp" })` and the skill is disabled
- **THEN** the tool returns an error: "Skill 'vibe-webapp' is not enabled"

#### Scenario: Load a non-existent skill
- **WHEN** the agent calls `skill_load({ name: "nonexistent" })`
- **THEN** the tool returns an error: "Skill 'nonexistent' not found"

### Requirement: Sync on connect checks for updates
The `onConnect` hook SHALL check the registry for newer versions of all declared skills. For each enabled skill, it SHALL compare the registry version against the installed version.

#### Scenario: No updates available
- **WHEN** the registry version matches the installed version for all skills
- **THEN** no changes are made to R2 or DO state

#### Scenario: Update available, user has not modified
- **WHEN** the registry has a newer version and the R2 content hash matches `originalHash`
- **THEN** the skill is overwritten in R2 with the new version, and the index is updated with the new version and hash

#### Scenario: Update available, user has modified, autoUpdate enabled
- **WHEN** the registry has a newer version, the R2 content hash differs from `originalHash`, and `autoUpdate` is true
- **THEN** the new version is stored as a pending merge in DO state and a merge message is queued for the next inference

#### Scenario: Update available, user has modified, autoUpdate disabled
- **WHEN** the registry has a newer version, the R2 content hash differs from `originalHash`, and `autoUpdate` is false
- **THEN** the skill is marked `stale: true` in the index and no R2 changes are made

### Requirement: Registry fetch failure is non-fatal
If the registry is unreachable during sync, the capability SHALL log a warning and continue with cached DO state. Existing enabled skills SHALL remain functional.

#### Scenario: Registry down on connect
- **WHEN** the registry fetch throws an error during onConnect
- **THEN** the capability logs a warning, uses cached state, and the agent still sees its previously synced skills

### Requirement: Agent-assisted merge via beforeInference
When pending merges exist in DO state, the `beforeInference` hook SHALL inject a hidden user message instructing the agent to merge the skill update. The message SHALL include the new version content and instruct the agent to load the current version via `skill_load`, then write the merged result via `file_write`.

#### Scenario: Merge message injected
- **WHEN** a pending merge exists for "code-review" and inference starts
- **THEN** a hidden message is prepended to the messages array with merge instructions

#### Scenario: No pending merges
- **WHEN** no pending merges exist
- **THEN** the beforeInference hook passes messages through unchanged

### Requirement: Merge completion detection
The `afterToolExecution` hook SHALL detect when the agent writes to a skill's R2 path via `file_write`. When this happens for a skill with a pending merge, the hook SHALL clear the pending merge, hash the new content, and update `originalHash` in the index.

#### Scenario: Agent completes merge
- **WHEN** the agent calls `file_write` to `skills/code-review/SKILL.md` and a pending merge exists for "code-review"
- **THEN** the pending merge is cleared and `originalHash` is updated to the hash of the new content

### Requirement: Config integration
The capability SHALL expose a `configNamespaces` that allows toggling `enabled` and `autoUpdate` per skill via `config_get`/`config_set`. The `onConfigChange` hook SHALL handle state transitions: enabling writes to R2, disabling deletes from R2.

#### Scenario: Disable a skill via config
- **WHEN** the agent calls `config_set` to set skill "code-review" enabled to false
- **THEN** the SKILL.md is deleted from R2, the index is updated, and a `skill_list` message is broadcast

#### Scenario: Enable a skill via config
- **WHEN** the agent calls `config_set` to set skill "vibe-webapp" enabled to true
- **THEN** the SKILL.md is fetched from registry, written to R2, and the index is updated

### Requirement: Capability dependency validation
During sync, the capability SHALL check each skill's `requiresCapabilities` against the agent's registered capability IDs. Skills whose required capabilities are not present SHALL remain disabled with a warning logged.

#### Scenario: Missing required capability
- **WHEN** skill "vibe-webapp" requires capability "vibe-coder" but the agent doesn't have it
- **THEN** the skill stays disabled and a warning is logged: "Skill 'vibe-webapp' requires capability 'vibe-coder' which is not registered"

#### Scenario: All required capabilities present
- **WHEN** skill "vibe-webapp" requires "vibe-coder" and "sandbox", both present
- **THEN** the skill is eligible to be enabled

### Requirement: skill_list transport message
The capability SHALL broadcast a `skill_list` server message on connect and after any skill state change (enable/disable, update, merge complete). The message SHALL contain an array of all skills with fields: `id`, `name`, `description`, `version`, `enabled`, `autoUpdate`, `stale`.

#### Scenario: Skill list broadcast on connect
- **WHEN** a WebSocket client connects
- **THEN** a `skill_list` message is broadcast with all declared skills

#### Scenario: Skill list broadcast after state change
- **WHEN** a skill is disabled via config_set
- **THEN** a new `skill_list` message is broadcast reflecting the change

### Requirement: skill_list message type in transport
The `ServerMessage` union in `packages/agent-runtime` transport types SHALL include a `SkillListMessage` with `type: "skill_list"`.

#### Scenario: Message type discrimination
- **WHEN** a client receives a message with `type: "skill_list"`
- **THEN** it can be discriminated from other ServerMessage types and typed as `SkillListMessage`

