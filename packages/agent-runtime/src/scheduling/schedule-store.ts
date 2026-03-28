import { nanoid } from "nanoid";
import type { Schedule } from "./types.js";

const DEFAULT_RETENTION = 10;

/**
 * Schedule store backed by Durable Object SQLite.
 * Manages persistent schedule records for alarm-based execution.
 */
export class ScheduleStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        handler_type TEXT NOT NULL DEFAULT 'prompt',
        prompt TEXT,
        session_prefix TEXT,
        owner_id TEXT,
        next_fire_at TEXT,
        last_fired_at TEXT,
        timezone TEXT,
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        retention INTEGER NOT NULL DEFAULT ${DEFAULT_RETENTION},
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  create(config: {
    id?: string;
    name: string;
    cron: string;
    enabled?: boolean;
    handlerType: "prompt" | "callback" | "timer";
    prompt?: string;
    sessionPrefix?: string;
    ownerId?: string;
    timezone?: string;
    expiresAt?: string;
    nextFireAt?: string;
    retention?: number;
  }): Schedule {
    const id = config.id ?? nanoid();
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO schedules (id, name, cron, enabled, handler_type, prompt, session_prefix, owner_id, timezone, expires_at, next_fire_at, retention, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      config.name,
      config.cron,
      config.enabled !== false ? 1 : 0,
      config.handlerType,
      config.prompt ?? null,
      config.sessionPrefix ?? config.name,
      config.ownerId ?? null,
      config.timezone ?? null,
      config.expiresAt ?? null,
      config.nextFireAt ?? null,
      config.retention ?? DEFAULT_RETENTION,
      now,
      now,
    );

    // biome-ignore lint/style/noNonNullAssertion: row was just inserted
    return this.get(id)!;
  }

  get(id: string): Schedule | null {
    const row = this.sql.exec("SELECT * FROM schedules WHERE id = ?", id).one();
    return row ? rowToSchedule(row) : null;
  }

  list(): Schedule[] {
    const cursor = this.sql.exec("SELECT * FROM schedules ORDER BY created_at ASC");
    return [...cursor].map(rowToSchedule);
  }

  update(
    id: string,
    updates: Partial<{
      name: string;
      cron: string;
      enabled: boolean;
      prompt: string;
      sessionPrefix: string;
      timezone: string | null;
      nextFireAt: string | null;
      lastFiredAt: string | null;
      status: string;
      lastError: string | null;
      retention: number;
    }>,
  ): Schedule | null {
    const existing = this.get(id);
    if (!existing) return null;

    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      values.push(updates.name);
    }
    if (updates.cron !== undefined) {
      setClauses.push("cron = ?");
      values.push(updates.cron);
    }
    if (updates.enabled !== undefined) {
      setClauses.push("enabled = ?");
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.prompt !== undefined) {
      setClauses.push("prompt = ?");
      values.push(updates.prompt);
    }
    if (updates.sessionPrefix !== undefined) {
      setClauses.push("session_prefix = ?");
      values.push(updates.sessionPrefix);
    }
    if (updates.timezone !== undefined) {
      setClauses.push("timezone = ?");
      values.push(updates.timezone);
    }
    if (updates.nextFireAt !== undefined) {
      setClauses.push("next_fire_at = ?");
      values.push(updates.nextFireAt);
    }
    if (updates.lastFiredAt !== undefined) {
      setClauses.push("last_fired_at = ?");
      values.push(updates.lastFiredAt);
    }
    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      values.push(updates.status);
    }
    if (updates.lastError !== undefined) {
      setClauses.push("last_error = ?");
      values.push(updates.lastError);
    }
    if (updates.retention !== undefined) {
      setClauses.push("retention = ?");
      values.push(updates.retention);
    }

    values.push(id);
    this.sql.exec(`UPDATE schedules SET ${setClauses.join(", ")} WHERE id = ?`, ...values);

    return this.get(id);
  }

  delete(id: string): void {
    this.sql.exec("DELETE FROM schedules WHERE id = ?", id);
  }

  /** Get all enabled schedules whose next_fire_at is at or before the given time. */
  getDueSchedules(now: Date): Schedule[] {
    const cursor = this.sql.exec(
      `SELECT * FROM schedules
       WHERE enabled = 1
         AND next_fire_at IS NOT NULL
         AND next_fire_at <= ?
       ORDER BY next_fire_at ASC`,
      now.toISOString(),
    );
    return [...cursor].map(rowToSchedule);
  }

  /** Get the earliest next_fire_at among all enabled schedules. */
  getEarliestFireTime(): Date | null {
    const row = this.sql
      .exec(
        `SELECT MIN(next_fire_at) as earliest
       FROM schedules
       WHERE enabled = 1
         AND next_fire_at IS NOT NULL`,
      )
      .one();

    if (!row?.earliest) return null;
    return new Date(row.earliest as string);
  }

  markRunning(id: string): void {
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE schedules SET status = ?, last_fired_at = ?, updated_at = ? WHERE id = ?",
      "running",
      now,
      now,
      id,
    );
  }

  markIdle(id: string): void {
    this.sql.exec(
      "UPDATE schedules SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?",
      "idle",
      null,
      id,
    );
  }

  markFailed(id: string, error: string): void {
    this.sql.exec(
      "UPDATE schedules SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?",
      "failed",
      error,
      id,
    );
  }
}

function rowToSchedule(row: Record<string, SqlStorageValue>): Schedule {
  return {
    id: row.id as string,
    name: row.name as string,
    cron: row.cron as string,
    enabled: (row.enabled as number) === 1,
    handlerType: row.handler_type as "prompt" | "callback" | "timer",
    prompt: row.prompt as string | null,
    sessionPrefix: row.session_prefix as string | null,
    ownerId: row.owner_id as string | null,
    nextFireAt: row.next_fire_at as string | null,
    lastFiredAt: row.last_fired_at as string | null,
    timezone: row.timezone as string | null,
    expiresAt: row.expires_at as string | null,
    status: row.status as "idle" | "running" | "failed",
    lastError: row.last_error as string | null,
    retention: row.retention as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
