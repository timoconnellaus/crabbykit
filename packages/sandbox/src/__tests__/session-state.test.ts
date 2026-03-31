import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  clearAllElevation,
  clearAllProcessOwners,
  clearSessionElevation,
  getElevatedSessionIds,
  getOwnedProcessIds,
  getProcessOwner,
  getSessionReason,
  isAnySessionElevated,
  isSessionElevated,
  removeProcessOwner,
  setProcessOwner,
  setSessionElevated,
} from "../session-state.js";

/** Map-backed storage for realistic read/write behavior. */
function createMapStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
    async list<T>(prefix?: string): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}

describe("session elevation state", () => {
  it("isSessionElevated returns false for unknown session", async () => {
    const s = createMapStorage();
    expect(await isSessionElevated(s, "unknown")).toBe(false);
  });

  it("setSessionElevated + isSessionElevated round-trip", async () => {
    const s = createMapStorage();
    await setSessionElevated(s, "s1", "need shell");
    expect(await isSessionElevated(s, "s1")).toBe(true);
    expect(await isSessionElevated(s, "s2")).toBe(false);
  });

  it("getSessionReason returns the reason", async () => {
    const s = createMapStorage();
    await setSessionElevated(s, "s1", "testing");
    expect(await getSessionReason(s, "s1")).toBe("testing");
  });

  it("isAnySessionElevated returns false when empty", async () => {
    const s = createMapStorage();
    expect(await isAnySessionElevated(s)).toBe(false);
  });

  it("isAnySessionElevated returns true when one session elevated", async () => {
    const s = createMapStorage();
    await setSessionElevated(s, "s1", "reason");
    expect(await isAnySessionElevated(s)).toBe(true);
  });

  it("getElevatedSessionIds returns only elevated session IDs", async () => {
    const s = createMapStorage();
    await setSessionElevated(s, "s1", "a");
    await setSessionElevated(s, "s2", "b");

    const ids = await getElevatedSessionIds(s);
    expect(ids.sort()).toEqual(["s1", "s2"]);
  });

  it("clearSessionElevation clears one session, leaves others", async () => {
    const s = createMapStorage();
    await setSessionElevated(s, "s1", "a");
    await setSessionElevated(s, "s2", "b");

    await clearSessionElevation(s, "s1");

    expect(await isSessionElevated(s, "s1")).toBe(false);
    expect(await isSessionElevated(s, "s2")).toBe(true);
    expect(await getSessionReason(s, "s1")).toBeUndefined();
    expect(await getSessionReason(s, "s2")).toBe("b");
  });

  it("clearAllElevation clears all sessions", async () => {
    const s = createMapStorage();
    await setSessionElevated(s, "s1", "a");
    await setSessionElevated(s, "s2", "b");

    await clearAllElevation(s);

    expect(await isSessionElevated(s, "s1")).toBe(false);
    expect(await isSessionElevated(s, "s2")).toBe(false);
    expect(await isAnySessionElevated(s)).toBe(false);
  });
});

describe("process ownership", () => {
  it("setProcessOwner + getProcessOwner round-trip", async () => {
    const s = createMapStorage();
    await setProcessOwner(s, "container-s1", "agent-s1");
    expect(await getProcessOwner(s, "container-s1")).toBe("agent-s1");
  });

  it("getProcessOwner returns undefined for unknown", async () => {
    const s = createMapStorage();
    expect(await getProcessOwner(s, "unknown")).toBeUndefined();
  });

  it("getOwnedProcessIds returns only processes owned by that session", async () => {
    const s = createMapStorage();
    await setProcessOwner(s, "c1", "agent-a");
    await setProcessOwner(s, "c2", "agent-b");
    await setProcessOwner(s, "c3", "agent-a");

    const aIds = await getOwnedProcessIds(s, "agent-a");
    expect(aIds.sort()).toEqual(["c1", "c3"]);

    const bIds = await getOwnedProcessIds(s, "agent-b");
    expect(bIds).toEqual(["c2"]);
  });

  it("removeProcessOwner cleans up correctly", async () => {
    const s = createMapStorage();
    await setProcessOwner(s, "c1", "agent-a");
    await removeProcessOwner(s, "c1");
    expect(await getProcessOwner(s, "c1")).toBeUndefined();
    expect(await getOwnedProcessIds(s, "agent-a")).toEqual([]);
  });

  it("clearAllProcessOwners removes all ownership", async () => {
    const s = createMapStorage();
    await setProcessOwner(s, "c1", "agent-a");
    await setProcessOwner(s, "c2", "agent-b");

    await clearAllProcessOwners(s);

    expect(await getProcessOwner(s, "c1")).toBeUndefined();
    expect(await getProcessOwner(s, "c2")).toBeUndefined();
  });
});
