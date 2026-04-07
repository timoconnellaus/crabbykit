import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { InstalledSkill, SkillConflict } from "./types.js";

const INSTALLED_PREFIX = "installed:";
const CONFLICT_PREFIX = "conflict:";

export async function getInstalledSkill(
  storage: CapabilityStorage,
  id: string,
): Promise<InstalledSkill | undefined> {
  return storage.get<InstalledSkill>(`${INSTALLED_PREFIX}${id}`);
}

export async function putInstalledSkill(
  storage: CapabilityStorage,
  id: string,
  record: InstalledSkill,
): Promise<void> {
  await storage.put(`${INSTALLED_PREFIX}${id}`, record);
}

export async function listInstalledSkills(
  storage: CapabilityStorage,
): Promise<Map<string, InstalledSkill>> {
  return storage.list<InstalledSkill>(INSTALLED_PREFIX);
}

export async function deleteInstalledSkill(
  storage: CapabilityStorage,
  id: string,
): Promise<void> {
  await storage.delete(`${INSTALLED_PREFIX}${id}`);
}

export async function setSkillConflict(
  storage: CapabilityStorage,
  conflict: SkillConflict,
): Promise<void> {
  await storage.put(`${CONFLICT_PREFIX}${conflict.skillId}`, conflict);
}

export async function getSkillConflicts(
  storage: CapabilityStorage,
): Promise<Map<string, SkillConflict>> {
  return storage.list<SkillConflict>(CONFLICT_PREFIX);
}

export async function clearSkillConflict(
  storage: CapabilityStorage,
  skillId: string,
): Promise<void> {
  await storage.delete(`${CONFLICT_PREFIX}${skillId}`);
}
