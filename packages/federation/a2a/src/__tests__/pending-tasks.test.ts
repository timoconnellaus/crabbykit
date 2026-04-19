import type { CapabilityStorage } from "@crabbykit/agent-runtime";
import { describe, expect, it } from "vitest";
import type { PendingTask } from "../client/pending-tasks.js";
import { PendingTaskStore } from "../client/pending-tasks.js";

// ============================================================================
// Mock CapabilityStorage
// ============================================================================

function createMockStorage(): CapabilityStorage {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
    list: async <T>(prefix?: string) => {
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

function makePendingTask(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    taskId: "task-1",
    contextId: "ctx-1",
    targetAgent: "agent-2",
    targetAgentName: "Agent Two",
    originalRequest: "Do something",
    state: "submitted",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    originSessionId: "session-1",
    webhookToken: "token-abc",
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("PendingTaskStore", () => {
  describe("save and get", () => {
    it("stores and retrieves a pending task", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);
      const task = makePendingTask();

      await taskStore.save(task);
      const retrieved = await taskStore.get("task-1");

      expect(retrieved).toBeDefined();
      expect(retrieved!.taskId).toBe("task-1");
      expect(retrieved!.targetAgent).toBe("agent-2");
    });

    it("returns undefined for nonexistent task", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      const result = await taskStore.get("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("removes a task", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      await taskStore.save(makePendingTask());
      await taskStore.delete("task-1");

      expect(await taskStore.get("task-1")).toBeUndefined();
    });
  });

  describe("updateState", () => {
    it("updates the task state and updatedAt", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      await taskStore.save(makePendingTask({ state: "submitted" }));
      await taskStore.updateState("task-1", "working");

      const updated = await taskStore.get("task-1");
      expect(updated!.state).toBe("working");
      expect(updated!.updatedAt).not.toBe("2025-01-01T00:00:00Z");
    });

    it("does nothing for nonexistent task", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      // Should not throw
      await taskStore.updateState("nonexistent", "working");
    });
  });

  describe("list", () => {
    it("returns all pending tasks", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      await taskStore.save(makePendingTask({ taskId: "t1" }));
      await taskStore.save(makePendingTask({ taskId: "t2" }));

      const all = await taskStore.list();
      expect(all).toHaveLength(2);
    });

    it("returns empty array when no tasks", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      expect(await taskStore.list()).toHaveLength(0);
    });
  });

  describe("listActive", () => {
    it("returns only active tasks (submitted, working, input-required)", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      await taskStore.save(makePendingTask({ taskId: "t1", state: "submitted" }));
      await taskStore.save(makePendingTask({ taskId: "t2", state: "working" }));
      await taskStore.save(makePendingTask({ taskId: "t3", state: "input-required" }));
      await taskStore.save(makePendingTask({ taskId: "t4", state: "completed" }));
      await taskStore.save(makePendingTask({ taskId: "t5", state: "failed" }));
      await taskStore.save(makePendingTask({ taskId: "t6", state: "canceled" }));

      const active = await taskStore.listActive();
      expect(active).toHaveLength(3);
      expect(active.map((t) => t.taskId).sort()).toEqual(["t1", "t2", "t3"]);
    });

    it("returns empty array when all tasks are terminal", async () => {
      const storage = createMockStorage();
      const taskStore = new PendingTaskStore(storage);

      await taskStore.save(makePendingTask({ taskId: "t1", state: "completed" }));
      await taskStore.save(makePendingTask({ taskId: "t2", state: "failed" }));

      expect(await taskStore.listActive()).toHaveLength(0);
    });
  });
});
