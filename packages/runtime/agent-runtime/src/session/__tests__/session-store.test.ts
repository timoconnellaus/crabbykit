import { beforeEach, describe, expect, it } from "vitest";
import type { SqlResult, SqlStore } from "../../storage/types.js";
import { createMockSqlStore } from "../../test-helpers/mock-sql-storage.js";
import { SessionStore } from "../session-store.js";

/**
 * Wraps a real SqlStore to record every SQL statement executed against it.
 * Used below to assert that the migration path is idempotent (no second
 * ALTER TABLE when the column already exists).
 */
function recordingSqlStore(inner: SqlStore): { sql: SqlStore; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    sql: {
      exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlResult<T> {
        statements.push(query.replace(/\s+/g, " ").trim());
        return inner.exec<T>(query, ...bindings);
      },
    },
  };
}

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(createMockSqlStore());
  });

  describe("Session CRUD", () => {
    it("creates a session with defaults", () => {
      const session = store.create();
      expect(session.id).toBeTruthy();
      expect(session.name).toBe("");
      expect(session.source).toBe("websocket");
      expect(session.leafId).toBeNull();
      expect(session.createdAt).toBeTruthy();
      expect(session.updatedAt).toBeTruthy();
    });

    it("creates a session with name and source", () => {
      const session = store.create({ name: "Test", source: "telegram" });
      expect(session.name).toBe("Test");
      expect(session.source).toBe("telegram");
    });

    it("gets a session by ID", () => {
      const created = store.create({ name: "Find me" });
      const found = store.get(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Find me");
    });

    it("returns null for non-existent session", () => {
      expect(store.get("non-existent")).toBeNull();
    });

    it("lists sessions ordered by updatedAt descending", () => {
      store.create({ name: "First" });
      store.create({ name: "Second" });
      const sessions = store.list();
      expect(sessions.length).toBe(2);
      // Most recently created should be first (higher updatedAt)
      expect(sessions.map((s) => s.name)).toContain("First");
      expect(sessions.map((s) => s.name)).toContain("Second");
    });

    it("deletes a session and its entries", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "hello", timestamp: Date.now() },
      });
      store.delete(session.id);
      expect(store.get(session.id)).toBeNull();
      expect(store.getEntries(session.id)).toHaveLength(0);
    });
  });

  describe("Entry Operations", () => {
    it("appends an entry to a session", () => {
      const session = store.create();
      const entry = store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "hello", timestamp: 1000 },
      });

      expect(entry.id).toBeTruthy();
      expect(entry.parentId).toBeNull(); // First entry
      expect(entry.sessionId).toBe(session.id);
      expect(entry.seq).toBe(1);
      expect(entry.type).toBe("message");
      expect((entry.data as any).role).toBe("user");
    });

    it("chains entries via parent_id", () => {
      const session = store.create();
      const e1 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "hello", timestamp: 1000 },
      });
      const e2 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "hi", timestamp: 1001 },
      });

      expect(e1.parentId).toBeNull();
      expect(e2.parentId).toBe(e1.id);
      expect(e2.seq).toBe(2);
    });

    it("updates leaf_id on append", () => {
      const session = store.create();
      const e1 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "hello", timestamp: 1000 },
      });

      const updated = store.get(session.id);
      expect(updated!.leafId).toBe(e1.id);
    });

    it("throws on append to non-existent session", () => {
      expect(() =>
        store.appendEntry("non-existent", {
          type: "message",
          data: { role: "user", content: "hello" },
        }),
      ).toThrow("Session not found");
    });

    it("gets all entries ordered by seq", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "first", timestamp: 1 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "second", timestamp: 2 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "third", timestamp: 3 },
      });

      const entries = store.getEntries(session.id);
      expect(entries).toHaveLength(3);
      expect(entries[0].seq).toBe(1);
      expect(entries[1].seq).toBe(2);
      expect(entries[2].seq).toBe(3);
    });
  });

  describe("buildContext", () => {
    it("returns empty array for empty session", () => {
      const session = store.create();
      expect(store.buildContext(session.id)).toEqual([]);
    });

    it("returns empty array for non-existent session", () => {
      expect(store.buildContext("non-existent")).toEqual([]);
    });

    it("builds simple conversation context", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "hello", timestamp: 1000 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "hi there", timestamp: 1001 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "how are you?", timestamp: 1002 },
      });

      const context = store.buildContext(session.id);
      expect(context).toHaveLength(3);
      expect((context[0] as any).role).toBe("user");
      expect((context[0] as any).content).toBe("hello");
      expect((context[1] as any).role).toBe("assistant");
      expect((context[2] as any).role).toBe("user");
    });

    it("handles compaction with invalid firstKeptEntryId", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg1", timestamp: 1 },
      });

      // Add compaction with a non-existent firstKeptEntryId
      store.appendEntry(session.id, {
        type: "compaction",
        data: {
          summary: "Summary",
          firstKeptEntryId: "non_existent_id",
          tokensBefore: 100,
        },
      });

      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "after compaction", timestamp: 3 },
      });

      const context = store.buildContext(session.id);
      // Should still work — fallback to entry after compaction
      expect(context.length).toBeGreaterThanOrEqual(1);
      expect((context[0] as any).content).toContain("Summary");
    });

    it("resolves compaction boundary", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "old message 1", timestamp: 1 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "old response", timestamp: 2 },
      });
      const e3 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "kept message", timestamp: 3 },
      });

      // Add compaction entry pointing to e3 as first kept
      store.appendEntry(session.id, {
        type: "compaction",
        data: {
          summary: "Summary of old messages",
          firstKeptEntryId: e3.id,
          tokensBefore: 5000,
        },
      });

      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "new response", timestamp: 5 },
      });

      const context = store.buildContext(session.id);
      // Should have: summary + kept message + new response
      expect(context.length).toBeGreaterThanOrEqual(2);
      // First message should be the compaction summary
      expect((context[0] as any).content).toContain("Summary of old messages");
    });

    it("handles messages without explicit timestamp", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "no timestamp" },
      });

      const context = store.buildContext(session.id);
      expect(context).toHaveLength(1);
      expect((context[0] as any).timestamp).toBeTruthy();
    });

    it("handles toolResult with array content", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: {
          role: "toolResult",
          content: [{ type: "text", text: "result data" }],
          toolCallId: "call_arr",
          toolName: "test_tool",
          isError: false,
        },
      });

      const context = store.buildContext(session.id);
      expect(context).toHaveLength(1);
      expect((context[0] as any).role).toBe("toolResult");
      // Array content passed through as-is
      expect((context[0] as any).content).toEqual([{ type: "text", text: "result data" }]);
    });

    it("skips non-message entries in context", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "hello", timestamp: 1 },
      });
      store.appendEntry(session.id, {
        type: "model_change",
        data: { provider: "openrouter", modelId: "gpt-4" },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "hi", timestamp: 3 },
      });

      const context = store.buildContext(session.id);
      // model_change should be skipped
      expect(context).toHaveLength(2);
    });

    it("handles toolResult entries", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "search for X", timestamp: 1 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: {
          role: "toolResult",
          content: "search results here",
          toolCallId: "call_123",
          toolName: "web_search",
          isError: false,
          timestamp: 2,
        },
      });

      const context = store.buildContext(session.id);
      expect(context).toHaveLength(2);
      expect((context[1] as any).role).toBe("toolResult");
      expect((context[1] as any).toolCallId).toBe("call_123");
    });
  });

  describe("Branching", () => {
    it("branches from mid-conversation", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg1", timestamp: 1 },
      });
      const e2 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "msg2", timestamp: 2 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg3", timestamp: 3 },
      });

      // Branch from e2
      store.branch(session.id, e2.id);

      const updated = store.get(session.id);
      expect(updated!.leafId).toBe(e2.id);

      // Context should only have msg1 and msg2
      const context = store.buildContext(session.id);
      expect(context).toHaveLength(2);
    });

    it("throws when branching to non-existent entry", () => {
      const session = store.create();
      expect(() => store.branch(session.id, "non-existent")).toThrow("Entry not found");
    });

    it("preserves original branch after fork", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg1", timestamp: 1 },
      });
      const e2 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "msg2", timestamp: 2 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg3", timestamp: 3 },
      });

      // Branch from e2
      store.branch(session.id, e2.id);

      // All 3 entries still exist in the table
      const entries = store.getEntries(session.id);
      expect(entries).toHaveLength(3);

      // But context only shows the branch path
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "branched msg", timestamp: 4 },
      });

      const context = store.buildContext(session.id);
      // msg1 → msg2 → branched msg (not msg3)
      expect(context).toHaveLength(3);
      expect((context[2] as any).content).toBe("branched msg");
    });
  });

  describe("Garbage Collection", () => {
    it("returns 0 for session with no leafId", () => {
      const session = store.create();
      // No entries appended → leafId is null
      expect(store.gc(session.id)).toBe(0);
    });

    it("returns 0 for non-existent session", () => {
      expect(store.gc("non-existent")).toBe(0);
    });

    it("returns 0 when all entries are reachable (linear chain)", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg1", timestamp: 1 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "msg2", timestamp: 2 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg3", timestamp: 3 },
      });

      // All entries on the leaf-to-root path — nothing to gc
      expect(store.gc(session.id)).toBe(0);
      expect(store.getEntries(session.id)).toHaveLength(3);
    });

    it("removes orphaned entries after branching", () => {
      const session = store.create();
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg1", timestamp: 1 },
      });
      const e2 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "msg2", timestamp: 2 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg3-orphan", timestamp: 3 },
      });

      // Branch from e2 — msg3 becomes orphaned
      store.branch(session.id, e2.id);

      // Add a new entry on the branch
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "msg3-new", timestamp: 4 },
      });

      // Before GC: 4 entries (msg1, msg2, msg3-orphan, msg3-new)
      expect(store.getEntries(session.id)).toHaveLength(4);

      // GC removes the orphaned msg3
      const removed = store.gc(session.id);
      expect(removed).toBe(1);

      // After GC: 3 entries remain
      const remaining = store.getEntries(session.id);
      expect(remaining).toHaveLength(3);
      expect(remaining.map((e) => (e.data as any).content)).toEqual(["msg1", "msg2", "msg3-new"]);
    });

    it("removes multiple orphaned branches", () => {
      const session = store.create();
      const e1 = store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "root", timestamp: 1 },
      });

      // First branch: e1 → e2 → e3
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "branch1-a", timestamp: 2 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "branch1-b", timestamp: 3 },
      });

      // Go back to e1 and create second branch
      store.branch(session.id, e1.id);
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "assistant", content: "branch2-a", timestamp: 4 },
      });
      store.appendEntry(session.id, {
        type: "message",
        data: { role: "user", content: "branch2-b", timestamp: 5 },
      });

      // 5 entries total, but only 3 reachable (root, branch2-a, branch2-b)
      expect(store.getEntries(session.id)).toHaveLength(5);

      const removed = store.gc(session.id);
      expect(removed).toBe(2);
      expect(store.getEntries(session.id)).toHaveLength(3);
    });
  });

  describe("Rename", () => {
    it("renames a session", () => {
      const session = store.create({ name: "Original" });
      store.rename(session.id, "Renamed");

      const updated = store.get(session.id);
      expect(updated!.name).toBe("Renamed");
    });
  });

  describe("Paginated Entries", () => {
    it("returns entries with default pagination", () => {
      const session = store.create();
      for (let i = 0; i < 3; i++) {
        store.appendEntry(session.id, {
          type: "message",
          data: { role: "user", content: `msg${i}`, timestamp: i },
        });
      }

      const result = store.getEntriesPaginated(session.id);
      expect(result.entries).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("sender column", () => {
    it("defaults sender to null on a plain create", () => {
      const session = store.create();
      expect(session.sender).toBeNull();
    });

    it("persists a sender on create", () => {
      const session = store.create({ source: "telegram", sender: "@alice" });
      expect(session.sender).toBe("@alice");
      expect(session.source).toBe("telegram");
    });

    it("round-trips sender via get", () => {
      const created = store.create({ source: "telegram", sender: "@bob" });
      const fetched = store.get(created.id);
      expect(fetched?.sender).toBe("@bob");
    });

    it("does not leak sender into websocket-default sessions", () => {
      const plain = store.create({ name: "ws chat" });
      const listed = store.list().find((s) => s.id === plain.id);
      expect(listed?.sender).toBeNull();
    });
  });

  describe("findBySourceAndSender", () => {
    it("returns the matching session", () => {
      const created = store.create({
        source: "telegram",
        sender: "@alice",
        name: "Alice's chat",
      });
      const found = store.findBySourceAndSender("telegram", "@alice");
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.sender).toBe("@alice");
      expect(found?.source).toBe("telegram");
    });

    it("returns null on a miss", () => {
      expect(store.findBySourceAndSender("telegram", "@bob")).toBeNull();
    });

    it("does not match rows where sender is null", () => {
      store.create({ source: "telegram" }); // sender defaults to null
      // Looking up sender "null" (the string) should not match the NULL row.
      expect(store.findBySourceAndSender("telegram", "null")).toBeNull();
    });

    it("isolates rows by source", () => {
      store.create({ source: "telegram", sender: "@alice" });
      expect(store.findBySourceAndSender("discord", "@alice")).toBeNull();
    });
  });

  describe("migration", () => {
    it("runs the sender-column migration on a fresh database", () => {
      const rec = recordingSqlStore(createMockSqlStore());
      new SessionStore(rec.sql);
      // Fresh DB: CREATE TABLE is executed, PRAGMA inspects, and the
      // partial index is created. The column came in via CREATE TABLE
      // so ALTER TABLE MUST NOT have run.
      const alters = rec.statements.filter((s) =>
        /ALTER TABLE sessions ADD COLUMN sender/i.test(s),
      );
      expect(alters).toHaveLength(0);
      const indexes = rec.statements.filter((s) => /idx_sessions_source_sender/i.test(s));
      expect(indexes.length).toBeGreaterThanOrEqual(1);
    });

    it("is idempotent across re-initialization", () => {
      const mock = createMockSqlStore();
      new SessionStore(mock);
      const rec = recordingSqlStore(mock);
      new SessionStore(rec.sql);
      // Second initialization on the same underlying store must not
      // attempt any ALTER TABLE (sender is already present).
      const alters = rec.statements.filter((s) =>
        /ALTER TABLE sessions ADD COLUMN sender/i.test(s),
      );
      expect(alters).toHaveLength(0);
      // The partial index creation uses CREATE INDEX IF NOT EXISTS and
      // is safe to re-run.
    });

    it("adds the sender column when an existing sessions table lacks it", () => {
      const mock = createMockSqlStore();
      // Simulate a pre-existing sessions table without the sender column
      // by issuing a CREATE TABLE that matches the legacy schema before
      // constructing SessionStore.
      mock.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'websocket',
          leaf_id TEXT,
          created_at TEXT,
          updated_at TEXT
        )
      `);
      const rec = recordingSqlStore(mock);
      new SessionStore(rec.sql);
      // The migration path must have added the sender column exactly once.
      const alters = rec.statements.filter((s) =>
        /ALTER TABLE sessions ADD COLUMN sender/i.test(s),
      );
      expect(alters).toHaveLength(1);
    });
  });
});
