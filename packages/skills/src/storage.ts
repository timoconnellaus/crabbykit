import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { InstalledSkill, PendingMerge } from "./types.js";

const INSTALLED_PREFIX = "installed:";
const MERGE_PREFIX = "merge:";

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

export async function setPendingMerge(
  storage: CapabilityStorage,
  merge: PendingMerge,
): Promise<void> {
  await storage.put(`${MERGE_PREFIX}${merge.skillId}`, merge);
}

export async function getPendingMerges(
  storage: CapabilityStorage,
): Promise<Map<string, PendingMerge>> {
  return storage.list<PendingMerge>(MERGE_PREFIX);
}

export async function clearPendingMerge(
  storage: CapabilityStorage,
  skillId: string,
): Promise<void> {
  await storage.delete(`${MERGE_PREFIX}${skillId}`);
}
