import type { SqlResult, SqlStore } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { TaskStore } from "../server/task-store.js";
import type { Artifact, PushNotificationConfig, TaskStatus } from "../types.js";

// ============================================================================
// In-memory SqlStore mock (simulates SQLite)
// ============================================================================

interface Row {
  [key: string]: unknown;
}

function createInMemorySqlStore(): SqlStore {
  const tables: Record<string, Row[]> = {};

  function makeSqlResult<T>(rows: T[]): SqlResult<T> {
    return {
      toArray: () => rows,
      one: () => rows[0] ?? null,
      [Symbol.iterator]: () => rows[Symbol.iterator]() as Iterator<T>,
    };
  }

  function getTable(name: string): Row[] {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  return {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlResult<T> {
      const trimmed = query.trim().replace(/\s+/g, " ");

      // CREATE TABLE / CREATE INDEX — no-op
      if (trimmed.startsWith("CREATE TABLE") || trimmed.startsWith("CREATE INDEX")) {
        return makeSqlResult<T>([]);
      }

      // INSERT INTO a2a_tasks
      if (trimmed.startsWith("INSERT INTO a2a_tasks")) {
        const row: Row = {
          id: bindings[0],
          context_id: bindings[1],
          session_id: bindings[2],
          state: "submitted",
          status_message: null,
          status_timestamp: bindings[3],
          metadata: bindings[4],
          created_at: bindings[5],
          updated_at: bindings[6],
        };
        getTable("a2a_tasks").push(row);
        return makeSqlResult<T>([]);
      }

      // INSERT INTO a2a_artifacts
      if (trimmed.startsWith("INSERT INTO a2a_artifacts")) {
        const row: Row = {
          id: bindings[0],
          task_id: bindings[1],
          artifact_id: bindings[2],
          name: bindings[3],
          description: bindings[4],
          parts: bindings[5],
          seq: bindings[6],
          metadata: bindings[7],
        };
        getTable("a2a_artifacts").push(row);
        return makeSqlResult<T>([]);
      }

      // INSERT OR REPLACE INTO a2a_push_configs
      if (trimmed.startsWith("INSERT OR REPLACE INTO a2a_push_configs")) {
        const table = getTable("a2a_push_configs");
        const idx = table.findIndex((r) => r.task_id === bindings[0]);
        const row: Row = {
          task_id: bindings[0],
          url: bindings[1],
          token: bindings[2],
          auth_schemes: bindings[3],
        };
        if (idx >= 0) table[idx] = row;
        else table.push(row);
        return makeSqlResult<T>([]);
      }

      // SELECT * FROM a2a_tasks WHERE id = ?
      if (trimmed.startsWith("SELECT * FROM a2a_tasks WHERE id =")) {
        const rows = getTable("a2a_tasks").filter((r) => r.id === bindings[0]);
        return makeSqlResult(rows as T[]);
      }

      // SELECT session_id FROM a2a_tasks WHERE id = ?
      if (trimmed.startsWith("SELECT session_id FROM a2a_tasks WHERE id =")) {
        const rows = getTable("a2a_tasks")
          .filter((r) => r.id === bindings[0])
          .map((r) => ({ session_id: r.session_id }));
        return makeSqlResult(rows as T[]);
      }

      // SELECT session_id FROM a2a_tasks WHERE context_id = ? ORDER BY ...
      if (trimmed.startsWith("SELECT session_id FROM a2a_tasks WHERE context_id =")) {
        const rows = getTable("a2a_tasks")
          .filter((r) => r.context_id === bindings[0])
          .reverse()
          .slice(0, 1)
          .map((r) => ({ session_id: r.session_id }));
        return makeSqlResult(rows as T[]);
      }

      // SELECT * FROM a2a_tasks (with optional WHERE context_id)
      if (trimmed.startsWith("SELECT * FROM a2a_tasks")) {
        let rows = [...getTable("a2a_tasks")];
        if (trimmed.includes("WHERE context_id =")) {
          rows = rows.filter((r) => r.context_id === bindings[0]);
        }
        // ORDER BY created_at DESC
        rows.reverse();
        // LIMIT
        const limitMatch = trimmed.match(/LIMIT \?/);
        if (limitMatch) {
          const limitIdx = trimmed.includes("WHERE") ? 1 : 0;
          const limit = bindings[limitIdx] as number;
          const offsetIdx = trimmed.includes("OFFSET") ? limitIdx + 1 : -1;
          const offset = offsetIdx >= 0 ? (bindings[offsetIdx] as number) : 0;
          rows = rows.slice(offset, offset + limit);
        }
        return makeSqlResult(rows as T[]);
      }

      // UPDATE a2a_tasks SET state ...
      if (trimmed.startsWith("UPDATE a2a_tasks SET state")) {
        const taskId = bindings[4];
        const task = getTable("a2a_tasks").find((r) => r.id === taskId);
        if (task) {
          task.state = bindings[0];
          task.status_message = bindings[1];
          task.status_timestamp = bindings[2];
          task.updated_at = bindings[3];
        }
        return makeSqlResult<T>([]);
      }

      // DELETE FROM a2a_tasks WHERE id = ?
      if (trimmed.startsWith("DELETE FROM a2a_tasks")) {
        const table = getTable("a2a_tasks");
        const idx = table.findIndex((r) => r.id === bindings[0]);
        if (idx >= 0) table.splice(idx, 1);
        return makeSqlResult<T>([]);
      }

      // SELECT MAX(seq) as max_seq FROM a2a_artifacts WHERE task_id = ?
      if (trimmed.startsWith("SELECT MAX(seq) as max_seq")) {
        const artifacts = getTable("a2a_artifacts").filter((r) => r.task_id === bindings[0]);
        const maxSeq =
          artifacts.length > 0 ? Math.max(...artifacts.map((r) => r.seq as number)) : null;
        return makeSqlResult([{ max_seq: maxSeq }] as T[]);
      }

      // SELECT * FROM a2a_artifacts WHERE task_id = ? AND artifact_id = ? ORDER BY seq DESC LIMIT 1
      if (trimmed.includes("a2a_artifacts") && trimmed.includes("artifact_id")) {
        const rows = getTable("a2a_artifacts")
          .filter((r) => r.task_id === bindings[0] && r.artifact_id === bindings[1])
          .sort((a, b) => (b.seq as number) - (a.seq as number))
          .slice(0, 1);
        return makeSqlResult(rows as T[]);
      }

      // UPDATE a2a_artifacts SET parts = ? WHERE id = ?
      if (trimmed.startsWith("UPDATE a2a_artifacts")) {
        const artifact = getTable("a2a_artifacts").find((r) => r.id === bindings[1]);
        if (artifact) artifact.parts = bindings[0];
        return makeSqlResult<T>([]);
      }

      // SELECT * FROM a2a_artifacts WHERE task_id = ? ORDER BY seq
      if (trimmed.startsWith("SELECT * FROM a2a_artifacts WHERE task_id")) {
        const rows = getTable("a2a_artifacts")
          .filter((r) => r.task_id === bindings[0])
          .sort((a, b) => (a.seq as number) - (b.seq as number));
        return makeSqlResult(rows as T[]);
      }

      // SELECT * FROM a2a_push_configs WHERE task_id = ?
      if (trimmed.startsWith("SELECT * FROM a2a_push_configs")) {
        const rows = getTable("a2a_push_configs").filter((r) => r.task_id === bindings[0]);
        return makeSqlResult(rows as T[]);
      }

      // DELETE FROM a2a_push_configs WHERE task_id = ?
      if (trimmed.startsWith("DELETE FROM a2a_push_configs")) {
        const table = getTable("a2a_push_configs");
        const idx = table.findIndex((r) => r.task_id === bindings[0]);
        if (idx >= 0) table.splice(idx, 1);
        return makeSqlResult<T>([]);
      }

      // Fallback
      return makeSqlResult<T>([]);
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("TaskStore", () => {
  function createStore(): TaskStore {
    return new TaskStore(createInMemorySqlStore());
  }

  // --- Task CRUD ---

  describe("create", () => {
    it("creates a task with submitted status", () => {
      const store = createStore();
      const task = store.create({
        contextId: "ctx-1",
        sessionId: "sess-1",
      });

      expect(task.id).toBeDefined();
      expect(task.contextId).toBe("ctx-1");
      expect(task.status.state).toBe("submitted");
      expect(task.status.timestamp).toBeDefined();
    });

    it("uses provided id when given", () => {
      const store = createStore();
      const task = store.create({
        id: "custom-id",
        contextId: "ctx-1",
        sessionId: "sess-1",
      });

      expect(task.id).toBe("custom-id");
    });

    it("stores metadata", () => {
      const store = createStore();
      store.create({
        id: "meta-task",
        contextId: "ctx-1",
        sessionId: "sess-1",
        metadata: { foo: "bar" },
      });

      const retrieved = store.get("meta-task");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.metadata).toEqual({ foo: "bar" });
    });

    it("creates task without metadata", () => {
      const store = createStore();
      store.create({
        id: "no-meta",
        contextId: "ctx-1",
        sessionId: "sess-1",
      });

      const retrieved = store.get("no-meta");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.metadata).toBeUndefined();
    });
  });

  describe("get", () => {
    it("returns the task by id", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      const task = store.get("t1");
      expect(task).not.toBeNull();
      expect(task!.id).toBe("t1");
      expect(task!.contextId).toBe("ctx-1");
    });

    it("returns null for nonexistent task", () => {
      const store = createStore();
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all tasks", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });
      store.create({ id: "t2", contextId: "ctx-2", sessionId: "s2" });

      const tasks = store.list();
      expect(tasks).toHaveLength(2);
    });

    it("filters by contextId", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });
      store.create({ id: "t2", contextId: "ctx-2", sessionId: "s2" });

      const tasks = store.list({ contextId: "ctx-1" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].contextId).toBe("ctx-1");
    });

    it("returns empty array when no tasks match", () => {
      const store = createStore();
      expect(store.list({ contextId: "nonexistent" })).toHaveLength(0);
    });

    it("returns empty array from empty store", () => {
      const store = createStore();
      expect(store.list()).toHaveLength(0);
    });
  });

  describe("updateStatus", () => {
    it("updates the task state", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      const status: TaskStatus = { state: "working", timestamp: "2025-01-01T00:00:00Z" };
      store.updateStatus("t1", status);

      const task = store.get("t1");
      expect(task!.status.state).toBe("working");
      expect(task!.status.timestamp).toBe("2025-01-01T00:00:00Z");
    });

    it("stores status message as JSON", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      const status: TaskStatus = {
        state: "completed",
        timestamp: "2025-01-01T00:00:00Z",
        message: {
          messageId: "m1",
          role: "agent",
          parts: [{ text: "Done!" }],
        },
      };
      store.updateStatus("t1", status);

      const task = store.get("t1");
      expect(task!.status.state).toBe("completed");
      expect(task!.status.message).toBeDefined();
      expect(task!.status.message!.role).toBe("agent");
    });

    it("clears status message when not provided", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.updateStatus("t1", {
        state: "working",
        timestamp: "2025-01-01T00:00:00Z",
        message: { messageId: "m1", role: "agent", parts: [{ text: "Working..." }] },
      });

      store.updateStatus("t1", {
        state: "completed",
        timestamp: "2025-01-02T00:00:00Z",
      });

      const task = store.get("t1");
      expect(task!.status.message).toBeUndefined();
    });
  });

  describe("getSessionId", () => {
    it("returns session id for a task", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "sess-42" });

      expect(store.getSessionId("t1")).toBe("sess-42");
    });

    it("returns null for nonexistent task", () => {
      const store = createStore();
      expect(store.getSessionId("nonexistent")).toBeNull();
    });
  });

  describe("getSessionIdForContext", () => {
    it("returns session id for latest task in context", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "sess-1" });
      store.create({ id: "t2", contextId: "ctx-1", sessionId: "sess-2" });

      // Should return the most recent one
      const sessionId = store.getSessionIdForContext("ctx-1");
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe("string");
    });

    it("returns null for unknown context", () => {
      const store = createStore();
      expect(store.getSessionIdForContext("nonexistent")).toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes a task", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.delete("t1");
      expect(store.get("t1")).toBeNull();
    });

    it("does nothing for nonexistent task", () => {
      const store = createStore();
      // Should not throw
      store.delete("nonexistent");
    });
  });

  // --- Artifacts ---

  describe("addArtifact", () => {
    it("adds an artifact to a task", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      const artifact: Artifact = {
        artifactId: "art-1",
        name: "Test Artifact",
        parts: [{ text: "content" }],
      };
      store.addArtifact("t1", artifact);

      const artifacts = store.getArtifacts("t1");
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].artifactId).toBe("art-1");
      expect(artifacts[0].name).toBe("Test Artifact");
      expect(artifacts[0].parts).toEqual([{ text: "content" }]);
    });

    it("auto-increments sequence numbers", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.addArtifact("t1", {
        artifactId: "art-1",
        parts: [{ text: "first" }],
      });
      store.addArtifact("t1", {
        artifactId: "art-2",
        parts: [{ text: "second" }],
      });

      const artifacts = store.getArtifacts("t1");
      expect(artifacts).toHaveLength(2);
      expect(artifacts[0].artifactId).toBe("art-1");
      expect(artifacts[1].artifactId).toBe("art-2");
    });

    it("stores artifact with metadata", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.addArtifact("t1", {
        artifactId: "art-1",
        parts: [{ text: "content" }],
        metadata: { version: 1 },
      });

      const artifacts = store.getArtifacts("t1");
      expect(artifacts[0].metadata).toEqual({ version: 1 });
    });

    it("stores artifact with description", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.addArtifact("t1", {
        artifactId: "art-1",
        description: "A test artifact",
        parts: [{ text: "content" }],
      });

      const artifacts = store.getArtifacts("t1");
      expect(artifacts[0].description).toBe("A test artifact");
    });
  });

  describe("appendArtifactParts", () => {
    it("appends parts to an existing artifact", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.addArtifact("t1", {
        artifactId: "art-1",
        parts: [{ text: "part-1" }],
      });

      store.appendArtifactParts("t1", "art-1", [{ text: "part-2" }]);

      const artifacts = store.getArtifacts("t1");
      expect(artifacts[0].parts).toHaveLength(2);
      expect(artifacts[0].parts[0]).toEqual({ text: "part-1" });
      expect(artifacts[0].parts[1]).toEqual({ text: "part-2" });
    });

    it("does nothing when artifact does not exist", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      // Should not throw
      store.appendArtifactParts("t1", "nonexistent", [{ text: "part" }]);
    });
  });

  describe("getArtifacts", () => {
    it("returns empty array for task with no artifacts", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });
      expect(store.getArtifacts("t1")).toHaveLength(0);
    });

    it("returns artifacts ordered by sequence", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.addArtifact("t1", { artifactId: "a", parts: [{ text: "first" }] });
      store.addArtifact("t1", { artifactId: "b", parts: [{ text: "second" }] });
      store.addArtifact("t1", { artifactId: "c", parts: [{ text: "third" }] });

      const artifacts = store.getArtifacts("t1");
      expect(artifacts.map((a) => a.artifactId)).toEqual(["a", "b", "c"]);
    });
  });

  // --- Push Configs ---

  describe("setPushConfig", () => {
    it("stores a push notification config", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      const config: PushNotificationConfig = {
        url: "https://callback.example.com",
        token: "secret-token",
      };
      store.setPushConfig("t1", config);

      const retrieved = store.getPushConfig("t1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.url).toBe("https://callback.example.com");
      expect(retrieved!.token).toBe("secret-token");
    });

    it("stores config with authentication schemes", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      const config: PushNotificationConfig = {
        url: "https://callback.example.com",
        authentication: { schemes: ["bearer", "apiKey"] },
      };
      store.setPushConfig("t1", config);

      const retrieved = store.getPushConfig("t1");
      expect(retrieved!.authentication).toEqual({ schemes: ["bearer", "apiKey"] });
    });

    it("stores config without optional fields", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.setPushConfig("t1", { url: "https://callback.example.com" });

      const retrieved = store.getPushConfig("t1");
      expect(retrieved!.url).toBe("https://callback.example.com");
      expect(retrieved!.token).toBeUndefined();
      expect(retrieved!.authentication).toBeUndefined();
    });

    it("replaces existing config", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.setPushConfig("t1", { url: "https://old.example.com", token: "old" });
      store.setPushConfig("t1", { url: "https://new.example.com", token: "new" });

      const retrieved = store.getPushConfig("t1");
      expect(retrieved!.url).toBe("https://new.example.com");
      expect(retrieved!.token).toBe("new");
    });
  });

  describe("getPushConfig", () => {
    it("returns null for nonexistent config", () => {
      const store = createStore();
      expect(store.getPushConfig("nonexistent")).toBeNull();
    });
  });

  describe("deletePushConfig", () => {
    it("removes a push config", () => {
      const store = createStore();
      store.create({ id: "t1", contextId: "ctx-1", sessionId: "s1" });

      store.setPushConfig("t1", { url: "https://callback.example.com" });
      store.deletePushConfig("t1");

      expect(store.getPushConfig("t1")).toBeNull();
    });

    it("does nothing for nonexistent config", () => {
      const store = createStore();
      // Should not throw
      store.deletePushConfig("nonexistent");
    });
  });
});
