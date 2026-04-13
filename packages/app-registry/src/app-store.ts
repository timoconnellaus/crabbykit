import type { SqlStore } from "@claw-for-cloudflare/agent-runtime";
import { nanoid } from "nanoid";
import type { AppRecord, AppVersion } from "./types.js";

/**
 * App registry store backed by SQL storage.
 * Manages persistent app records and version history.
 */
export class AppStore {
  private sql: SqlStore;

  constructor(sql: SqlStore) {
    this.sql = sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        current_version INTEGER NOT NULL DEFAULT 0,
        has_backend INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_slug ON apps(slug)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS app_versions (
        app_id TEXT NOT NULL REFERENCES apps(id),
        version INTEGER NOT NULL,
        deploy_id TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        message TEXT,
        files TEXT,
        has_backend INTEGER NOT NULL DEFAULT 0,
        deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (app_id, version)
      )
    `);
  }

  create(name: string, slug: string): AppRecord {
    const id = nanoid();
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO apps (id, name, slug, current_version, has_backend, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      slug,
      0,
      0,
      now,
      now,
    );

    // biome-ignore lint/style/noNonNullAssertion: row was just inserted
    return this.get(id)!;
  }

  get(id: string): AppRecord | null {
    const rows = [...this.sql.exec("SELECT * FROM apps WHERE id = ? LIMIT 1", id)];
    return rows.length > 0 ? rowToApp(rows[0]) : null;
  }

  getBySlug(slug: string): AppRecord | null {
    const rows = [...this.sql.exec("SELECT * FROM apps WHERE slug = ? LIMIT 1", slug)];
    return rows.length > 0 ? rowToApp(rows[0]) : null;
  }

  list(): AppRecord[] {
    const cursor = this.sql.exec("SELECT * FROM apps ORDER BY updated_at DESC");
    return [...cursor].map(rowToApp);
  }

  update(
    id: string,
    updates: Partial<{
      name: string;
      currentVersion: number;
      hasBackend: boolean;
    }>,
  ): AppRecord | null {
    const existing = this.get(id);
    if (!existing) return null;

    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      values.push(updates.name);
    }
    if (updates.currentVersion !== undefined) {
      setClauses.push("current_version = ?");
      values.push(updates.currentVersion);
    }
    if (updates.hasBackend !== undefined) {
      setClauses.push("has_backend = ?");
      values.push(updates.hasBackend ? 1 : 0);
    }

    values.push(id);
    this.sql.exec(`UPDATE apps SET ${setClauses.join(", ")} WHERE id = ?`, ...values);

    return this.get(id);
  }

  delete(id: string): void {
    this.sql.exec("DELETE FROM app_versions WHERE app_id = ?", id);
    this.sql.exec("DELETE FROM apps WHERE id = ?", id);
  }

  addVersion(
    appId: string,
    config: {
      deployId: string;
      commitHash: string;
      message?: string | null;
      files: string[];
      hasBackend: boolean;
    },
  ): AppVersion | null {
    const app = this.get(appId);
    if (!app) return null;

    const version = app.currentVersion + 1;
    const now = new Date().toISOString();
    const filesJson = JSON.stringify(config.files);

    this.sql.exec(
      `INSERT INTO app_versions (app_id, version, deploy_id, commit_hash, message, files, has_backend, deployed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      appId,
      version,
      config.deployId,
      config.commitHash,
      config.message ?? null,
      filesJson,
      config.hasBackend ? 1 : 0,
      now,
    );

    this.sql.exec(
      `UPDATE apps SET current_version = ?, has_backend = ?, updated_at = ? WHERE id = ?`,
      version,
      config.hasBackend ? 1 : 0,
      now,
      appId,
    );

    return this.getVersion(appId, version);
  }

  getVersions(appId: string): AppVersion[] {
    const cursor = this.sql.exec(
      "SELECT * FROM app_versions WHERE app_id = ? ORDER BY version DESC",
      appId,
    );
    return [...cursor].map(rowToVersion);
  }

  getVersion(appId: string, version: number): AppVersion | null {
    const rows = [
      ...this.sql.exec(
        "SELECT * FROM app_versions WHERE app_id = ? AND version = ? LIMIT 1",
        appId,
        version,
      ),
    ];
    return rows.length > 0 ? rowToVersion(rows[0]) : null;
  }

  /** Get the latest version for an app. */
  getLatestVersion(appId: string): AppVersion | null {
    const rows = [
      ...this.sql.exec(
        "SELECT * FROM app_versions WHERE app_id = ? ORDER BY version DESC LIMIT 1",
        appId,
      ),
    ];
    return rows.length > 0 ? rowToVersion(rows[0]) : null;
  }
}

function rowToApp(row: Record<string, unknown>): AppRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    currentVersion: row.current_version as number,
    hasBackend: (row.has_backend as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToVersion(row: Record<string, unknown>): AppVersion {
  const filesRaw = row.files as string | null;
  let files: string[] = [];
  if (filesRaw) {
    try {
      files = JSON.parse(filesRaw) as string[];
    } catch {
      files = [];
    }
  }

  return {
    appId: row.app_id as string,
    version: row.version as number,
    deployId: row.deploy_id as string,
    commitHash: row.commit_hash as string,
    message: row.message as string | null,
    files,
    hasBackend: (row.has_backend as number) === 1,
    deployedAt: row.deployed_at as string,
  };
}
