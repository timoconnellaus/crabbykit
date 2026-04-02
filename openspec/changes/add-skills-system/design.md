## Context

CLAW agents currently have capabilities (tools, hooks, prompt sections) but no mechanism for on-demand procedural knowledge. Capabilities are always-present infrastructure; skills are task-specific instructions loaded into context when relevant.

The skills system has two halves: a **registry** (D1, lives in the worker) that stores skill content and metadata, and a **capability** (lives in the DO) that manages the skill lifecycle, syncs state, and provides the `skill_load` tool.

Skills are declared at build time in `getCapabilities()`, similar to how other capabilities are configured today. The consumer specifies which skills their agent has access to, and the framework handles sync, updates, and prompt injection.

## Goals / Non-Goals

**Goals:**
- Skills can be loaded on demand by the agent via a `skill_load` tool
- Skill index (names + descriptions) injected into system prompt from DO state — no R2 reads on every inference
- Skills stored in R2 when enabled, so the agent can read and modify them
- Auto-update from registry with hash-based conflict detection
- Agent-assisted merge when user has customized a skill and an update arrives
- Enable/disable and auto-update configurable via existing config tools
- UI panel for viewing skill state
- `SkillRegistry` interface allows alternative registry implementations

**Non-Goals:**
- Runtime skill installation by the agent (v2 — requires browse UI and capability compatibility checks at install time)
- Skill marketplace or discovery
- User editing skills from the UI (view only)
- R2 event notifications for sync (write-through is sufficient since all mutations go through tools)
- Skill dependencies on other skills (keep it flat for now)

## Decisions

### 1. Two packages: `skill-registry` and `skills`

The registry is a standalone D1 abstraction — no dependency on the runtime. The skills capability depends on the registry interface and on `AgentStorage` for R2 access. This matches the existing pattern where `agent-registry` is separate from `agent-fleet`.

Alternative: single package with both. Rejected because the registry might be used independently (e.g., a management API that updates skills without touching DOs).

### 2. Build-time skill declaration, not runtime install

Skills are declared in `getCapabilities()` by ID. The capability resolves them from the registry on first connect. This matches how every other capability in the SDK works — configured in code, state managed at runtime.

Alternative: runtime install via agent tool. Deferred — requires capability compatibility checks and a browse/search UI that doesn't exist yet.

### 2b. Registry is self-seeding from a skill definitions array

The `D1SkillRegistry` accepts an optional `seeds` array at construction. On first operation (alongside `ensureTable`), it idempotently upserts all seed skills — inserting new ones and updating existing ones whose content has changed (detected by hash comparison). This means the consumer declares their skill catalog in code and the registry stays in sync on every boot without a separate migration or seed script.

Alternative: separate seed script or D1 migration. Rejected — adds a deployment step that's easy to forget, and the catalog is code-level knowledge that belongs alongside the registry construction.

### 3. Write-through index sync, not R2 event notifications

When the skills capability writes/deletes a SKILL.md in R2, it also updates the DO state index in the same operation. No Queue infrastructure needed.

Alternative: R2 → Queue → Worker → DO event flow. Rejected for now — adds infrastructure complexity for a problem that doesn't exist (all R2 mutations go through the capability's own tools).

### 4. Hash-based update conflict detection

Each skill record stores `originalHash` — the SHA-256 of the SKILL.md content as it was when installed or last updated from registry. On sync, read the current R2 content and hash it. If it matches `originalHash`, the user hasn't modified it and we can safely overwrite. If different, the user has customized it.

Alternative: timestamp-based or version-based detection. Rejected — hashes are content-addressed and immune to clock skew or race conditions.

### 5. Agent-assisted merge via beforeInference hook

When auto-update is enabled and a conflict is detected, the new version is stored in DO state as a pending merge. The `beforeInference` hook injects a hidden system message with both versions, instructing the agent to merge them using the existing `file_write` tool (from r2-storage). After the agent writes the merged version, the `afterToolExecution` hook detects the write and clears the pending merge.

Alternative: dedicated merge tool. Rejected — the agent already has `file_write` and the merge instruction is just a prompt. No new tool needed.

### 6. Config integration via configNamespaces

Skills expose a config namespace so the agent or user can toggle enabled/autoUpdate per skill via the existing `config_get`/`config_set` tools. The `onConfigChange` hook handles state transitions (enable → write to R2, disable → delete from R2).

### 7. New `skill_list` transport message

A new discriminated union member on `ServerMessage`, broadcast on connect and after any skill state change. This is consistent with how `schedule_list` and `command_list` work.

### 8. Skill sync happens in onConnect hook

The `onConnect` hook is async and already used by other capabilities (A2A) for lazy initialization. Skills capability uses it to: check registry for version updates, apply non-conflicting updates, queue merge messages for conflicts, and update DO state. First connect does the full sync; subsequent connects just check versions.

Alternative: sync in `promptSections()`. Not possible — it's synchronous. Alternative: sync in `beforeInference`. Possible but would add latency to every inference. `onConnect` runs once per connection, which is the right frequency.

## Risks / Trade-offs

**Registry unavailability during sync** → Skills capability should gracefully degrade. If the registry fetch fails, use cached DO state. Log a warning. Skills that were previously synced continue to work. New installs or updates are deferred.

**First-connect latency** → The initial sync fetches all declared skills from D1 and writes them to R2. For agents with many skills this could be slow. Mitigation: batch D1 reads, parallelize R2 writes. In practice, agents will have 5-20 skills.

**Large skill content in merge messages** → A merge message includes both old and new SKILL.md content in a hidden system message. For large skills (up to 500 lines per TanStack Intent's convention), this could be 1000+ lines in context. Mitigation: cap skill size at a reasonable limit (enforced by registry), and the merge instruction tells the agent to load the current version via `skill_load` rather than embedding the full current content.

**Capability dependency validation at build time** → The proposal says skills can require capabilities. But at build time (in `getCapabilities()`), we don't have a clean way to cross-reference — capabilities are being declared in the same call. Decision: defer capability dependency validation to `onConnect`, where all capabilities have been resolved. If a skill requires a capability that isn't present, log a warning and keep the skill disabled.

## Open Questions

- Should the registry support skill categories/tags for future discoverability?
- What's the maximum skill content size? 500 lines (matching TanStack Intent) seems reasonable.
- Should we support skill "channels" (stable/beta) for update tracking?
