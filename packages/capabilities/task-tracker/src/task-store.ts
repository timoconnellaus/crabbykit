import type { SqlStore } from "@claw-for-cloudflare/agent-runtime";
import { nanoid } from "nanoid";
import type {
  CreateTaskInput,
  DepType,
  Task,
  TaskDep,
  TaskStatus,
  TaskTreeNode,
  UpdateTaskInput,
} from "./types.js";
import { BLOCKING_DEP_TYPES, VALID_TRANSITIONS } from "./types.js";

/**
 * Callback to check if a session has write authority for a given owner session.
 * Returns true if callerSession === ownerSession or callerSession is a subagent
 * of ownerSession.
 */
export type AuthChecker = (callerSession: string, ownerSession: string) => boolean;

/** Default auth checker: only exact session match. */
const DEFAULT_AUTH_CHECKER: AuthChecker = (caller, owner) => caller === owner;

/**
 * DAG-based task store backed by DO SQLite.
 * Provides task CRUD, dependency graph, ready-work computation,
 * and tree queries with session-based ownership enforcement.
 */
export class TaskStore {
  private sql: SqlStore;
  private authChecker: AuthChecker;

  constructor(sql: SqlStore, authChecker?: AuthChecker) {
    this.sql = sql;
    this.authChecker = authChecker ?? DEFAULT_AUTH_CHECKER;
    this.initSchema();
  }

  /** Set the auth checker (allows updating after subagent capability registers). */
  setAuthChecker(checker: AuthChecker): void {
    this.authChecker = checker;
  }

  // --- Schema ---

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        owner_session TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        priority INTEGER NOT NULL DEFAULT 2,
        type TEXT NOT NULL DEFAULT 'task',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT,
        close_reason TEXT
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS task_deps (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        dep_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (source_id, target_id)
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_owner
      ON tasks(owner_session)
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_parent
      ON tasks(parent_id)
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_deps_source
      ON task_deps(source_id)
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_deps_target
      ON task_deps(target_id)
    `);
  }

  // --- Authorization ---

  private assertCanWrite(callerSession: string, ownerSession: string): void {
    if (!this.authChecker(callerSession, ownerSession)) {
      throw new TaskAuthError(callerSession, ownerSession);
    }
  }

  // --- Task CRUD ---

  create(callerSession: string, input: CreateTaskInput): Task {
    // If creating a child, verify caller owns the parent
    if (input.parentId) {
      const parent = this.get(input.parentId);
      if (!parent) {
        throw new TaskNotFoundError(input.parentId);
      }
      this.assertCanWrite(callerSession, parent.ownerSession);
    }

    const id = nanoid();
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO tasks (id, parent_id, owner_session, title, description, acceptance, status, priority, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      id,
      input.parentId ?? null,
      callerSession,
      input.title,
      input.description ?? "",
      input.acceptance ?? "",
      input.priority ?? 2,
      input.type ?? "task",
      now,
      now,
    );

    // Auto-create parent-child dep if parent specified
    if (input.parentId) {
      this.addDepInternal(id, input.parentId, "parent-child");
    }

    // Add any explicit blocking dependencies
    if (input.dependsOn) {
      for (const targetId of input.dependsOn) {
        this.addDepInternal(id, targetId, "blocks");
      }
    }

    const task = this.get(id);
    if (!task) {
      throw new Error(`Failed to retrieve task after creation: ${id}`);
    }
    return task;
  }

  get(taskId: string): Task | null {
    const row = this.sql.exec("SELECT * FROM tasks WHERE id = ?", taskId).one();
    if (!row) return null;
    return rowToTask(row);
  }

  /** List all tasks, optionally filtered by owner session. */
  list(ownerSession?: string): Task[] {
    if (ownerSession) {
      return this.sql
        .exec("SELECT * FROM tasks WHERE owner_session = ? ORDER BY created_at", ownerSession)
        .toArray()
        .map(rowToTask);
    }
    return this.sql.exec("SELECT * FROM tasks ORDER BY created_at").toArray().map(rowToTask);
  }

  update(callerSession: string, taskId: string, input: UpdateTaskInput): Task {
    const task = this.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.assertCanWrite(callerSession, task.ownerSession);

    if (input.status) {
      this.assertValidTransition(task.status, input.status);
    }

    const sets: string[] = [];
    const values: unknown[] = [];

    if (input.status !== undefined) {
      sets.push("status = ?");
      values.push(input.status);
    }
    if (input.priority !== undefined) {
      sets.push("priority = ?");
      values.push(input.priority);
    }
    if (input.description !== undefined) {
      sets.push("description = ?");
      values.push(input.description);
    }
    if (input.acceptance !== undefined) {
      sets.push("acceptance = ?");
      values.push(input.acceptance);
    }

    if (sets.length === 0) return task;

    sets.push("updated_at = datetime('now')");
    values.push(taskId);

    this.sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...values);

    return this.get(taskId)!;
  }

  close(callerSession: string, taskId: string, reason: string): Task {
    const task = this.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.assertCanWrite(callerSession, task.ownerSession);
    this.assertValidTransition(task.status, "closed");

    this.sql.exec(
      `UPDATE tasks SET status = 'closed', close_reason = ?, closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      reason,
      taskId,
    );

    return this.get(taskId)!;
  }

  /** Delete all tasks and their dependencies for a session. Returns count of deleted tasks. */
  deleteBySession(callerSession: string): number {
    const tasks = this.list(callerSession);
    if (tasks.length === 0) return 0;
    this.sql.exec(
      "DELETE FROM task_deps WHERE source_id IN (SELECT id FROM tasks WHERE owner_session = ?)",
      callerSession,
    );
    this.sql.exec("DELETE FROM tasks WHERE owner_session = ?", callerSession);
    return tasks.length;
  }

  // --- Dependencies ---

  addDep(callerSession: string, sourceId: string, targetId: string, depType: DepType): TaskDep {
    const source = this.get(sourceId);
    if (!source) throw new TaskNotFoundError(sourceId);
    this.assertCanWrite(callerSession, source.ownerSession);

    const target = this.get(targetId);
    if (!target) throw new TaskNotFoundError(targetId);

    return this.addDepInternal(sourceId, targetId, depType);
  }

  private addDepInternal(sourceId: string, targetId: string, depType: DepType): TaskDep {
    if (sourceId === targetId) {
      throw new TaskCycleError([sourceId]);
    }

    // Cycle detection for blocking deps
    if (BLOCKING_DEP_TYPES.has(depType)) {
      this.assertNoCycle(sourceId, targetId);
    }

    this.sql.exec(
      "INSERT INTO task_deps (source_id, target_id, dep_type) VALUES (?, ?, ?)",
      sourceId,
      targetId,
      depType,
    );

    const row = this.sql
      .exec("SELECT * FROM task_deps WHERE source_id = ? AND target_id = ?", sourceId, targetId)
      .one();

    return rowToDep(row!);
  }

  removeDep(callerSession: string, sourceId: string, targetId: string): void {
    const source = this.get(sourceId);
    if (!source) throw new TaskNotFoundError(sourceId);
    this.assertCanWrite(callerSession, source.ownerSession);

    this.sql.exec(
      "DELETE FROM task_deps WHERE source_id = ? AND target_id = ?",
      sourceId,
      targetId,
    );
  }

  /** Get all dependency edges for a task (both directions). */
  getDeps(taskId: string): TaskDep[] {
    return this.sql
      .exec("SELECT * FROM task_deps WHERE source_id = ? OR target_id = ?", taskId, taskId)
      .toArray()
      .map(rowToDep);
  }

  // --- Ready Work ---

  /**
   * Compute ready tasks: open tasks whose blocking deps are all closed.
   * Optionally filtered to a specific owner session.
   */
  ready(ownerSession?: string): Task[] {
    // Tasks that are open and have NO unclosed blocking deps
    const baseCondition = ownerSession
      ? "t.status = 'open' AND t.owner_session = ?"
      : "t.status = 'open'";

    const bindings = ownerSession ? [ownerSession] : [];

    return this.sql
      .exec<Record<string, unknown>>(
        `SELECT t.* FROM tasks t
         WHERE ${baseCondition}
         AND NOT EXISTS (
           SELECT 1 FROM task_deps d
           JOIN tasks blocker ON blocker.id = d.target_id
           WHERE d.source_id = t.id
             AND d.dep_type IN ('blocks', 'parent-child')
             AND blocker.status != 'closed'
         )
         ORDER BY t.priority ASC, t.created_at ASC`,
        ...bindings,
      )
      .toArray()
      .map(rowToTask);
  }

  // --- Tree Query ---

  /** Build a tree from a root task ID, including all descendants. */
  tree(rootId: string): TaskTreeNode | null {
    const root = this.get(rootId);
    if (!root) return null;

    const rootNode: TaskTreeNode = { ...root, depth: 0, children: [] };
    this.buildTreeRecursive(rootNode);
    return rootNode;
  }

  private buildTreeRecursive(node: TaskTreeNode): void {
    const children = this.sql
      .exec("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at", node.id)
      .toArray()
      .map(rowToTask);

    for (const child of children) {
      const childNode: TaskTreeNode = { ...child, depth: node.depth + 1, children: [] };
      this.buildTreeRecursive(childNode);
      node.children.push(childNode);
    }
  }

  // --- Cycle Detection ---

  /**
   * Check if adding a blocking edge source→target would create a cycle.
   * Walks from target following blocking deps to see if we reach source.
   */
  private assertNoCycle(sourceId: string, targetId: string): void {
    const visited = new Set<string>();
    const stack = [targetId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === sourceId) {
        throw new TaskCycleError([sourceId, targetId]);
      }
      if (visited.has(current)) continue;
      visited.add(current);

      // Follow blocking deps from current (current depends on X → X blocks current)
      // We need to check: does target (transitively) depend on source?
      // target depends on X means there's an edge (target, X) in task_deps
      // We walk: from targetId, follow all blocking edges where current is source_id
      const deps = this.sql
        .exec(
          `SELECT target_id FROM task_deps
           WHERE source_id = ?
             AND dep_type IN ('blocks', 'parent-child')`,
          current,
        )
        .toArray();

      for (const dep of deps) {
        stack.push(dep.target_id as string);
      }
    }
  }

  // --- Status Validation ---

  private assertValidTransition(from: TaskStatus, to: TaskStatus): void {
    const allowed = VALID_TRANSITIONS.get(from);
    if (!allowed?.has(to)) {
      throw new InvalidTransitionError(from, to);
    }
  }
}

// --- Row Converters ---

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    parentId: (row.parent_id as string) ?? null,
    ownerSession: row.owner_session as string,
    title: row.title as string,
    description: row.description as string,
    acceptance: row.acceptance as string,
    status: row.status as TaskStatus,
    priority: row.priority as number,
    type: row.type as Task["type"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string) ?? null,
    closeReason: (row.close_reason as string) ?? null,
  };
}

function rowToDep(row: Record<string, unknown>): TaskDep {
  return {
    sourceId: row.source_id as string,
    targetId: row.target_id as string,
    depType: row.dep_type as DepType,
    createdAt: row.created_at as string,
  };
}

// --- Errors ---

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskAuthError extends Error {
  constructor(callerSession: string, ownerSession: string) {
    super(
      `Session "${callerSession}" does not have write access to tasks owned by "${ownerSession}"`,
    );
    this.name = "TaskAuthError";
  }
}

export class TaskCycleError extends Error {
  constructor(path: string[]) {
    super(`Adding dependency would create a cycle: ${path.join(" → ")}`);
    this.name = "TaskCycleError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}
