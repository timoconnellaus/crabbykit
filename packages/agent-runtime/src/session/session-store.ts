import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { nanoid } from "nanoid";
import type { SqlStore } from "../storage/types.js";
import type { Session, SessionEntry, SessionEntryType } from "./types.js";

const DEFAULT_SESSION_SOURCE = "websocket";

/**
 * Session store backed by SQL storage.
 * Manages sessions and tree-structured session entries.
 */
export class SessionStore {
  private sql: SqlStore;

  constructor(sql: SqlStore) {
    this.sql = sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'websocket',
        leaf_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_entries (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_session
      ON session_entries(session_id, seq)
    `);
  }

  // --- Session CRUD ---

  create(opts: { name?: string; source?: string } = {}): Session {
    const id = nanoid();
    const name = opts.name ?? "";
    const source = opts.source ?? DEFAULT_SESSION_SOURCE;

    this.sql.exec("INSERT INTO sessions (id, name, source) VALUES (?, ?, ?)", id, name, source);

    const session = this.get(id);
    if (!session) {
      throw new Error(`Failed to retrieve session immediately after creation: ${id}`);
    }
    return session;
  }

  get(sessionId: string): Session | null {
    const row = this.sql.exec("SELECT * FROM sessions WHERE id = ?", sessionId).one();

    if (!row) return null;

    return this.rowToSession(row);
  }

  list(): Session[] {
    const rows = this.sql.exec("SELECT * FROM sessions ORDER BY updated_at DESC").toArray();

    return rows.map((row) => this.rowToSession(row));
  }

  delete(sessionId: string): void {
    // Entries deleted via CASCADE
    this.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId);
  }

  rename(sessionId: string, name: string): void {
    this.sql.exec(
      "UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?",
      name,
      sessionId,
    );
  }

  // --- Entry operations ---

  appendEntry(
    sessionId: string,
    entry: {
      type: SessionEntryType;
      data: Record<string, unknown>;
    },
  ): SessionEntry {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const id = nanoid();
    const parentId = session.leafId;
    const now = new Date().toISOString();

    // Get next seq value
    const seqRow = this.sql
      .exec(
        "SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM session_entries WHERE session_id = ?",
        sessionId,
      )
      .one();
    const seq = (seqRow?.next_seq as number) ?? 1;

    const dataJson = JSON.stringify(entry.data);

    this.sql.exec(
      "INSERT INTO session_entries (id, parent_id, session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      parentId,
      sessionId,
      seq,
      entry.type,
      dataJson,
      now,
    );

    // Update session leaf_id and updated_at
    this.sql.exec(
      "UPDATE sessions SET leaf_id = ?, updated_at = ? WHERE id = ?",
      id,
      now,
      sessionId,
    );

    // Cast to discriminated union — caller guarantees type/data alignment
    return {
      id,
      parentId,
      sessionId,
      seq,
      type: entry.type,
      data: entry.data,
      createdAt: now,
    } as unknown as SessionEntry;
  }

  getEntries(sessionId: string): SessionEntry[] {
    const rows = this.sql
      .exec("SELECT * FROM session_entries WHERE session_id = ? ORDER BY seq", sessionId)
      .toArray();

    return rows.map((row) => this.rowToEntry(row));
  }

  private static readonly DEFAULT_PAGE_LIMIT = 100;

  /**
   * Get entries with pagination support.
   * Returns entries ordered by seq, optionally starting after `afterSeq`.
   */
  getEntriesPaginated(
    sessionId: string,
    options?: { limit?: number; afterSeq?: number },
  ): { entries: SessionEntry[]; hasMore: boolean } {
    const limit = options?.limit ?? SessionStore.DEFAULT_PAGE_LIMIT;
    const afterSeq = options?.afterSeq ?? 0;

    // Fetch one extra to determine if there are more entries
    const rows = this.sql
      .exec(
        "SELECT * FROM session_entries WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        sessionId,
        afterSeq,
        limit + 1,
      )
      .toArray();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      entries: pageRows.map((row) => this.rowToEntry(row)),
      hasMore,
    };
  }

  /**
   * Build LLM context by walking the tree from leaf to root,
   * resolving compaction boundaries.
   */
  buildContext(sessionId: string): AgentMessage[] {
    const session = this.get(sessionId);
    if (!session?.leafId) return [];

    const entries = this.getEntries(sessionId);
    if (entries.length === 0) return [];

    // Build lookup map
    const entryMap = new Map<string, SessionEntry>();
    for (const entry of entries) {
      entryMap.set(entry.id, entry);
    }

    // Walk from leaf to root
    const path: SessionEntry[] = [];
    let current: SessionEntry | undefined = entryMap.get(session.leafId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? entryMap.get(current.parentId) : undefined;
    }

    // Resolve compaction boundaries - find the most recent compaction entry
    let startIndex = 0;
    let compactionSummary: string | null = null;

    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i];
      if (entry.type === "compaction") {
        compactionSummary = entry.data.summary;
        // Find the index of firstKeptEntryId in the path
        const keptIndex = path.findIndex((e) => e.id === entry.data.firstKeptEntryId);
        startIndex = keptIndex >= 0 ? keptIndex : i + 1;
        break;
      }
    }

    // Build messages array
    const messages: AgentMessage[] = [];

    // Add compaction summary as first message if exists
    if (compactionSummary) {
      messages.push({
        role: "user",
        content: `[Previous conversation summary]\n\n${compactionSummary}`,
        timestamp: Date.now(),
      });
    }

    // Add messages from startIndex onward
    for (let i = startIndex; i < path.length; i++) {
      const entry = path[i];
      if (entry.type === "message") {
        if (entry.data.role === "toolResult") {
          messages.push({
            role: "toolResult",
            content:
              typeof entry.data.content === "string"
                ? [{ type: "text", text: entry.data.content }]
                : // biome-ignore lint/suspicious/noExplicitAny: SQL deserialization boundary — content shape is not statically known
                  (entry.data.content as any),
            toolCallId: entry.data.toolCallId ?? "",
            toolName: entry.data.toolName,
            isError: entry.data.isError,
            timestamp: entry.data.timestamp ?? Date.now(),
          } as AgentMessage);
        } else {
          messages.push({
            role: entry.data.role as "user" | "assistant",
            // biome-ignore lint/suspicious/noExplicitAny: SQL deserialization boundary — content shape is not statically known
            content: entry.data.content as any,
            timestamp: entry.data.timestamp ?? Date.now(),
          } as AgentMessage);
        }
      }
    }

    return messages;
  }

  /**
   * Branch from a specific entry - update leaf_id so subsequent
   * appends fork from that point.
   */
  branch(sessionId: string, fromEntryId: string): void {
    const entry = this.sql
      .exec(
        "SELECT id FROM session_entries WHERE id = ? AND session_id = ?",
        fromEntryId,
        sessionId,
      )
      .one();

    if (!entry) {
      throw new Error(`Entry not found: ${fromEntryId} in session ${sessionId}`);
    }

    this.sql.exec(
      "UPDATE sessions SET leaf_id = ?, updated_at = datetime('now') WHERE id = ?",
      fromEntryId,
      sessionId,
    );
  }

  /**
   * Garbage-collect unreachable entries (entries not on the leaf-to-root path).
   * Call after compaction to clean up orphaned branch entries.
   */
  gc(sessionId: string): number {
    const session = this.get(sessionId);
    if (!session?.leafId) return 0;

    // Walk from leaf to root to find reachable entries
    const entries = this.getEntries(sessionId);
    const entryMap = new Map<string, SessionEntry>();
    for (const entry of entries) {
      entryMap.set(entry.id, entry);
    }

    const reachable = new Set<string>();
    let current: SessionEntry | undefined = entryMap.get(session.leafId);
    while (current) {
      reachable.add(current.id);
      current = current.parentId ? entryMap.get(current.parentId) : undefined;
    }

    // Delete unreachable entries
    const unreachable = entries.filter((e) => !reachable.has(e.id));
    if (unreachable.length === 0) return 0;

    const ids = unreachable.map((e) => e.id);
    const placeholders = ids.map(() => "?").join(",");
    this.sql.exec(`DELETE FROM session_entries WHERE id IN (${placeholders})`, ...ids);

    return unreachable.length;
  }

  // --- Private helpers ---

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      name: row.name as string,
      source: row.source as string,
      leafId: (row.leaf_id as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private rowToEntry(row: Record<string, unknown>): SessionEntry {
    const base = {
      id: row.id as string,
      parentId: (row.parent_id as string) ?? null,
      sessionId: row.session_id as string,
      seq: row.seq as number,
      createdAt: row.created_at as string,
    };
    const type = row.type as SessionEntryType;
    const data = JSON.parse(row.data as string);
    // Cast to discriminated union — the DB schema guarantees type/data alignment
    return { ...base, type, data } as SessionEntry;
  }
}
