import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { SkillRegistry } from "@claw-for-cloudflare/skill-registry";
import { writeSkillToR2 } from "./r2.js";
import {
  getInstalledSkill,
  listInstalledSkills,
  putInstalledSkill,
  setSkillConflict,
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
      const existsInState = existingSkills.has(`installed:${decl.id}`);
      await syncSingleSkill(ctx, decl, existsInState);
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
      enabled: false,
      origin: "registry",
      registryVersion: registryRecord.version,
      registryHash: registryRecord.contentHash,
      requiresCapabilities: registryRecord.requiresCapabilities,
    });
    return;
  }

  if (!existsInState) {
    // Scenario 1: New skill — fetch from registry, write to R2, create DO KV entry
    const installed: InstalledSkill = {
      name: registryRecord.name,
      description: registryRecord.description,
      enabled,
      origin: "registry",
      registryVersion: registryRecord.version,
      registryHash: registryRecord.contentHash,
      requiresCapabilities: registryRecord.requiresCapabilities,
    };

    if (enabled) {
      await writeSkillToR2(ctx.bucket, ctx.namespace, decl.id, registryRecord.skillMd);
    }

    await putInstalledSkill(ctx.storage, decl.id, installed);
    return;
  }

  // Existing skill — check for updates
  const existing = await getInstalledSkill(ctx.storage, decl.id);
  if (!existing) return;

  // Only registry-origin skills can be updated from the registry
  if (existing.origin !== "registry") return;

  if (existing.registryVersion === registryRecord.version) {
    // No update available — just sync enabled state from declaration
    if (existing.enabled !== enabled) {
      await putInstalledSkill(ctx.storage, decl.id, {
        ...existing,
        enabled,
      });
      if (enabled) {
        await writeSkillToR2(ctx.bucket, ctx.namespace, decl.id, registryRecord.skillMd);
      }
    }
    return;
  }

  // Newer version available
  if (existing.dirty) {
    // Scenario 3: Update-dirty — create conflict, don't touch R2
    await setSkillConflict(ctx.storage, {
      skillId: decl.id,
      upstreamContent: registryRecord.skillMd,
      upstreamVersion: registryRecord.version,
      upstreamHash: registryRecord.contentHash,
    });
  } else {
    // Scenario 2: Update-clean — overwrite R2, update DO KV
    if (enabled) {
      await writeSkillToR2(ctx.bucket, ctx.namespace, decl.id, registryRecord.skillMd);
    }
    await putInstalledSkill(ctx.storage, decl.id, {
      ...existing,
      name: registryRecord.name,
      description: registryRecord.description,
      registryVersion: registryRecord.version,
      registryHash: registryRecord.contentHash,
      enabled,
    });
  }
}
