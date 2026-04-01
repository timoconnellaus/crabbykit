import { describe, expect, it } from "vitest";
import { BackendStorage } from "../backend-storage-do.js";

/** Create a BackendStorage instance with a mock sql storage. */
function createStorage() {
  const rows: unknown[][] = [];
  const columnNames: string[] = [];

  const mockSql = {
    exec: (sql: string, ..._params: unknown[]) => {
      // Simple mock that tracks calls and returns configured data
      if (sql.startsWith("SELECT")) {
        return { columnNames, raw: () => rows[Symbol.iterator]() };
      }
      if (sql.startsWith("CREATE") || sql.startsWith("INSERT") || sql.startsWith("DELETE")) {
        return { columnNames: [], raw: () => [][Symbol.iterator]() };
      }
      return { columnNames, raw: () => rows[Symbol.iterator]() };
    },
  };

  const ctx = {
    id: { name: "test-agent", toString: () => "test-hex-id" },
    storage: { sql: mockSql },
  };

  const storage = new BackendStorage(ctx as any, {} as any);

  return {
    storage,
    setResult: (cols: string[], data: unknown[][]) => {
      columnNames.length = 0;
      columnNames.push(...cols);
      rows.length = 0;
      rows.push(...data);
    },
    mockSql,
  };
}

function jsonRequest(path: string, body: unknown, method = "POST"): Request {
  return new Request(`http://do${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("BackendStorage", () => {
  describe("POST /exec", () => {
    it("executes SQL and returns columns + rows", async () => {
      const { storage, setResult } = createStorage();
      setResult(
        ["id", "name"],
        [
          [1, "Alice"],
          [2, "Bob"],
        ],
      );

      const response = await storage.fetch(
        jsonRequest("/exec", {
          sql: "SELECT id, name FROM users",
          params: [],
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        columns: ["id", "name"],
        rows: [
          [1, "Alice"],
          [2, "Bob"],
        ],
      });
    });

    it("defaults params to empty array when omitted", async () => {
      const { storage, setResult, mockSql } = createStorage();
      setResult([], []);

      const execSpy = vi.spyOn(mockSql, "exec");
      await storage.fetch(jsonRequest("/exec", { sql: "CREATE TABLE t (id INT)" }));

      expect(execSpy).toHaveBeenCalledWith("CREATE TABLE t (id INT)");
    });

    it("passes params to sql.exec", async () => {
      const { storage, setResult, mockSql } = createStorage();
      setResult(["id"], [[42]]);

      const execSpy = vi.spyOn(mockSql, "exec");
      await storage.fetch(
        jsonRequest("/exec", {
          sql: "SELECT id FROM users WHERE name = ?",
          params: ["Alice"],
        }),
      );

      expect(execSpy).toHaveBeenCalledWith("SELECT id FROM users WHERE name = ?", "Alice");
    });

    it("returns 400 with error message on SQL failure", async () => {
      const { storage, mockSql } = createStorage();
      vi.spyOn(mockSql, "exec").mockImplementation(() => {
        throw new Error("no such table: users");
      });

      const response = await storage.fetch(
        jsonRequest("/exec", {
          sql: "SELECT * FROM users",
        }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("no such table");
    });
  });

  describe("POST /batch", () => {
    it("executes multiple statements and returns array of results", async () => {
      const { storage, mockSql } = createStorage();
      let callCount = 0;
      vi.spyOn(mockSql, "exec").mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { columnNames: [], raw: () => [][Symbol.iterator]() };
        }
        return {
          columnNames: ["count"],
          raw: () => [[5]][Symbol.iterator](),
        };
      });

      const response = await storage.fetch(
        jsonRequest("/batch", {
          statements: [
            { sql: "INSERT INTO items (name) VALUES (?)", params: ["Widget"] },
            { sql: "SELECT count(*) as count FROM items" },
          ],
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toEqual({ columns: [], rows: [] });
      expect(body.results[1]).toEqual({ columns: ["count"], rows: [[5]] });
    });

    it("returns 400 if any statement fails", async () => {
      const { storage, mockSql } = createStorage();
      let callCount = 0;
      vi.spyOn(mockSql, "exec").mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error("constraint failed");
        return { columnNames: [], raw: () => [][Symbol.iterator]() };
      });

      const response = await storage.fetch(
        jsonRequest("/batch", {
          statements: [
            { sql: "INSERT INTO items (name) VALUES ('ok')" },
            { sql: "INSERT INTO items (name) VALUES (null)" },
          ],
        }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("constraint failed");
    });

    it("defaults statement params to empty array", async () => {
      const { storage, mockSql } = createStorage();
      const execSpy = vi.spyOn(mockSql, "exec").mockReturnValue({
        columnNames: [],
        raw: () => [][Symbol.iterator](),
      });

      await storage.fetch(
        jsonRequest("/batch", {
          statements: [{ sql: "DELETE FROM items" }],
        }),
      );

      expect(execSpy).toHaveBeenCalledWith("DELETE FROM items");
    });
  });

  describe("HTTP method and path handling", () => {
    it("returns 405 for non-POST requests", async () => {
      const { storage } = createStorage();
      const response = await storage.fetch(new Request("http://do/exec", { method: "GET" }));
      expect(response.status).toBe(405);
    });

    it("returns 404 for unknown paths", async () => {
      const { storage } = createStorage();
      const response = await storage.fetch(jsonRequest("/unknown", {}));
      expect(response.status).toBe(404);
    });
  });
});
