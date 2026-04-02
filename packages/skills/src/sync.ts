import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { SkillRegistry } from "@claw-for-cloudflare/skill-registry";
import { deleteSkillFromR2, hashSkillContent, readSkillFromR2, writeSkillToR2 } from "./r2.js";
import {
  getInstalledSkill,
  listInstalledSkills,
  putInstalledSkill,
  setPendingMerge,
} from "./storage.js";
import type { InstalledSkill, SkillDeclaration } from "./types.js";

export interface SyncContext {
  storage: CapabilityStorage;
  registry: SkillRegistry;
  bucket: R2Bucket;
  namespace: string;
  declarations: SkillDeclaration[];
  /** IDs of capabilities registered on this agent. Used for dependency validation. */
  capabilityIds: string[];
}

export async function syncSkills(ctx: SyncContext): Promise<void> {
  const existingSkills = await listInstalledSkills(ctx.storage);

  for (const decl of ctx.declarations) {
    try {
      await syncSingleSkill(ctx, decl, existingSkills.has(`installed:${decl.id}`));
    } catch (err) {
      // Registry failure is non-fatal — log and continue with cached state
      console.warn(
        `[skills] Failed to sync skill "${decl.id}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function syncSingleSkill(
  ctx: SyncContext,
  decl: SkillDeclaration,
  existsInState: boolean,
): Promise<void> {
  const enabled = decl.enabled ?? true;
  const autoUpdate = decl.autoUpdate ?? true;

  // Fetch from registry
  const registryRecord = await ctx.registry.get(decl.id);
  if (!registryRecord) {
    console.warn(`[skills] Skill "${decl.id}" not found in registry`);
    return;
  }

  // Capability dependency validation
  const missingCaps = registryRecord.requiresCapabilities.filter(
    (cap) => !ctx.capabilityIds.includes(cap),
  );
  if (missingCaps.length > 0) {
    console.warn(
      `[skills] Skill "${decl.id}" requires capabilities not registered: ${missingCaps.join(", ")}. Keeping disabled.`,
    );
    // Store as disabled regardless of declaration
    await putInstalledSkill(ctx.storage, decl.id, {
      name: registryRecord.name,
      description: registryRecord.description,
      version: registryRecord.version,
      enabled: false,
      autoUpdate,
      stale: false,
      originalHash: registryRecord.contentHash,
      requiresCapabilities: registryRecord.requiresCapabilities,
    });
    return;
  }

  if (!existsInState) {
    // First install
    const installed: InstalledSkill = {
      name: registryRecord.name,
      description: registryRecord.description,
      version: registryRecord.version,
      enabled,
      autoUpdate,
      stale: false,
      originalHash: registryRecord.contentHash,
      requiresCapabilities: registryRecord.requiresCapabilities,
    };

    if (enabled) {
      await writeSkillToR2(ctx.bucket, ctx.namespace, decl.id, registryRecord.skillMd);
      installed.r2Key = `skills/${decl.id}/SKILL.md`;
    }

    await putInstalledSkill(ctx.storage, decl.id, installed);
    return;
  }

  // Existing skill — check for updates
  const existing = await getInstalledSkill(ctx.storage, decl.id);
  if (!existing) return;

  if (existing.version === registryRecord.version) {
    // No update available — just sync declaration changes (enabled/autoUpdate)
    if (existing.enabled !== enabled || existing.autoUpdate !== autoUpdate) {
      const updated = { ...existing, enabled, autoUpdate };
      if (enabled && !existing.enabled) {
        // Enabling: write to R2
        await writeSkillToR2(ctx.bucket, ctx.namespace, decl.id, registryRecord.skillMd);
        updated.r2Key = `skills/${decl.id}/SKILL.md`;
      } else if (!enabled && existing.enabled) {
        // Disabling: delete from R2
        await deleteSkillFromR2(ctx.bucket, ctx.namespace, decl.id);
        updated.r2Key = undefined;
      }
      await putInstalledSkill(ctx.storage, decl.id, updated);
    }
    return;
  }

  // Newer version in registry
  if (!existing.enabled) {
    // Disabled skill — just update metadata
    await putInstalledSkill(ctx.storage, decl.id, {
      ...existing,
      name: registryRecord.name,
      description: registryRecord.description,
      version: registryRecord.version,
      originalHash: registryRecord.contentHash,
      stale: false,
    });
    return;
  }

  // Enabled skill with update — check if user modified
  const currentContent = await readSkillFromR2(ctx.bucket, ctx.namespace, decl.id);
  if (!currentContent) {
    // R2 content missing — reinstall
    await writeSkillToR2(ctx.bucket, ctx.namespace, decl.id, registryRecord.skillMd);
    await putInstalledSkill(ctx.storage, decl.id, {
      ...existing,
      name: registryRecord.name,
      description: registryRecord.description,
      version: registryRecord.version,
      originalHash: registryRecord.contentHash,
      r2Key: `skills/${decl.id}/SKILL.md`,
      stale: false,
    });
    return;
  }

  const currentHash = await hashSkillContent(currentContent);

  if (currentHash === existing.originalHash) {
    // User hasn't modified — safe to overwrite
    await writeSkillToR2(ctx.bucket, ctx.namespace, decl.id, registryRecord.skillMd);
    await putInstalledSkill(ctx.storage, decl.id, {
      ...existing,
      name: registryRecord.name,
      description: registryRecord.description,
      version: registryRecord.version,
      originalHash: registryRecord.contentHash,
      r2Key: `skills/${decl.id}/SKILL.md`,
      stale: false,
    });
  } else if (autoUpdate) {
    // User modified + autoUpdate on — queue merge
    await setPendingMerge(ctx.storage, {
      skillId: decl.id,
      newContent: registryRecord.skillMd,
      newVersion: registryRecord.version,
      newHash: registryRecord.contentHash,
    });
    await putInstalledSkill(ctx.storage, decl.id, {
      ...existing,
      stale: true,
    });
  } else {
    // User modified + autoUpdate off — mark stale
    await putInstalledSkill(ctx.storage, decl.id, {
      ...existing,
      stale: true,
    });
  }
}
