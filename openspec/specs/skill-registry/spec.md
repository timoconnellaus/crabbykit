# skill-registry Specification

## Purpose
TBD - created by archiving change add-skills-system. Update Purpose after archive.
## Requirements
### Requirement: SkillRegistry interface
The system SHALL define a `SkillRegistry` interface with methods: `list()`, `get(id)`, `getVersion(id)`, `upsert(skill)`, and `delete(id)`. All methods SHALL return Promises. The interface SHALL be exported from the package for alternative implementations.

#### Scenario: Interface is implementation-agnostic
- **WHEN** a consumer imports `SkillRegistry` from the package
- **THEN** they can implement it with any backing store (D1, HTTP, static)

### Requirement: D1SkillRegistry implementation
The system SHALL provide a `D1SkillRegistry` class implementing `SkillRegistry` backed by a Cloudflare D1 database. The class SHALL accept a `D1Database` binding in its constructor.

#### Scenario: Construction with D1 binding
- **WHEN** a consumer creates `new D1SkillRegistry(env.SKILL_DB)`
- **THEN** the instance is ready to use with auto-creating tables on first operation

### Requirement: Auto-create schema
The `D1SkillRegistry` SHALL auto-create the `skills` table on first operation if it does not exist, using `CREATE TABLE IF NOT EXISTS`. The table SHALL have columns: `id` (TEXT PRIMARY KEY), `name` (TEXT NOT NULL), `description` (TEXT NOT NULL), `version` (TEXT NOT NULL), `content_hash` (TEXT NOT NULL), `requires_capabilities` (TEXT, JSON array), `skill_md` (TEXT NOT NULL), `created_at` (TEXT NOT NULL), `updated_at` (TEXT NOT NULL).

#### Scenario: First operation on empty database
- **WHEN** `list()` is called on a new D1SkillRegistry with no existing table
- **THEN** the table is created and an empty array is returned

#### Scenario: Subsequent operations reuse existing table
- **WHEN** any method is called after the table has been created
- **THEN** the table creation is skipped (idempotent)

### Requirement: list returns all skills
The `list()` method SHALL return all skill records from the registry as an array of `SkillRecord` objects.

#### Scenario: List with multiple skills
- **WHEN** the registry contains 3 skills
- **THEN** `list()` returns an array of 3 `SkillRecord` objects with all fields populated

#### Scenario: List on empty registry
- **WHEN** the registry contains no skills
- **THEN** `list()` returns an empty array

### Requirement: get returns a single skill
The `get(id)` method SHALL return the full `SkillRecord` for the given ID, or `null` if not found. The record SHALL include the `skillMd` content.

#### Scenario: Get existing skill
- **WHEN** `get("code-review")` is called and the skill exists
- **THEN** it returns the full `SkillRecord` including `skillMd` content

#### Scenario: Get non-existent skill
- **WHEN** `get("nonexistent")` is called
- **THEN** it returns `null`

### Requirement: getVersion returns version and hash only
The `getVersion(id)` method SHALL return `{ version, contentHash }` for the given skill ID, or `null` if not found. This is a lightweight check for update detection without fetching full content.

#### Scenario: Version check for existing skill
- **WHEN** `getVersion("code-review")` is called
- **THEN** it returns `{ version: "1.0.0", contentHash: "sha256..." }` without the skill content

#### Scenario: Version check for missing skill
- **WHEN** `getVersion("missing")` is called
- **THEN** it returns `null`

### Requirement: upsert creates or updates a skill
The `upsert(skill)` method SHALL insert a new skill or update an existing one (matched by `id`). It SHALL set `created_at` on insert and update `updated_at` on both insert and update. The `content_hash` SHALL be computed from the `skillMd` content using SHA-256.

#### Scenario: Insert new skill
- **WHEN** `upsert()` is called with a skill ID that doesn't exist
- **THEN** a new row is created with `created_at` and `updated_at` set to now

#### Scenario: Update existing skill
- **WHEN** `upsert()` is called with an existing skill ID and new content
- **THEN** the row is updated, `updated_at` changes, `created_at` is preserved

### Requirement: delete removes a skill
The `delete(id)` method SHALL remove the skill from the registry. It SHALL return `true` if a row was deleted, `false` if the skill didn't exist.

#### Scenario: Delete existing skill
- **WHEN** `delete("code-review")` is called and the skill exists
- **THEN** it returns `true` and the skill is removed

#### Scenario: Delete non-existent skill
- **WHEN** `delete("nonexistent")` is called
- **THEN** it returns `false`

### Requirement: SkillRecord type
The `SkillRecord` type SHALL have fields: `id` (string), `name` (string), `description` (string, max 250 characters), `version` (string), `contentHash` (string), `requiresCapabilities` (string array), `skillMd` (string), `createdAt` (string), `updatedAt` (string).

#### Scenario: Description length enforcement
- **WHEN** `upsert()` is called with a description longer than 250 characters
- **THEN** the operation SHALL throw an error

### Requirement: content_hash is SHA-256 of skill_md
The `contentHash` field SHALL be the hex-encoded SHA-256 digest of the `skillMd` content. This SHALL be computed by the registry on upsert, not provided by the caller.

#### Scenario: Hash consistency
- **WHEN** the same `skillMd` content is upserted twice
- **THEN** the `contentHash` is identical both times

