## ADDED Requirements

### Requirement: Skills as workspace files
Skill definitions SHALL be authored as SKILL.md files in a `skills/` workspace folder, organized as `skills/{id}/SKILL.md`.

#### Scenario: Skill file structure
- **WHEN** a developer creates a skill with ID `vibe-webapp`
- **THEN** the file is located at `skills/vibe-webapp/SKILL.md` with YAML frontmatter containing at minimum `name`, `description`, `version`, and optionally `requires` (capability IDs)

### Requirement: Frontmatter-to-seed parsing
The `skill-registry` package SHALL export a `parseSkillFile(id: string, content: string): SkillSeed` function that extracts metadata from SKILL.md frontmatter.

#### Scenario: Complete frontmatter parsed
- **WHEN** a SKILL.md contains `---\nname: Vibe Webapp\ndescription: Build web apps\nversion: 1.4.0\nrequires: [vibe-coder, sandbox]\n---\n# Content`
- **THEN** `parseSkillFile` returns `{ id, name: "Vibe Webapp", description: "Build web apps", version: "1.4.0", requiresCapabilities: ["vibe-coder", "sandbox"], skillMd: <full content> }`

#### Scenario: Missing requires field defaults to empty
- **WHEN** a SKILL.md frontmatter does not include a `requires` field
- **THEN** `parseSkillFile` returns `requiresCapabilities: []`

#### Scenario: Missing required fields
- **WHEN** a SKILL.md frontmatter is missing `name`, `description`, or `version`
- **THEN** `parseSkillFile` throws an error identifying the missing field(s)

### Requirement: D1 registry seeding from parsed files
The `D1SkillRegistry` SHALL accept parsed `SkillSeed[]` from workspace files, replacing inline seed construction in consumer code.

#### Scenario: Seeds applied idempotently
- **WHEN** the registry is initialized with seeds whose content has not changed since last run
- **THEN** no D1 writes occur (hash comparison skips unchanged seeds)

#### Scenario: Seed content updated
- **WHEN** a seed's `skillMd` content has changed (different hash)
- **THEN** the registry upserts the record with the new content, hash, and version

#### Scenario: Seed version-only update
- **WHEN** a seed's content hash is unchanged but the version differs
- **THEN** the registry updates only the version and metadata fields, not the content
