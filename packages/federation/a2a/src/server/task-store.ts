import type { SqlStore } from "@crabbykit/agent-runtime";
import { nanoid } from "nanoid";
import type {
  Artifact,
  Part,
  PushNotificationConfig,
  Task,
  TaskState,
  TaskStatus,
} from "../types.js";

// ============================================================================
// SQL Schema
// ============================================================================

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted',
  status_message TEXT,
  status_timestamp TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context
ON a2a_tasks(context_id);

CREATE TABLE IF NOT EXISTS a2a_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  parts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_task
ON a2a_artifacts(task_id, seq);

CREATE TABLE IF NOT EXISTS a2a_push_configs (
  task_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  token TEXT,
  auth_schemes TEXT,
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id) ON DELETE CASCADE
);
`;

// ============================================================================
// TaskStore
// ============================================================================

interface TaskRow {
  id: string;
  context_id: string;
  session_id: string;
  state: string;
  status_message: string | null;
  status_timestamp: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  task_id: string;
  artifact_id: string;
  name: string | null;
  description: string | null;
  parts: string;
  seq: number;
  metadata: string | null;
}

interface PushConfigRow {
  task_id: string;
  url: string;
  token: string | null;
  auth_schemes: string | null;
}

export class TaskStore {
  constructor(private sql: SqlStore) {
    this.sql.exec(INIT_SQL);
  }

  // --- Task CRUD ---

  create(opts: {
    id?: string;
    contextId: string;
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): Task {
    const id = opts.id ?? nanoid();
    const now = new Date().toISOString();
    const status: TaskStatus = { state: "submitted", timestamp: now };

    this.sql.exec(
      `INSERT INTO a2a_tasks (id, context_id, session_id, state, status_timestamp, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?)`,
      id,
      opts.contextId,
      opts.sessionId,
      now,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      now,
      now,
    );

    return { id, contextId: opts.contextId, status };
  }

  get(taskId: string): Task | null {
    const rows = this.sql.exec<TaskRow>("SELECT * FROM a2a_tasks WHERE id = ?", taskId).toArray();
    if (rows.length === 0) return null;
    return this.rowToTask(rows[0]);
  }

  list(opts?: { contextId?: string; limit?: number; offset?: number }): Task[] {
    let query = "SELECT * FROM a2a_tasks";
    const params: (string | number)[] = [];

    if (opts?.contextId) {
      query += " WHERE context_id = ?";
      params.push(opts.contextId);
    }

    query += " ORDER BY created_at DESC";

    if (opts?.limit) {
      query += " LIMIT ?";
      params.push(opts.limit);
    }
    if (opts?.offset) {
      query += " OFFSET ?";
      params.push(opts.offset);
    }

    return this.sql
      .exec<TaskRow>(query, ...params)
      .toArray()
      .map((row) => this.rowToTask(row));
  }

  updateStatus(taskId: string, status: TaskStatus): void {
    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE a2a_tasks SET state = ?, status_message = ?, status_timestamp = ?, updated_at = ? WHERE id = ?`,
      status.state,
      status.message ? JSON.stringify(status.message) : null,
      status.timestamp,
      now,
      taskId,
    );
  }

  /** Get the internal session ID for a task. */
  getSessionId(taskId: string): string | null {
    const rows = this.sql
      .exec<{ session_id: string }>("SELECT session_id FROM a2a_tasks WHERE id = ?", taskId)
      .toArray();
    return rows[0]?.session_id ?? null;
  }

  /** Find the session ID associated with a context ID (from existing tasks). */
  getSessionIdForContext(contextId: string): string | null {
    const rows = this.sql
      .exec<{ session_id: string }>(
        "SELECT session_id FROM a2a_tasks WHERE context_id = ? ORDER BY created_at DESC LIMIT 1",
        contextId,
      )
      .toArray();
    return rows[0]?.session_id ?? null;
  }

  delete(taskId: string): void {
    this.sql.exec("DELETE FROM a2a_tasks WHERE id = ?", taskId);
  }

  // --- Artifacts ---

  addArtifact(taskId: string, artifact: Artifact): void {
    const id = nanoid();
    const maxSeqRows = this.sql
      .exec<{ max_seq: number | null }>(
        "SELECT MAX(seq) as max_seq FROM a2a_artifacts WHERE task_id = ?",
        taskId,
      )
      .toArray();
    const seq = (maxSeqRows[0]?.max_seq ?? -1) + 1;

    this.sql.exec(
      `INSERT INTO a2a_artifacts (id, task_id, artifact_id, name, description, parts, seq, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      taskId,
      artifact.artifactId,
      artifact.name ?? null,
      artifact.description ?? null,
      JSON.stringify(artifact.parts),
      seq,
      artifact.metadata ? JSON.stringify(artifact.metadata) : null,
    );
  }

  appendArtifactParts(taskId: string, artifactId: string, parts: Part[]): void {
    const rows = this.sql
      .exec<ArtifactRow>(
        "SELECT * FROM a2a_artifacts WHERE task_id = ? AND artifact_id = ? ORDER BY seq DESC LIMIT 1",
        taskId,
        artifactId,
      )
      .toArray();
    if (rows.length === 0) return;
    const row = rows[0];

    const existingParts = JSON.parse(row.parts) as Part[];
    const mergedParts = [...existingParts, ...parts];
    this.sql.exec(
      "UPDATE a2a_artifacts SET parts = ? WHERE id = ?",
      JSON.stringify(mergedParts),
      row.id,
    );
  }

  getArtifacts(taskId: string): Artifact[] {
    return this.sql
      .exec<ArtifactRow>("SELECT * FROM a2a_artifacts WHERE task_id = ? ORDER BY seq", taskId)
      .toArray()
      .map((row) => this.rowToArtifact(row));
  }

  // --- Push Notification Configs ---

  setPushConfig(taskId: string, config: PushNotificationConfig): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO a2a_push_configs (task_id, url, token, auth_schemes)
       VALUES (?, ?, ?, ?)`,
      taskId,
      config.url,
      config.token ?? null,
      config.authentication?.schemes ? JSON.stringify(config.authentication.schemes) : null,
    );
  }

  getPushConfig(taskId: string): PushNotificationConfig | null {
    const rows = this.sql
      .exec<PushConfigRow>("SELECT * FROM a2a_push_configs WHERE task_id = ?", taskId)
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0];

    return {
      url: row.url,
      ...(row.token ? { token: row.token } : {}),
      ...(row.auth_schemes
        ? {
            authentication: {
              schemes: JSON.parse(row.auth_schemes) as string[],
            },
          }
        : {}),
    };
  }

  deletePushConfig(taskId: string): void {
    this.sql.exec("DELETE FROM a2a_push_configs WHERE task_id = ?", taskId);
  }

  // --- Internal ---

  private rowToTask(row: TaskRow): Task {
    const status: TaskStatus = {
      state: row.state as TaskState,
      timestamp: row.status_timestamp,
      ...(row.status_message ? { message: JSON.parse(row.status_message) } : {}),
    };

    return {
      id: row.id,
      contextId: row.context_id,
      status,
      ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
    };
  }

  private rowToArtifact(row: ArtifactRow): Artifact {
    return {
      artifactId: row.artifact_id,
      ...(row.name ? { name: row.name } : {}),
      ...(row.description ? { description: row.description } : {}),
      parts: JSON.parse(row.parts) as Part[],
      ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
    };
  }
}
