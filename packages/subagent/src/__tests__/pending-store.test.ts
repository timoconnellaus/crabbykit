import { describe, expect, it } from "vitest";
import { PendingSubagentStore } from "../pending-store.js";
import type { PendingSubagent } from "../types.js";

function mockStorage() {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
    list: async <T>(prefix: string) => {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) result.set(k, v as T);
      }
      return result;
    },
  };
}

function makePending(overrides?: Partial<PendingSubagent>): PendingSubagent {
  return {
    subagentId: "sub-1",
    profileId: "explorer",
    childSessionId: "child-session-1",
    parentSessionId: "parent-session",
    prompt: "Find auth modules",
    state: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PendingSubagentStore", () => {
  it("saves and retrieves a pending subagent", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    const pending = makePending();

    await pendingStore.save(pending);
    const retrieved = await pendingStore.get("sub-1");

    expect(retrieved).toBeDefined();
    expect(retrieved!.subagentId).toBe("sub-1");
    expect(retrieved!.profileId).toBe("explorer");
  });

  it("returns undefined for non-existent", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    expect(await pendingStore.get("non-existent")).toBeUndefined();
  });

  it("deletes a pending subagent", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    await pendingStore.save(makePending());
    await pendingStore.delete("sub-1");
    expect(await pendingStore.get("sub-1")).toBeUndefined();
  });

  it("updates state", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    await pendingStore.save(makePending());
    await pendingStore.updateState("sub-1", "completed");

    const retrieved = await pendingStore.get("sub-1");
    expect(retrieved!.state).toBe("completed");
  });

  it("updateState is no-op for non-existent", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    await pendingStore.updateState("non-existent", "failed");
    // Should not throw
  });

  it("lists all pending subagents", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    await pendingStore.save(makePending({ subagentId: "sub-1" }));
    await pendingStore.save(makePending({ subagentId: "sub-2" }));

    const all = await pendingStore.list();
    expect(all).toHaveLength(2);
  });

  it("lists only active subagents", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    await pendingStore.save(makePending({ subagentId: "sub-1", state: "running" }));
    await pendingStore.save(makePending({ subagentId: "sub-2", state: "completed" }));
    await pendingStore.save(makePending({ subagentId: "sub-3", state: "running" }));

    const active = await pendingStore.listActive();
    expect(active).toHaveLength(2);
    expect(active.map((s) => s.subagentId).sort()).toEqual(["sub-1", "sub-3"]);
  });

  it("stores optional taskId", async () => {
    const pendingStore = new PendingSubagentStore(mockStorage());
    await pendingStore.save(makePending({ taskId: "task-123" }));

    const retrieved = await pendingStore.get("sub-1");
    expect(retrieved!.taskId).toBe("task-123");
  });
});
