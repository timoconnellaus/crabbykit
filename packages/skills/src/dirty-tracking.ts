import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { parseFrontmatter } from "./parse-frontmatter.js";
import { hashSkillContent, readSkillFromR2, skillIdFromR2Path } from "./r2.js";
import {
  clearSkillConflict,
  deleteInstalledSkill,
  getInstalledSkill,
  getSkillConflicts,
  listInstalledSkills,
  putInstalledSkill,
} from "./storage.js";
import type { InstalledSkill, SkillDeclaration, SkillsOptions } from "./types.js";

/** Event passed to afterToolExecution hooks after a tool finishes. */
interface ToolExecutionEvent {
  toolName: string;
  args: unknown;
  isError: boolean;
}

/** Context provided to capability lifecycle hooks. */
interface HookContext {
  agentId: string;
  sessionId: string;
  storage: CapabilityStorage;
}

/** Tools that mutate R2 skill files. */
const MUTATION_TOOLS = new Set(["file_write", "file_edit", "file_delete"]);

/**
 * Create the afterToolExecution hook for dirty tracking.
 *
 * Watches file_write, file_edit, file_delete on `skills/{id}/SKILL.md` paths:
 * - Registry-origin write: Hash content, set dirty if differs from registryHash
 * - Agent-origin write: Parse frontmatter, update metadata
 * - New skill creation: Parse frontmatter, create DO KV entry with origin="agent"
 * - Conflict resolution: If skill has pending conflict, clear conflict, update registryVersion/registryHash
 * - Registry-origin delete: Set enabled=false
 * - Agent-origin delete: Delete DO KV entry entirely
 */
export function createAfterToolExecutionHook(
  agentStorage: SkillsOptions["storage"],
  declarations: SkillDeclaration[],
  getCache: () => Map<string, InstalledSkill> | null,
  setCache: (cache: Map<string, InstalledSkill>) => void,
): (event: ToolExecutionEvent, ctx: HookContext) => Promise<void> {
  const declarationIds = new Set(declarations.map((d) => d.id));

  return async (event: ToolExecutionEvent, ctx: HookContext): Promise<void> => {
    if (!MUTATION_TOOLS.has(event.toolName)) return;

    const args = event.args as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!path) return;

    const skillId = skillIdFromR2Path(path);
    if (!skillId) return;

    const bucket = agentStorage.bucket();
    const namespace = agentStorage.namespace();

    if (event.toolName === "file_delete") {
      await handleDelete(ctx.storage, skillId);
    } else {
      // file_write or file_edit
      await handleWrite(ctx.storage, skillId, bucket, namespace, declarationIds);
    }

    // Refresh cache
    const updated = await listInstalledSkills(ctx.storage);
    setCache(updated);
  };
}

async function handleWrite(
  storage: CapabilityStorage,
  skillId: string,
  bucket: R2Bucket,
  namespace: string,
  declarationIds: Set<string>,
): Promise<void> {
  const content = await readSkillFromR2(bucket, namespace, skillId);
  if (!content) return;

  const existing = await getInstalledSkill(storage, skillId);

  if (!existing) {
    // New skill creation by agent
    const fm = parseFrontmatter(content);
    const installed: InstalledSkill = {
      name: fm.name ?? skillId,
      description: fm.description ?? "",
      enabled: true,
      origin: "agent",
      requiresCapabilities: fm.requiresCapabilities ?? [],
    };
    await putInstalledSkill(storage, skillId, installed);
    return;
  }

  // Check for conflict resolution
  const conflicts = await getSkillConflicts(storage);
  const conflictKey = `conflict:${skillId}`;
  const conflict = conflicts.get(conflictKey);
  if (conflict) {
    // Conflict resolved — clear conflict and update version/hash
    await clearSkillConflict(storage, skillId);
    await putInstalledSkill(storage, skillId, {
      ...existing,
      registryVersion: conflict.upstreamVersion,
      registryHash: conflict.upstreamHash,
      dirty: false,
    });
    return;
  }

  if (existing.origin === "registry") {
    // Registry-origin write — check if content differs from registry
    const currentHash = await hashSkillContent(content);
    const isDirty = currentHash !== existing.registryHash;
    if (isDirty !== existing.dirty) {
      await putInstalledSkill(storage, skillId, {
        ...existing,
        dirty: isDirty,
      });
    }
    // Also update metadata from frontmatter
    const fm = parseFrontmatter(content);
    if (fm.name || fm.description) {
      const updated = await getInstalledSkill(storage, skillId);
      if (updated) {
        await putInstalledSkill(storage, skillId, {
          ...updated,
          name: fm.name ?? updated.name,
          description: fm.description ?? updated.description,
        });
      }
    }
  } else {
    // Agent-origin write — update metadata from frontmatter
    const fm = parseFrontmatter(content);
    await putInstalledSkill(storage, skillId, {
      ...existing,
      name: fm.name ?? existing.name,
      description: fm.description ?? existing.description,
      requiresCapabilities: fm.requiresCapabilities ?? existing.requiresCapabilities,
    });
  }
}

async function handleDelete(
  storage: CapabilityStorage,
  skillId: string,
): Promise<void> {
  const existing = await getInstalledSkill(storage, skillId);
  if (!existing) return;

  if (existing.origin === "registry") {
    // Registry-origin delete — disable, don't remove
    await putInstalledSkill(storage, skillId, {
      ...existing,
      enabled: false,
    });
  } else {
    // Agent-origin delete — remove entirely
    await deleteInstalledSkill(storage, skillId);
  }
}
