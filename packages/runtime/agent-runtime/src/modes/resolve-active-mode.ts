import type { SessionStore } from "../session/session-store.js";
import type { SessionEntry } from "../session/types.js";
import type { Mode } from "./define-mode.js";

/**
 * Walk a session's entry chain from leaf toward root and return the
 * mode corresponding to the most recent `mode_change` entry, or `null`
 * when the most recent change is an exit (or when no mode_change
 * entries exist).
 *
 * This helper is **not** on the hot `ensureAgent` path — the runtime
 * reads the cached `activeModeId` from session metadata directly
 * (O(1)). `resolveActiveMode` is called only at:
 *   1. Branch initialization (seed the new branch's cache from the
 *      parent chain).
 *   2. Consistency fallback when the cache field is missing
 *      (pre-feature data or corruption).
 */
export function resolveActiveMode(
  sessionStore: SessionStore,
  sessionId: string,
  modes: Mode[],
): Mode | null {
  const session = sessionStore.get(sessionId);
  if (!session?.leafId) return null;

  const entries = sessionStore.getEntries(sessionId);
  if (entries.length === 0) return null;

  const entryMap = new Map<string, SessionEntry>();
  for (const entry of entries) {
    entryMap.set(entry.id, entry);
  }

  // Walk from leaf to root, collecting parent chain.
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = entryMap.get(session.leafId);
  while (current) {
    path.push(current);
    current = current.parentId ? entryMap.get(current.parentId) : undefined;
  }

  for (const entry of path) {
    if (entry.type !== "mode_change") continue;
    const data = entry.data;
    if ("exit" in data) return null;
    if ("enter" in data) {
      const mode = modes.find((m) => m.id === data.enter);
      return mode ?? null;
    }
  }
  return null;
}
