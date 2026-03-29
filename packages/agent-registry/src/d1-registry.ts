import type { AgentRecord, AgentRegistry } from "./types.js";

interface AgentRow {
  id: string;
  name: string;
  owner_id: string;
  parent_agent_id: string | null;
  status: string;
  created_at: string;
}

function isAgentRow(row: unknown): row is AgentRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.owner_id === "string" &&
    (r.parent_agent_id === null || typeof r.parent_agent_id === "string") &&
    typeof r.status === "string" &&
    typeof r.created_at === "string"
  );
}

function rowToRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    parentAgentId: row.parent_agent_id,
    status: row.status as AgentRecord["status"],
    createdAt: row.created_at,
  };
}

export class D1AgentRegistry implements AgentRegistry {
  private initialized = false;

  constructor(private db: D1Database) {}

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    await this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, parent_agent_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')))",
      )
      .run();
    await this.db.prepare("CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id)").run();
    this.initialized = true;
  }

  async list(ownerId: string): Promise<AgentRecord[]> {
    await this.ensureTable();
    const result = await this.db
      .prepare(
        "SELECT id, name, owner_id, parent_agent_id, status, created_at FROM agents WHERE owner_id = ? AND status = 'active'",
      )
      .bind(ownerId)
      .all();

    const records: AgentRecord[] = [];
    for (const row of result.results) {
      if (isAgentRow(row)) {
        records.push(rowToRecord(row));
      }
    }
    return records;
  }

  async get(agentId: string): Promise<AgentRecord | null> {
    await this.ensureTable();
    const row = await this.db
      .prepare(
        "SELECT id, name, owner_id, parent_agent_id, status, created_at FROM agents WHERE id = ? AND status = 'active'",
      )
      .bind(agentId)
      .first();

    if (!isAgentRow(row)) return null;
    return rowToRecord(row);
  }

  async create(record: Omit<AgentRecord, "createdAt" | "status">): Promise<AgentRecord> {
    await this.ensureTable();
    await this.db
      .prepare("INSERT INTO agents (id, name, owner_id, parent_agent_id) VALUES (?, ?, ?, ?)")
      .bind(record.id, record.name, record.ownerId, record.parentAgentId)
      .run();

    const row = await this.db
      .prepare(
        "SELECT id, name, owner_id, parent_agent_id, status, created_at FROM agents WHERE id = ?",
      )
      .bind(record.id)
      .first();

    if (!isAgentRow(row)) {
      throw new Error(`Failed to read back created agent ${record.id}`);
    }
    return rowToRecord(row);
  }

  async delete(agentId: string): Promise<void> {
    await this.ensureTable();
    await this.db.prepare("UPDATE agents SET status = 'deleted' WHERE id = ?").bind(agentId).run();
  }

  async getRelationship(
    agentIdA: string,
    agentIdB: string,
  ): Promise<"parent" | "child" | "sibling" | null> {
    await this.ensureTable();

    const stmt = this.db.prepare(
      "SELECT id, name, owner_id, parent_agent_id, status, created_at FROM agents WHERE id = ? AND status = 'active'",
    );
    const [resultA, resultB] = await this.db.batch([stmt.bind(agentIdA), stmt.bind(agentIdB)]);

    const rowA = (resultA as D1Result).results[0];
    const rowB = (resultB as D1Result).results[0];

    if (!isAgentRow(rowA) || !isAgentRow(rowB)) return null;

    if (rowA.parent_agent_id === rowB.id) return "child";
    if (rowB.parent_agent_id === rowA.id) return "parent";
    if (rowA.owner_id === rowB.owner_id) return "sibling";

    return null;
  }
}
