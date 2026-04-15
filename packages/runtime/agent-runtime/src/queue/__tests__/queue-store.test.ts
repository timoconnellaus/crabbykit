import { describe, expect, it } from "vitest";
import { createMockSqlStore } from "../../test-helpers/mock-sql-storage.js";
import { QueueStore } from "../queue-store.js";

function createStore(): QueueStore {
  return new QueueStore(createMockSqlStore());
}

describe("QueueStore", () => {
  describe("enqueue", () => {
    it("returns a queued message with generated id and timestamp", () => {
      const store = createStore();
      const item = store.enqueue("session-1", "Hello");

      expect(item.id).toBeDefined();
      expect(item.sessionId).toBe("session-1");
      expect(item.text).toBe("Hello");
      expect(item.createdAt).toBeDefined();
    });
  });

  describe("dequeue", () => {
    it("returns items in FIFO order", () => {
      const store = createStore();
      store.enqueue("s1", "first");
      store.enqueue("s1", "second");
      store.enqueue("s1", "third");

      const a = store.dequeue("s1");
      const b = store.dequeue("s1");
      const c = store.dequeue("s1");

      expect(a?.text).toBe("first");
      expect(b?.text).toBe("second");
      expect(c?.text).toBe("third");
    });

    it("returns null when queue is empty", () => {
      const store = createStore();
      expect(store.dequeue("s1")).toBeNull();
    });

    it("removes the dequeued item", () => {
      const store = createStore();
      store.enqueue("s1", "only");
      store.dequeue("s1");

      expect(store.list("s1")).toHaveLength(0);
    });
  });

  describe("get", () => {
    it("returns item by id", () => {
      const store = createStore();
      const item = store.enqueue("s1", "Hello");
      const found = store.get(item.id);

      expect(found).not.toBeNull();
      expect(found?.text).toBe("Hello");
    });

    it("returns null for unknown id", () => {
      const store = createStore();
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns items for the given session ordered by creation time", () => {
      const store = createStore();
      store.enqueue("s1", "a");
      store.enqueue("s1", "b");
      store.enqueue("s1", "c");

      const items = store.list("s1");
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.text)).toEqual(["a", "b", "c"]);
    });

    it("returns empty array for session with no queued messages", () => {
      const store = createStore();
      expect(store.list("empty")).toEqual([]);
    });
  });

  describe("cross-session isolation", () => {
    it("queues are scoped per session", () => {
      const store = createStore();
      store.enqueue("s1", "for-s1");
      store.enqueue("s2", "for-s2");

      expect(store.list("s1")).toHaveLength(1);
      expect(store.list("s1")[0].text).toBe("for-s1");
      expect(store.list("s2")).toHaveLength(1);
      expect(store.list("s2")[0].text).toBe("for-s2");
    });

    it("dequeue only affects the target session", () => {
      const store = createStore();
      store.enqueue("s1", "a");
      store.enqueue("s2", "b");

      store.dequeue("s1");

      expect(store.list("s1")).toHaveLength(0);
      expect(store.list("s2")).toHaveLength(1);
    });
  });

  describe("delete", () => {
    it("removes a single item by id", () => {
      const store = createStore();
      const item = store.enqueue("s1", "deleteme");
      store.enqueue("s1", "keepme");

      const result = store.delete(item.id);

      expect(result).toBe(true);
      expect(store.list("s1")).toHaveLength(1);
      expect(store.list("s1")[0].text).toBe("keepme");
    });

    it("returns false for unknown id", () => {
      const store = createStore();
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  describe("deleteAll", () => {
    it("removes all items for the given session", () => {
      const store = createStore();
      store.enqueue("s1", "a");
      store.enqueue("s1", "b");
      store.enqueue("s2", "c");

      store.deleteAll("s1");

      expect(store.list("s1")).toHaveLength(0);
      expect(store.list("s2")).toHaveLength(1);
    });
  });
});
