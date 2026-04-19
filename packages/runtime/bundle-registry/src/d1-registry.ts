/**
 * D1BundleRegistry — D1-backed bundle registry with KV bytes storage.
 *
 * Content-addressed version IDs (SHA-256 hex). Self-seeding migration.
 * D1 batch atomicity for multi-statement operations.
 * KV readback verification on deploy.
 */

import { CapabilityMismatchError } from "@crabbykit/agent-runtime";
import { computeVersionId } from "./hash.js";
import { verifyKvReadback } from "./readback.js";
import type {
  AgentBundle,
  BundleDeployment,
  BundleMetadata,
  BundleRegistry,
  BundleVersion,
  CreateVersionOpts,
  SetActiveOptions,
} from "./types.js";
import {
  MAX_BUNDLE_SIZE_BYTES,
  METADATA_CAPABILITY_IDS_MAX,
  METADATA_DESCRIPTION_MAX,
  METADATA_KEYS,
  METADATA_STRING_MAX,
} from "./types.js";
import { validateCatalogAgainstKnownIds } from "./validate.js";

export class D1BundleRegistry implements BundleRegistry {
  private readonly db: D1Database;
  private readonly kv: KVNamespace;
  private initialized = false;

  constructor(db: D1Database, kv: KVNamespace) {
    this.db = db;
    this.kv = kv;
  }

  // --- Self-seeding migration ---

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;

    await this.db.batch([
      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS bundle_versions (
					version_id TEXT PRIMARY KEY,
					kv_key TEXT NOT NULL,
					size_bytes INTEGER NOT NULL,
					created_at INTEGER NOT NULL,
					created_by TEXT,
					metadata TEXT
				)`,
      ),
      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS agent_bundles (
					agent_id TEXT PRIMARY KEY,
					active_version_id TEXT,
					previous_version_id TEXT,
					updated_at INTEGER NOT NULL
				)`,
      ),
      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS bundle_deployments (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					agent_id TEXT NOT NULL,
					version_id TEXT,
					deployed_at INTEGER NOT NULL,
					deployed_by_session_id TEXT,
					rationale TEXT
				)`,
      ),
      this.db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_deployments_agent
				ON bundle_deployments(agent_id, deployed_at DESC)`,
      ),
    ]);

    this.initialized = true;
  }

  // --- BundleRegistry interface ---

  async getActiveForAgent(agentId: string): Promise<string | null> {
    await this.ensureTable();
    const row = await this.db
      .prepare("SELECT active_version_id FROM agent_bundles WHERE agent_id = ?")
      .bind(agentId)
      .first<{ active_version_id: string | null }>();
    return row?.active_version_id ?? null;
  }

  async setActive(
    agentId: string,
    versionId: string | null,
    options?: SetActiveOptions,
  ): Promise<void> {
    await this.ensureTable();

    // Catalog validation runs BEFORE the D1 batch so a mismatch cannot
    // leave the registry in a partially-flipped state.
    if (versionId !== null) {
      const version = await this.getVersion(versionId);
      const requiredCapabilities = version?.metadata?.requiredCapabilities;

      // Reserved-scope rejection: "spine" and "llm" cannot be used as
      // capability ids — they are reserved for the two non-negotiable
      // bundle→host channels and are unconditionally prepended to every
      // minted token's scope array. This check runs independently of
      // skipCatalogCheck — bypassing known-id validation does not opt out
      // of reserved-string rejection.
      if (requiredCapabilities && requiredCapabilities.length > 0) {
        const RESERVED = new Set(["spine", "llm"]);
        for (const req of requiredCapabilities) {
          if (req && typeof req.id === "string" && RESERVED.has(req.id)) {
            throw new TypeError(
              `BundleRegistry.setActive: capability id "${req.id}" is a reserved scope string and cannot be used as a capability id — the dispatcher unconditionally grants this scope to all bundles`,
            );
          }
        }
      }

      if (options?.skipCatalogCheck !== true) {
        if (options?.knownCapabilityIds === undefined) {
          throw new TypeError(
            "BundleRegistry.setActive: knownCapabilityIds is required when skipCatalogCheck is not true",
          );
        }
        const result = validateCatalogAgainstKnownIds(
          requiredCapabilities,
          new Set(options.knownCapabilityIds),
        );
        if (!result.valid) {
          throw new CapabilityMismatchError({
            missingIds: result.missingIds,
            versionId,
          });
        }
      }
    }

    const now = Date.now();

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO agent_bundles (agent_id, active_version_id, previous_version_id, updated_at)
					VALUES (?, ?, (SELECT active_version_id FROM agent_bundles WHERE agent_id = ?), ?)
					ON CONFLICT(agent_id) DO UPDATE SET
						previous_version_id = agent_bundles.active_version_id,
						active_version_id = excluded.active_version_id,
						updated_at = excluded.updated_at`,
        )
        .bind(agentId, versionId, agentId, now),
      this.db
        .prepare(
          `INSERT INTO bundle_deployments (agent_id, version_id, deployed_at, deployed_by_session_id, rationale)
					VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(agentId, versionId, now, options?.sessionId ?? null, options?.rationale ?? null),
    ]);
  }

  async getBytes(versionId: string): Promise<ArrayBuffer | null> {
    const key = `bundle:${versionId}`;
    return this.kv.get(key, "arrayBuffer");
  }

  // --- Extended registry methods ---

  async createVersion(opts: CreateVersionOpts): Promise<BundleVersion> {
    await this.ensureTable();

    // Size check
    if (opts.bytes.byteLength > MAX_BUNDLE_SIZE_BYTES) {
      throw new Error(
        `Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES} byte limit (got ${opts.bytes.byteLength})`,
      );
    }

    // Compute content-addressed version ID
    const versionId = await computeVersionId(opts.bytes);
    const kvKey = `bundle:${versionId}`;

    // Check if this exact version already exists
    const existing = await this.db
      .prepare("SELECT version_id FROM bundle_versions WHERE version_id = ?")
      .bind(versionId)
      .first();
    if (existing) {
      // Content-addressed dedup — same bytes = same version
      return this.getVersion(versionId) as Promise<BundleVersion>;
    }

    // Validate and sanitize metadata
    const metadata = opts.metadata ? sanitizeMetadata(opts.metadata) : null;

    // Write bytes to KV
    await this.kv.put(kvKey, opts.bytes);

    // Readback verification
    await this.verifyReadback(kvKey);

    // Insert version row in D1
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO bundle_versions (version_id, kv_key, size_bytes, created_at, created_by, metadata)
				VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        kvKey,
        opts.bytes.byteLength,
        now,
        opts.createdBy ?? null,
        metadata ? JSON.stringify(metadata) : null,
      )
      .run();

    return {
      versionId,
      kvKey,
      sizeBytes: opts.bytes.byteLength,
      createdAt: now,
      createdBy: opts.createdBy ?? null,
      metadata,
    };
  }

  async getVersion(versionId: string): Promise<BundleVersion | null> {
    await this.ensureTable();
    const row = await this.db
      .prepare("SELECT * FROM bundle_versions WHERE version_id = ?")
      .bind(versionId)
      .first<{
        version_id: string;
        kv_key: string;
        size_bytes: number;
        created_at: number;
        created_by: string | null;
        metadata: string | null;
      }>();

    if (!row) return null;

    return {
      versionId: row.version_id,
      kvKey: row.kv_key,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      createdBy: row.created_by,
      metadata: row.metadata ? (JSON.parse(row.metadata) as BundleMetadata) : null,
    };
  }

  async rollback(
    agentId: string,
    opts?: { rationale?: string; sessionId?: string },
  ): Promise<void> {
    await this.ensureTable();

    const current = await this.db
      .prepare(
        "SELECT active_version_id, previous_version_id FROM agent_bundles WHERE agent_id = ?",
      )
      .bind(agentId)
      .first<{ active_version_id: string | null; previous_version_id: string | null }>();

    if (!current?.previous_version_id) {
      throw new Error("No previous version to roll back to");
    }

    const now = Date.now();

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE agent_bundles SET
						active_version_id = ?,
						previous_version_id = ?,
						updated_at = ?
					WHERE agent_id = ?`,
        )
        .bind(current.previous_version_id, current.active_version_id, now, agentId),
      this.db
        .prepare(
          `INSERT INTO bundle_deployments (agent_id, version_id, deployed_at, deployed_by_session_id, rationale)
					VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          agentId,
          current.previous_version_id,
          now,
          opts?.sessionId ?? null,
          opts?.rationale ?? "rollback",
        ),
    ]);
  }

  async listDeployments(agentId: string, limit = 20): Promise<BundleDeployment[]> {
    await this.ensureTable();
    const capped = Math.min(limit, 100);

    const { results } = await this.db
      .prepare(
        `SELECT d.*, v.metadata
				FROM bundle_deployments d
				LEFT JOIN bundle_versions v ON d.version_id = v.version_id
				WHERE d.agent_id = ?
				ORDER BY d.deployed_at DESC
				LIMIT ?`,
      )
      .bind(agentId, capped)
      .all<{
        id: number;
        agent_id: string;
        version_id: string | null;
        deployed_at: number;
        deployed_by_session_id: string | null;
        rationale: string | null;
      }>();

    return results.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      versionId: row.version_id,
      deployedAt: row.deployed_at,
      deployedBySessionId: row.deployed_by_session_id,
      rationale: row.rationale,
    }));
  }

  async getAgentBundle(agentId: string): Promise<AgentBundle | null> {
    await this.ensureTable();
    const row = await this.db
      .prepare("SELECT * FROM agent_bundles WHERE agent_id = ?")
      .bind(agentId)
      .first<{
        agent_id: string;
        active_version_id: string | null;
        previous_version_id: string | null;
        updated_at: number;
      }>();

    if (!row) return null;

    return {
      agentId: row.agent_id,
      activeVersionId: row.active_version_id,
      previousVersionId: row.previous_version_id,
      updatedAt: row.updated_at,
    };
  }

  // --- KV readback verification ---

  private async verifyReadback(key: string): Promise<void> {
    await verifyKvReadback(this.kv, key);
  }
}

// --- Helpers ---

function sanitizeMetadata(raw: BundleMetadata): BundleMetadata {
  const result: BundleMetadata = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!METADATA_KEYS.has(key)) continue;

    if (key === "capabilityIds") {
      if (Array.isArray(value)) {
        result.capabilityIds = value
          .slice(0, METADATA_CAPABILITY_IDS_MAX)
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.slice(0, METADATA_STRING_MAX));
      }
    } else if (key === "requiredCapabilities") {
      if (Array.isArray(value)) {
        const sanitized: Array<{ id: string }> = [];
        for (const entry of value.slice(0, METADATA_CAPABILITY_IDS_MAX)) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const id = (entry as { id?: unknown }).id;
            if (typeof id === "string" && id.length > 0) {
              sanitized.push({ id: id.slice(0, METADATA_STRING_MAX) });
            }
          }
        }
        if (sanitized.length > 0) {
          result.requiredCapabilities = sanitized;
        }
      }
    } else if (key === "buildTimestamp") {
      if (typeof value === "number") {
        result.buildTimestamp = value;
      }
    } else if (key === "description") {
      if (typeof value === "string") {
        result.description = value.slice(0, METADATA_DESCRIPTION_MAX);
      }
    } else {
      if (typeof value === "string") {
        (result as Record<string, unknown>)[key] = value.slice(0, METADATA_STRING_MAX);
      }
    }
  }

  return result;
}
