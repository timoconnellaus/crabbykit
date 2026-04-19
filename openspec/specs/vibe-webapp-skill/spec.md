# vibe-webapp-skill Specification

## Purpose
TBD - created by archiving change container-bindings-and-vibe-skill. Update Purpose after archive.
## Requirements
### Requirement: Vibe-webapp skill seed in example app
The example app SHALL include a `vibe-webapp` skill seed in `EXAMPLE_SKILL_SEEDS` with comprehensive content covering the full Bun fullstack development workflow.

#### Scenario: Skill available in registry on boot
- **WHEN** the example app starts
- **THEN** the `vibe-webapp` skill exists in the D1 skill registry via auto-seeding

### Requirement: Skill enabled by default
The example app SHALL declare `{ id: "vibe-webapp", enabled: true, autoUpdate: true }` in the skills capability configuration.

#### Scenario: Skill appears in agent prompt
- **WHEN** the agent starts inference
- **THEN** the skill "vibe-webapp" appears in the available skills list in the system prompt

### Requirement: Skill content covers project setup
The SKILL.md SHALL document the project directory structure, required files (index.html, app.tsx, server.ts, package.json, bunfig.toml), and how to create them on `/workspace/`.

#### Scenario: Agent loads skill and creates project
- **WHEN** the agent loads the vibe-webapp skill and follows the setup instructions
- **THEN** it creates a valid Bun fullstack project structure

### Requirement: Skill content covers database access
The SKILL.md SHALL document using `createDB()` from `@crabbykit/container-db` for database access, including CREATE TABLE, CRUD patterns, and parameterized queries.

#### Scenario: Agent creates app with database
- **WHEN** the agent follows the database instructions
- **THEN** it creates API routes using `db.exec()` and `db.batch()` that work in both dev and deploy

### Requirement: Skill content covers styling
The SKILL.md SHALL document CSS options including plain CSS, Tailwind via `bun-plugin-tailwind`, and the bunfig.toml plugin configuration.

#### Scenario: Agent sets up Tailwind
- **WHEN** the agent follows the Tailwind instructions
- **THEN** it installs the plugin and configures bunfig.toml correctly

### Requirement: Skill content covers deployment
The SKILL.md SHALL document the build command (`bun build --target=bun --production --outdir=dist`) and `deploy_app` tool usage with backend entry.

#### Scenario: Agent deploys app
- **WHEN** the agent follows the deployment instructions
- **THEN** it builds and deploys an app that serves frontend and API routes

### Requirement: Skill content covers common mistakes
The SKILL.md SHALL include a common mistakes section covering: not binding 0.0.0.0, using bun:sqlite instead of container-db, absolute fetch paths, missing development:true, forgetting to call start_backend after changes.

#### Scenario: Agent avoids common pitfalls
- **WHEN** the agent loads the skill before building an app
- **THEN** it avoids the documented mistakes

### Requirement: Skill description under 250 characters
The skill description SHALL be at most 250 characters and serve as a routing key for when the agent should load this skill.

#### Scenario: Description fits limit
- **WHEN** the skill is registered
- **THEN** the description is under 250 characters

