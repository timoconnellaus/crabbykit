import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";

// --- Per-session elevation state ---

const SESSION_PREFIX = "session:";

function elevatedKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}:elevated`;
}

function reasonKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}:reason`;
}

function elevatedAtKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}:elevatedAt`;
}

/** Check if a specific agent session is elevated. */
export async function isSessionElevated(
  storage: CapabilityStorage,
  sessionId: string,
): Promise<boolean> {
  const val = await storage.get<boolean>(elevatedKey(sessionId));
  return val === true;
}

/** Check if ANY session is currently elevated. */
export async function isAnySessionElevated(storage: CapabilityStorage): Promise<boolean> {
  const ids = await getElevatedSessionIds(storage);
  return ids.length > 0;
}

/** Get all session IDs that are currently elevated. */
export async function getElevatedSessionIds(storage: CapabilityStorage): Promise<string[]> {
  const all = await storage.list<boolean>(SESSION_PREFIX);
  const ids: string[] = [];
  for (const [key, value] of all) {
    // Keys are like "session:{id}:elevated" (prefix already stripped by storage.list)
    // But storage.list strips the capability prefix, not our SESSION_PREFIX.
    // We passed SESSION_PREFIX to list(), so keys still have the full suffix.
    if (key.endsWith(":elevated") && value === true) {
      // Extract sessionId from "session:{id}:elevated"
      const id = key.slice(SESSION_PREFIX.length, -":elevated".length);
      ids.push(id);
    }
  }
  return ids;
}

/** Set elevation state for a session. */
export async function setSessionElevated(
  storage: CapabilityStorage,
  sessionId: string,
  reason: string,
): Promise<void> {
  await storage.put(elevatedKey(sessionId), true);
  await storage.put(reasonKey(sessionId), reason);
  await storage.put(elevatedAtKey(sessionId), new Date().toISOString());
}

/** Clear elevation state for a single session. */
export async function clearSessionElevation(
  storage: CapabilityStorage,
  sessionId: string,
): Promise<void> {
  await storage.delete(elevatedKey(sessionId));
  await storage.delete(reasonKey(sessionId));
  await storage.delete(elevatedAtKey(sessionId));
}

/** Clear ALL session elevation states. */
export async function clearAllElevation(storage: CapabilityStorage): Promise<void> {
  const all = await storage.list(SESSION_PREFIX);
  for (const [key] of all) {
    await storage.delete(key);
  }
}

/** Get the elevation reason for a session. */
export async function getSessionReason(
  storage: CapabilityStorage,
  sessionId: string,
): Promise<string | undefined> {
  return storage.get<string>(reasonKey(sessionId));
}

// --- Process ownership ---

const PROC_PREFIX = "proc:";

function procOwnerKey(containerSessionId: string): string {
  return `${PROC_PREFIX}${containerSessionId}`;
}

/** Record which agent session owns a container process session. */
export async function setProcessOwner(
  storage: CapabilityStorage,
  containerSessionId: string,
  agentSessionId: string,
): Promise<void> {
  await storage.put(procOwnerKey(containerSessionId), agentSessionId);
}

/** Get the agent session that owns a container process session. */
export async function getProcessOwner(
  storage: CapabilityStorage,
  containerSessionId: string,
): Promise<string | undefined> {
  return storage.get<string>(procOwnerKey(containerSessionId));
}

/** Remove a process ownership record. */
export async function removeProcessOwner(
  storage: CapabilityStorage,
  containerSessionId: string,
): Promise<void> {
  await storage.delete(procOwnerKey(containerSessionId));
}

/** Get all container session IDs owned by a given agent session. */
export async function getOwnedProcessIds(
  storage: CapabilityStorage,
  agentSessionId: string,
): Promise<string[]> {
  const all = await storage.list<string>(PROC_PREFIX);
  const ids: string[] = [];
  for (const [key, owner] of all) {
    if (owner === agentSessionId) {
      // Key is "proc:{containerSessionId}" — extract the container session ID
      ids.push(key.slice(PROC_PREFIX.length));
    }
  }
  return ids;
}

/** Clear all process ownership records. */
export async function clearAllProcessOwners(storage: CapabilityStorage): Promise<void> {
  const all = await storage.list(PROC_PREFIX);
  for (const [key] of all) {
    await storage.delete(key);
  }
}
