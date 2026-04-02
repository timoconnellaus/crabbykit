import type { SkillRecord, SkillRegistry, SkillSeed } from "./types.js";

const MAX_DESCRIPTION_LENGTH = 250;

interface SkillRow {
  id: string;
  name: string;
  description: string;
  version: string;
  content_hash: string;
  requires_capabilities: string;
  skill_md: string;
  created_at: string;
  updated_at: string;
}

function isSkillRow(row: unknown): row is SkillRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.description === "string" &&
    typeof r.version === "string" &&
    typeof r.content_hash === "string" &&
    typeof r.requires_capabilities === "string" &&
    typeof r.skill_md === "string" &&
    typeof r.created_at === "string" &&
    typeof r.updated_at === "string"
  );
}

function rowToRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    contentHash: row.content_hash,
    requiresCapabilities: JSON.parse(row.requires_capabilities) as string[],
    skillMd: row.skill_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function computeHash(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

export interface D1SkillRegistryOptions {
  /** Skill definitions to seed on startup. Idempotent — unchanged seeds are skipped. */
  seeds?: SkillSeed[];
}

export class D1SkillRegistry implements SkillRegistry {
  private initialized = false;
  private seeds: SkillSeed[];

  constructor(private db: D1Database, options?: D1SkillRegistryOptions) {
    this.seeds = options?.seeds ?? [];
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    await this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, version TEXT NOT NULL, content_hash TEXT NOT NULL, requires_capabilities TEXT NOT NULL DEFAULT '[]', skill_md TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      )
      .run();
    this.initialized = true;

    if (this.seeds.length > 0) {
      await this.applySeedsOnce();
    }
  }

  private async applySeedsOnce(): Promise<void> {
    for (const seed of this.seeds) {
      const newHash = await computeHash(seed.skillMd);
      const existing = await this.db
        .prepare("SELECT content_hash, version FROM skills WHERE id = ?")
        .bind(seed.id)
        .first();

      const existingHash = existing ? (existing as { content_hash: string }).content_hash : null;
      const existingVersion = existing ? (existing as { version: string }).version : null;

      if (existingHash === newHash && existingVersion === seed.version) {
        continue; // Unchanged — skip
      }

      if (existingHash === newHash && existingVersion !== seed.version) {
        // Content unchanged but version differs — update metadata only
        await this.db
          .prepare("UPDATE skills SET version = ?, name = ?, description = ?, updated_at = ? WHERE id = ?")
          .bind(seed.version, seed.name, seed.description, new Date().toISOString(), seed.id)
          .run();
        continue;
      }

      // Insert or update
      const now = new Date().toISOString();
      const requiresCaps = JSON.stringify(seed.requiresCapabilities);
      await this.db
        .prepare(
          "INSERT INTO skills (id, name, description, version, content_hash, requires_capabilities, skill_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, version = excluded.version, content_hash = excluded.content_hash, requires_capabilities = excluded.requires_capabilities, skill_md = excluded.skill_md, updated_at = excluded.updated_at",
        )
        .bind(seed.id, seed.name, seed.description, seed.version, newHash, requiresCaps, seed.skillMd, now, now)
        .run();
    }
  }

  async list(): Promise<SkillRecord[]> {
    await this.ensureTable();
    const result = await this.db
      .prepare(
        "SELECT id, name, description, version, content_hash, requires_capabilities, skill_md, created_at, updated_at FROM skills",
      )
      .all();

    const records: SkillRecord[] = [];
    for (const row of result.results) {
      if (isSkillRow(row)) {
        records.push(rowToRecord(row));
      }
    }
    return records;
  }

  async get(id: string): Promise<SkillRecord | null> {
    await this.ensureTable();
    const row = await this.db
      .prepare(
        "SELECT id, name, description, version, content_hash, requires_capabilities, skill_md, created_at, updated_at FROM skills WHERE id = ?",
      )
      .bind(id)
      .first();

    if (!isSkillRow(row)) return null;
    return rowToRecord(row);
  }

  async getVersion(id: string): Promise<{ version: string; contentHash: string } | null> {
    await this.ensureTable();
    const row = await this.db
      .prepare("SELECT version, content_hash FROM skills WHERE id = ?")
      .bind(id)
      .first();

    if (!row || typeof row.version !== "string" || typeof row.content_hash !== "string") {
      return null;
    }
    return { version: row.version as string, contentHash: row.content_hash as string };
  }

  async upsert(
    skill: Omit<SkillRecord, "contentHash" | "createdAt" | "updatedAt">,
  ): Promise<void> {
    if (skill.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `Skill description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${skill.description.length} chars)`,
      );
    }

    await this.ensureTable();
    const now = new Date().toISOString();
    const contentHash = await computeHash(skill.skillMd);
    const requiresCaps = JSON.stringify(skill.requiresCapabilities);

    await this.db
      .prepare(
        "INSERT INTO skills (id, name, description, version, content_hash, requires_capabilities, skill_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, version = excluded.version, content_hash = excluded.content_hash, requires_capabilities = excluded.requires_capabilities, skill_md = excluded.skill_md, updated_at = excluded.updated_at",
      )
      .bind(
        skill.id,
        skill.name,
        skill.description,
        skill.version,
        contentHash,
        requiresCaps,
        skill.skillMd,
        now,
        now,
      )
      .run();
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureTable();
    const result = await this.db.prepare("DELETE FROM skills WHERE id = ?").bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
