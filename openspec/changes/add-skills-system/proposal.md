## Why

CLAW agents need a way to receive and apply procedural knowledge — "how to do X" instructions — that can be loaded on demand, updated independently of the SDK, and customized by users. Today, capabilities provide tools and hooks but have no mechanism for distributing domain-specific instructions that guide agent behavior. Skills fill this gap: they are markdown documents the agent loads into context when relevant, giving it task-specific guidance without bloating the system prompt.

## What Changes

- New `packages/skill-registry` package: D1-backed registry implementing a `SkillRegistry` interface. Stores skill metadata (name, description, version, content hash, required capabilities) and SKILL.md content. Consumers mount this in their worker with a D1 binding.
- New `packages/skills` capability package: Manages the skill lifecycle within an AgentDO. Syncs skill index from the registry into DO state on connect, writes enabled skills to R2, provides a `skill_load` tool that reads SKILL.md from R2 and returns it as tool content, injects the installed skill list (name + description, max 250 chars) into promptSections.
- Skills have enabled/disabled states — disabled skills exist in DO state but not in R2. Toggled via config tools or UI.
- Skills auto-update on agent loop start: if a newer registry version exists and the user hasn't modified the local copy (hash check), overwrite. If modified and `autoUpdate` is on, queue a merge message for the agent. If off, mark stale.
- New `skill_list` transport message type for UI rendering.
- New SkillPanel UI component in `agent-ui` showing skill list with enable/disable toggles, auto-update toggles, and view mode (read-only).

## Capabilities

### New Capabilities
- `skill-registry`: D1-backed skill storage and version lookup. Provides the `SkillRegistry` interface that other registry implementations can follow.
- `skills`: Agent capability that manages skill lifecycle, prompt injection, and the `skill_load` tool. Depends on R2 storage for persisting enabled skills.

### Modified Capabilities
- None. The skills system is additive — no existing capability requirements change.

## Impact

- **New packages**: `packages/skill-registry`, `packages/skills`
- **Transport**: New `skill_list` server message type in `packages/agent-runtime` transport types
- **UI**: New SkillPanel component in `packages/agent-ui`
- **Consumer config**: Consumers add a D1 binding (`SKILL_DB`) and pass it to the skills capability alongside their existing R2 storage
- **Dependencies**: skills capability depends on r2-storage's `AgentStorage` abstraction for R2 access
