## ADDED Requirements

### Requirement: InstalledSkill data model
The system SHALL store installed skill metadata in DO KV with the `installed:` prefix using the `InstalledSkill` type.

#### Scenario: Registry-origin skill stored
- **WHEN** a skill is installed from the registry
- **THEN** the DO KV entry contains: `name`, `description`, `enabled`, `origin: "registry"`, `registryVersion`, `registryHash`, `dirty: false`, `requiresCapabilities`

#### Scenario: Agent-origin skill stored
- **WHEN** a skill is created by the agent
- **THEN** the DO KV entry contains: `name`, `description`, `enabled: true`, `origin: "agent"`, `requiresCapabilities: []`

### Requirement: SkillConflict data model
The system SHALL store skill conflicts in DO KV with the `conflict:` prefix using the `SkillConflict` type.

#### Scenario: Conflict record structure
- **WHEN** a conflict is detected during sync
- **THEN** the DO KV entry at `conflict:{id}` contains: `skillId`, `upstreamContent`, `upstreamVersion`, `upstreamHash`

### Requirement: R2 content storage
The system SHALL store skill content in R2 at deterministic paths derived from the skill ID.

#### Scenario: R2 key derivation
- **WHEN** a skill with ID `foo` is stored for an agent with namespace `ns`
- **THEN** the R2 key is `{ns}/skills/foo/SKILL.md`

#### Scenario: Only enabled skills have R2 content
- **WHEN** a skill is disabled
- **THEN** no R2 object exists for that skill (deleted on disable)

### Requirement: Frontmatter parsing on write
The system SHALL parse YAML frontmatter from SKILL.md content to extract metadata.

#### Scenario: Valid frontmatter parsed
- **WHEN** a SKILL.md contains `---\nname: Foo\ndescription: Bar\n---\n# Content`
- **THEN** the system extracts `name: "Foo"` and `description: "Bar"`

#### Scenario: Missing or invalid frontmatter
- **WHEN** a SKILL.md has no frontmatter or malformed YAML
- **THEN** the system uses the skill ID as the name and an empty string as the description, and logs a warning

### Requirement: Built-in determination at runtime
The system SHALL determine whether a skill is "built-in" (cannot be uninstalled) by checking if its ID exists in the current declarations array, not by reading a stored flag.

#### Scenario: Uninstall of a declared skill blocked
- **WHEN** a user attempts to uninstall a skill whose ID is in the declarations array
- **THEN** the system returns an error indicating the skill cannot be uninstalled

#### Scenario: Uninstall of a user-installed skill allowed
- **WHEN** a user attempts to uninstall a skill whose ID is NOT in the declarations array
- **THEN** the system removes the DO KV entry and R2 content

### Requirement: Prompt sections from cached metadata
The system SHALL generate prompt sections listing available skills from the in-memory cache without reading R2.

#### Scenario: Enabled skills appear in prompt
- **WHEN** `promptSections()` is called and the cache contains enabled skills
- **THEN** the system returns a section listing each enabled skill's ID and description

#### Scenario: Disabled and conflicted skills shown in prompt
- **WHEN** a skill is enabled but has a pending conflict
- **THEN** it still appears in the prompt menu (the current R2 content is still functional)
