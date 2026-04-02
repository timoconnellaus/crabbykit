import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDB } from "../index.js";

describe("createDB", () => {
  const originalEnv = process.env.CLAW_DB_BACKEND_ID;

  beforeEach(() => {
    process.env.CLAW_DB_BACKEND_ID = "agent-1:default";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAW_DB_BACKEND_ID;
    } else {
      process.env.CLAW_DB_BACKEND_ID = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it("throws when CLAW_DB_BACKEND_ID is not set and no explicit backendId", () => {
    delete process.env.CLAW_DB_BACKEND_ID;
    expect(() => createDB()).toThrow("CLAW_DB_BACKEND_ID not set");
  });

  it("uses explicit backendId over env var", () => {
    const db = createDB({ backendId: "custom-id" });
    expect(db).toBeDefined();
    expect(db.exec).toBeTypeOf("function");
    expect(db.batch).toBeTypeOf("function");
  });

  it("uses CLAW_DB_BACKEND_ID from env var", () => {
    const db = createDB();
    expect(db).toBeDefined();
  });
});

describe("exec", () => {
  const originalEnv = process.env.CLAW_DB_BACKEND_ID;

  beforeEach(() => {
    process.env.CLAW_DB_BACKEND_ID = "agent-1:default";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAW_DB_BACKEND_ID;
    } else {
      process.env.CLAW_DB_BACKEND_ID = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it("sends POST to db.internal/exec and returns result", async () => {
    const mockResult = { columns: ["id", "name"], rows: [[1, "Item A"]] };
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResult), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const db = createDB();
    const result = await db.exec("SELECT * FROM items");

    expect(result).toEqual(mockResult);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://db.internal/exec",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sql: "SELECT * FROM items", params: [], backendId: "agent-1:default" }),
      }),
    );
  });

  it("sends params in the request", async () => {
    const mockResult = { columns: ["id"], rows: [] };
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResult), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const db = createDB();
    await db.exec("INSERT INTO items (name) VALUES (?)", ["Item A"]);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://db.internal/exec",
      expect.objectContaining({
        body: JSON.stringify({
          sql: "INSERT INTO items (name) VALUES (?)",
          params: ["Item A"],
          backendId: "agent-1:default",
        }),
      }),
    );
  });

  it("throws on server error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Table not found" }), { status: 500 }),
    );
    globalThis.fetch = mockFetch;

    const db = createDB();
    await expect(db.exec("SELECT * FROM nonexistent")).rejects.toThrow("Table not found");
  });

  it("uses explicit backendId in requests", async () => {
    const mockResult = { columns: [], rows: [] };
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResult), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const db = createDB({ backendId: "custom-id" });
    await db.exec("SELECT 1");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://db.internal/exec",
      expect.objectContaining({
        body: expect.stringContaining('"backendId":"custom-id"'),
      }),
    );
  });
});

describe("batch", () => {
  const originalEnv = process.env.CLAW_DB_BACKEND_ID;

  beforeEach(() => {
    process.env.CLAW_DB_BACKEND_ID = "agent-1:default";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAW_DB_BACKEND_ID;
    } else {
      process.env.CLAW_DB_BACKEND_ID = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it("sends POST to db.internal/batch and returns results", async () => {
    const mockResult = { results: [{ columns: [], rows: [] }, { columns: [], rows: [] }] };
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResult), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const db = createDB();
    const statements = [
      { sql: "INSERT INTO items (name) VALUES (?)", params: ["A"] },
      { sql: "INSERT INTO items (name) VALUES (?)", params: ["B"] },
    ];
    const result = await db.batch(statements);

    expect(result).toEqual(mockResult);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://db.internal/batch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ statements, backendId: "agent-1:default" }),
      }),
    );
  });

  it("throws on server error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Batch failed" }), { status: 500 }),
    );
    globalThis.fetch = mockFetch;

    const db = createDB();
    await expect(
      db.batch([{ sql: "INVALID SQL" }]),
    ).rejects.toThrow("Batch failed");
  });
});
