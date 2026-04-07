import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { D1AgentRegistry } from "../d1-registry.js";

// ---------------------------------------------------------------------------
// Fresh registry per test — drop the agents table to reset state
// ---------------------------------------------------------------------------

let registry: D1AgentRegistry;

beforeEach(async () => {
  // Drop table if it exists so each test starts clean
  await env.AGENT_DB.prepare("DROP TABLE IF EXISTS agents").run();
  registry = new D1AgentRegistry(env.AGENT_DB);
});

// ---------------------------------------------------------------------------
// ensureTable / lazy initialization
// ---------------------------------------------------------------------------

describe("ensureTable", () => {
  it("creates the agents table on first operation", async () => {
    // No table exists yet — list should succeed (triggers ensureTable)
    const records = await registry.list("owner-1");
    expect(records).toEqual([]);

    // Verify the table was actually created
    const tables = await env.AGENT_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'",
    ).first();
    expect(tables).not.toBeNull();
  });

  it("creates the owner_id index", async () => {
    await registry.list("owner-1"); // triggers ensureTable

    const idx = await env.AGENT_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agents_owner'",
    ).first();
    expect(idx).not.toBeNull();
  });

  it("only runs initialization once (idempotent)", async () => {
    // Two operations — second should skip CREATE TABLE
    await registry.list("a");
    await registry.list("b");
    // No error means the guard worked
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  it("creates a record and returns it with server-generated fields", async () => {
    const result = await registry.create({
      id: "agent-1",
      name: "Test Agent",
      ownerId: "owner-1",
      parentAgentId: null,
    });

    expect(result.id).toBe("agent-1");
    expect(result.name).toBe("Test Agent");
    expect(result.ownerId).toBe("owner-1");
    expect(result.parentAgentId).toBeNull();
    expect(result.status).toBe("active");
    expect(result.createdAt).toBeTruthy();
  });

  it("creates a record with a parent agent ID", async () => {
    const result = await registry.create({
      id: "child-1",
      name: "Child Agent",
      ownerId: "owner-1",
      parentAgentId: "parent-1",
    });

    expect(result.parentAgentId).toBe("parent-1");
  });

  it("rejects duplicate IDs", async () => {
    await registry.create({
      id: "dup-1",
      name: "First",
      ownerId: "owner-1",
      parentAgentId: null,
    });

    await expect(
      registry.create({
        id: "dup-1",
        name: "Second",
        ownerId: "owner-1",
        parentAgentId: null,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
  it("returns a record by ID", async () => {
    await registry.create({
      id: "agent-1",
      name: "Test Agent",
      ownerId: "owner-1",
      parentAgentId: null,
    });

    const result = await registry.get("agent-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("agent-1");
    expect(result!.name).toBe("Test Agent");
  });

  it("returns null for non-existent ID", async () => {
    const result = await registry.get("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for deleted agents", async () => {
    await registry.create({
      id: "agent-1",
      name: "Test Agent",
      ownerId: "owner-1",
      parentAgentId: null,
    });
    await registry.delete("agent-1");

    const result = await registry.get("agent-1");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("returns empty array when no agents exist", async () => {
    const result = await registry.list("owner-1");
    expect(result).toEqual([]);
  });

  it("returns only agents for the specified owner", async () => {
    await registry.create({ id: "a1", name: "Agent 1", ownerId: "owner-1", parentAgentId: null });
    await registry.create({ id: "a2", name: "Agent 2", ownerId: "owner-2", parentAgentId: null });
    await registry.create({ id: "a3", name: "Agent 3", ownerId: "owner-1", parentAgentId: null });

    const result = await registry.list("owner-1");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["a1", "a3"]);
  });

  it("excludes deleted agents", async () => {
    await registry.create({ id: "a1", name: "Agent 1", ownerId: "owner-1", parentAgentId: null });
    await registry.create({ id: "a2", name: "Agent 2", ownerId: "owner-1", parentAgentId: null });
    await registry.delete("a1");

    const result = await registry.list("owner-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a2");
  });

  it("returns all rows when all pass type guard validation", async () => {
    await registry.create({ id: "a1", name: "First", ownerId: "owner-1", parentAgentId: null });
    await registry.create({ id: "a2", name: "Second", ownerId: "owner-1", parentAgentId: "a1" });

    const result = await registry.list("owner-1");
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// delete (soft delete)
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("soft-deletes an agent by setting status to deleted", async () => {
    await registry.create({ id: "agent-1", name: "Test", ownerId: "owner-1", parentAgentId: null });
    await registry.delete("agent-1");

    // Verify via direct SQL that the row still exists
    const row = await env.AGENT_DB.prepare("SELECT status FROM agents WHERE id = ?")
      .bind("agent-1")
      .first();
    expect(row).not.toBeNull();
    expect((row as { status: string }).status).toBe("deleted");
  });

  it("is idempotent — deleting a non-existent agent does not throw", async () => {
    // Should not throw
    await registry.delete("nonexistent");
  });

  it("is idempotent — deleting an already-deleted agent does not throw", async () => {
    await registry.create({ id: "agent-1", name: "Test", ownerId: "owner-1", parentAgentId: null });
    await registry.delete("agent-1");
    await registry.delete("agent-1");
  });
});

// ---------------------------------------------------------------------------
// getRelationship
// ---------------------------------------------------------------------------

describe("getRelationship", () => {
  it("returns 'parent' when A is the parent of B", async () => {
    await registry.create({
      id: "parent",
      name: "Parent",
      ownerId: "owner-1",
      parentAgentId: null,
    });
    await registry.create({
      id: "child",
      name: "Child",
      ownerId: "owner-1",
      parentAgentId: "parent",
    });

    const rel = await registry.getRelationship("parent", "child");
    expect(rel).toBe("parent");
  });

  it("returns 'child' when A is a child of B", async () => {
    await registry.create({
      id: "parent",
      name: "Parent",
      ownerId: "owner-1",
      parentAgentId: null,
    });
    await registry.create({
      id: "child",
      name: "Child",
      ownerId: "owner-1",
      parentAgentId: "parent",
    });

    const rel = await registry.getRelationship("child", "parent");
    expect(rel).toBe("child");
  });

  it("returns 'sibling' when A and B share the same owner but no parent relationship", async () => {
    await registry.create({
      id: "sib-1",
      name: "Sibling 1",
      ownerId: "owner-1",
      parentAgentId: null,
    });
    await registry.create({
      id: "sib-2",
      name: "Sibling 2",
      ownerId: "owner-1",
      parentAgentId: null,
    });

    const rel = await registry.getRelationship("sib-1", "sib-2");
    expect(rel).toBe("sibling");
  });

  it("returns null when agents have different owners and no parent relationship", async () => {
    await registry.create({ id: "a1", name: "Agent 1", ownerId: "owner-1", parentAgentId: null });
    await registry.create({ id: "a2", name: "Agent 2", ownerId: "owner-2", parentAgentId: null });

    const rel = await registry.getRelationship("a1", "a2");
    expect(rel).toBeNull();
  });

  it("returns null when agent A does not exist", async () => {
    await registry.create({ id: "a1", name: "Agent 1", ownerId: "owner-1", parentAgentId: null });

    const rel = await registry.getRelationship("nonexistent", "a1");
    expect(rel).toBeNull();
  });

  it("returns null when agent B does not exist", async () => {
    await registry.create({ id: "a1", name: "Agent 1", ownerId: "owner-1", parentAgentId: null });

    const rel = await registry.getRelationship("a1", "nonexistent");
    expect(rel).toBeNull();
  });

  it("returns null when both agents do not exist", async () => {
    const rel = await registry.getRelationship("ghost-a", "ghost-b");
    expect(rel).toBeNull();
  });

  it("returns null when one agent is deleted", async () => {
    await registry.create({ id: "a1", name: "Agent 1", ownerId: "owner-1", parentAgentId: null });
    await registry.create({ id: "a2", name: "Agent 2", ownerId: "owner-1", parentAgentId: null });
    await registry.delete("a1");

    const rel = await registry.getRelationship("a1", "a2");
    expect(rel).toBeNull();
  });

  it("prioritizes parent/child over sibling when both apply", async () => {
    // Parent and child share the same owner — parent/child should take priority
    await registry.create({
      id: "parent",
      name: "Parent",
      ownerId: "owner-1",
      parentAgentId: null,
    });
    await registry.create({
      id: "child",
      name: "Child",
      ownerId: "owner-1",
      parentAgentId: "parent",
    });

    const rel = await registry.getRelationship("parent", "child");
    expect(rel).toBe("parent");

    const relReverse = await registry.getRelationship("child", "parent");
    expect(relReverse).toBe("child");
  });
});

// ---------------------------------------------------------------------------
// isAgentRow type guard (tested indirectly)
// ---------------------------------------------------------------------------

describe("isAgentRow type guard", () => {
  it("rejects null from D1 first() (get on missing row)", async () => {
    const result = await registry.get("missing");
    expect(result).toBeNull();
  });

  it("handles rows where all fields have correct types", async () => {
    // Trigger ensureTable first
    await registry.list("owner-1");

    // Insert a well-formed row directly via SQL
    await env.AGENT_DB.prepare(
      "INSERT INTO agents (id, name, owner_id, parent_agent_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("direct-insert", "Direct", "owner-1", null, "active", "2026-01-01T00:00:00Z")
      .run();

    const results = await registry.list("owner-1");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("direct-insert");
    expect(results[0].parentAgentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rowToRecord mapping
// ---------------------------------------------------------------------------

describe("rowToRecord mapping", () => {
  it("maps snake_case DB columns to camelCase record fields", async () => {
    const created = await registry.create({
      id: "map-test",
      name: "Mapper",
      ownerId: "owner-x",
      parentAgentId: "parent-x",
    });

    expect(created).toMatchObject({
      id: "map-test",
      name: "Mapper",
      ownerId: "owner-x",
      parentAgentId: "parent-x",
      status: "active",
    });
    // createdAt should be a date string
    expect(typeof created.createdAt).toBe("string");
    expect(created.createdAt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-method integration
// ---------------------------------------------------------------------------

describe("integration", () => {
  it("full lifecycle: create → get → list → delete → verify gone", async () => {
    const created = await registry.create({
      id: "lifecycle-1",
      name: "Lifecycle Agent",
      ownerId: "owner-1",
      parentAgentId: null,
    });
    expect(created.status).toBe("active");

    const fetched = await registry.get("lifecycle-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Lifecycle Agent");

    const listed = await registry.list("owner-1");
    expect(listed).toHaveLength(1);

    await registry.delete("lifecycle-1");

    expect(await registry.get("lifecycle-1")).toBeNull();
    expect(await registry.list("owner-1")).toHaveLength(0);
  });

  it("multiple registries share the same D1 database", async () => {
    const registry2 = new D1AgentRegistry(env.AGENT_DB);

    await registry.create({ id: "shared-1", name: "Shared", ownerId: "o1", parentAgentId: null });

    const result = await registry2.get("shared-1");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Shared");
  });
});
