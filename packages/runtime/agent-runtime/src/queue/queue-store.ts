import { nanoid } from "nanoid";
import type { SqlStore } from "../storage/types.js";
import type { QueuedMessage } from "./types.js";

/**
 * Durable message queue backed by DO SQLite.
 * Stores messages that arrive while the agent is busy, processed FIFO on agent_end.
 */
export class QueueStore {
  private sql: SqlStore;

  constructor(sql: SqlStore) {
    this.sql = sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_queue_session ON message_queue(session_id, created_at)
    `);
  }

  enqueue(sessionId: string, text: string): QueuedMessage {
    const id = nanoid();
    const createdAt = new Date().toISOString();
    this.sql.exec(
      "INSERT INTO message_queue (id, session_id, text, created_at) VALUES (?, ?, ?, ?)",
      id,
      sessionId,
      text,
      createdAt,
    );
    return { id, sessionId, text, createdAt };
  }

  dequeue(sessionId: string): QueuedMessage | null {
    const rows = this.sql
      .exec(
        "SELECT * FROM message_queue WHERE session_id = ? ORDER BY created_at ASC LIMIT 1",
        sessionId,
      )
      .toArray();
    if (rows.length === 0) return null;
    const item = rowToQueuedMessage(rows[0]);
    this.sql.exec("DELETE FROM message_queue WHERE id = ?", item.id);
    return item;
  }

  get(id: string): QueuedMessage | null {
    const rows = this.sql.exec("SELECT * FROM message_queue WHERE id = ? LIMIT 1", id).toArray();
    return rows.length > 0 ? rowToQueuedMessage(rows[0]) : null;
  }

  list(sessionId: string): QueuedMessage[] {
    const cursor = this.sql.exec(
      "SELECT * FROM message_queue WHERE session_id = ? ORDER BY created_at ASC",
      sessionId,
    );
    return [...cursor].map(rowToQueuedMessage);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.sql.exec("DELETE FROM message_queue WHERE id = ?", id);
    return true;
  }

  deleteAll(sessionId: string): void {
    this.sql.exec("DELETE FROM message_queue WHERE session_id = ?", sessionId);
  }
}

function rowToQueuedMessage(row: Record<string, unknown>): QueuedMessage {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    text: row.text as string,
    createdAt: row.created_at as string,
  };
}
