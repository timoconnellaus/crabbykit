import type { SqlResult, SqlStore } from "@claw-for-cloudflare/agent-runtime";

interface Row {
  [key: string]: unknown;
}

function makeSqlResult<T>(rows: T[]): SqlResult<T> {
  return {
    toArray: () => rows,
    one: () => rows[0] ?? null,
    [Symbol.iterator]: () => rows[Symbol.iterator]() as Iterator<T>,
  };
}

/**
 * In-memory SqlStore that simulates SQLite for task-tracker tables.
 * Supports CREATE TABLE/INDEX, INSERT, SELECT, UPDATE, DELETE with
 * basic WHERE clause parsing.
 */
export function createMockSqlStore(): SqlStore {
  const tables: Record<string, Row[]> = {};

  function getTable(name: string): Row[] {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function now(): string {
    return new Date().toISOString();
  }

  return {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlResult<T> {
      const trimmed = query.trim().replace(/\s+/g, " ");

      // CREATE TABLE / CREATE INDEX — no-op
      if (trimmed.startsWith("CREATE TABLE") || trimmed.startsWith("CREATE INDEX")) {
        return makeSqlResult<T>([]);
      }

      // INSERT INTO tasks
      if (trimmed.startsWith("INSERT INTO tasks")) {
        const row: Row = {
          id: bindings[0],
          parent_id: bindings[1],
          owner_session: bindings[2],
          title: bindings[3],
          description: bindings[4],
          acceptance: bindings[5],
          status: "open",
          priority: bindings[6],
          type: bindings[7],
          created_at: bindings[8],
          updated_at: bindings[9],
          closed_at: null,
          close_reason: null,
        };
        getTable("tasks").push(row);
        return makeSqlResult<T>([]);
      }

      // INSERT INTO task_deps
      if (trimmed.startsWith("INSERT INTO task_deps")) {
        const row: Row = {
          source_id: bindings[0],
          target_id: bindings[1],
          dep_type: bindings[2],
          created_at: now(),
        };
        getTable("task_deps").push(row);
        return makeSqlResult<T>([]);
      }

      // SELECT * FROM tasks WHERE id = ?
      if (trimmed.startsWith("SELECT * FROM tasks WHERE id =")) {
        const rows = getTable("tasks").filter((r) => r.id === bindings[0]);
        return makeSqlResult<T>(rows as T[]);
      }

      // SELECT * FROM tasks WHERE owner_session = ? ORDER BY created_at
      if (trimmed.includes("WHERE owner_session =") && trimmed.includes("ORDER BY created_at")) {
        const rows = getTable("tasks")
          .filter((r) => r.owner_session === bindings[0])
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        return makeSqlResult<T>(rows as T[]);
      }

      // SELECT * FROM tasks ORDER BY created_at
      if (trimmed === "SELECT * FROM tasks ORDER BY created_at") {
        const rows = getTable("tasks").sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)),
        );
        return makeSqlResult<T>(rows as T[]);
      }

      // SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at
      if (trimmed.includes("WHERE parent_id =") && trimmed.includes("ORDER BY created_at")) {
        const rows = getTable("tasks")
          .filter((r) => r.parent_id === bindings[0])
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        return makeSqlResult<T>(rows as T[]);
      }

      // SELECT * FROM task_deps WHERE source_id = ? AND target_id = ?
      if (
        trimmed.startsWith("SELECT * FROM task_deps WHERE source_id") &&
        trimmed.includes("AND target_id")
      ) {
        const rows = getTable("task_deps").filter(
          (r) => r.source_id === bindings[0] && r.target_id === bindings[1],
        );
        return makeSqlResult<T>(rows as T[]);
      }

      // SELECT * FROM task_deps WHERE source_id = ? OR target_id = ?
      if (trimmed.includes("WHERE source_id = ?") && trimmed.includes("OR target_id = ?")) {
        const rows = getTable("task_deps").filter(
          (r) => r.source_id === bindings[0] || r.target_id === bindings[1],
        );
        return makeSqlResult<T>(rows as T[]);
      }

      // SELECT target_id FROM task_deps WHERE source_id = ? AND dep_type IN (...)
      if (trimmed.startsWith("SELECT target_id FROM task_deps")) {
        const rows = getTable("task_deps")
          .filter(
            (r) =>
              r.source_id === bindings[0] &&
              (r.dep_type === "blocks" || r.dep_type === "parent-child"),
          )
          .map((r) => ({ target_id: r.target_id }));
        return makeSqlResult<T>(rows as T[]);
      }

      // Ready-work query (complex JOIN)
      if (trimmed.includes("NOT EXISTS") && trimmed.includes("blocker")) {
        const ownerSession = bindings.length > 0 ? (bindings[0] as string) : null;
        const tasks = getTable("tasks").filter((t) => {
          if (t.status !== "open") return false;
          if (ownerSession && t.owner_session !== ownerSession) return false;

          // Check if all blocking deps are closed
          const blockingDeps = getTable("task_deps").filter(
            (d) =>
              d.source_id === t.id && (d.dep_type === "blocks" || d.dep_type === "parent-child"),
          );

          return blockingDeps.every((d) => {
            const blocker = getTable("tasks").find((bt) => bt.id === d.target_id);
            return blocker?.status === "closed";
          });
        });

        tasks.sort((a, b) => {
          const pDiff = (a.priority as number) - (b.priority as number);
          if (pDiff !== 0) return pDiff;
          return String(a.created_at).localeCompare(String(b.created_at));
        });

        return makeSqlResult<T>(tasks as T[]);
      }

      // UPDATE tasks SET ...
      if (trimmed.startsWith("UPDATE tasks SET")) {
        const taskId = bindings[bindings.length - 1];
        const task = getTable("tasks").find((r) => r.id === taskId);
        if (task) {
          // Parse SET clauses — simplified: walk bindings in order
          if (trimmed.includes("status = 'closed'")) {
            // Close operation
            task.status = "closed";
            task.close_reason = bindings[0];
            task.closed_at = now();
            task.updated_at = now();
          } else {
            // Generic update — bind in order of SET clauses
            let bindIdx = 0;
            if (trimmed.includes("status = ?")) {
              task.status = bindings[bindIdx++];
            }
            if (trimmed.includes("priority = ?")) {
              task.priority = bindings[bindIdx++];
            }
            if (trimmed.includes("description = ?")) {
              task.description = bindings[bindIdx++];
            }
            if (trimmed.includes("acceptance = ?")) {
              task.acceptance = bindings[bindIdx++];
            }
            task.updated_at = now();
          }
        }
        return makeSqlResult<T>([]);
      }

      // DELETE FROM task_deps WHERE source_id = ? AND target_id = ?
      if (trimmed.startsWith("DELETE FROM task_deps")) {
        const deps = getTable("task_deps");
        const idx = deps.findIndex(
          (r) => r.source_id === bindings[0] && r.target_id === bindings[1],
        );
        if (idx >= 0) deps.splice(idx, 1);
        return makeSqlResult<T>([]);
      }

      throw new Error(`Unhandled SQL query in mock: ${trimmed}`);
    },
  };
}
