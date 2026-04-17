/**
 * Shared tool schemas for skills.
 *
 * Used by both the static capability (capability.ts) and the capability service
 * (service.ts/client.ts) to ensure schema consistency across the bundle
 * boundary.
 */

import { Type } from "@sinclair/typebox";

// --- Skill load tool schema ---

export const SkillLoadArgsSchema = Type.Object({
  name: Type.String({ description: "The skill ID to load" }),
});

export const SKILL_LOAD_TOOL_NAME = "skill_load";
export const SKILL_LOAD_TOOL_DESCRIPTION =
  "Load a skill's instructions into context. Use when the skill's description matches your current task.";

// --- Schema content hash for drift detection ---

/**
 * Content hash of the schemas. Both service and client compare this at RPC
 * time to detect cross-version drift. Defensive consistency check, not a
 * security boundary. Bumped by hand when the args schema changes in a way
 * that would silently mistype older bundles against a newer host.
 */
export const SCHEMA_CONTENT_HASH = "skills-schemas-v1";
