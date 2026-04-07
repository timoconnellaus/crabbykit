const DB_INTERNAL_URL = "http://db.internal";

/** Result from a SQL exec() call, matching the deployed env.DB shape. */
export interface SqlResult {
  columns: string[];
  rows: unknown[][];
}

/** A database client compatible with the deployed env.DB interface. */
export interface DB {
  /** Execute a single SQL statement. */
  exec(sql: string, params?: unknown[]): Promise<SqlResult>;
  /** Execute multiple SQL statements as a batch. */
  batch(statements: { sql: string; params?: unknown[] }[]): Promise<{ results: SqlResult[] }>;
}

export interface CreateDBOptions {
  /** Override the backendId (defaults to CLAW_DB_BACKEND_ID env var). */
  backendId?: string;
}

/**
 * Create a database client that communicates with the host Worker
 * via the `db.internal` virtual host (intercepted by SandboxContainer).
 *
 * In deployed workers, `env.DB` provides the same interface via the
 * `start_backend` wrapper. Using this client in containers ensures
 * the same code works in both environments.
 */
export function createDB(options?: CreateDBOptions): DB {
  const backendId = options?.backendId ?? process.env.CLAW_DB_BACKEND_ID;
  if (!backendId) {
    throw new Error("CLAW_DB_BACKEND_ID not set");
  }

  return {
    async exec(sql: string, params: unknown[] = []): Promise<SqlResult> {
      const response = await fetch(`${DB_INTERNAL_URL}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql, params, backendId }),
      });

      const body = await response.json();

      if (!response.ok) {
        const err = body as { error?: string };
        throw new Error(err.error ?? `Database error (${response.status})`);
      }

      return body as SqlResult;
    },

    async batch(
      statements: { sql: string; params?: unknown[] }[],
    ): Promise<{ results: SqlResult[] }> {
      const response = await fetch(`${DB_INTERNAL_URL}/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statements, backendId }),
      });

      const body = await response.json();

      if (!response.ok) {
        const err = body as { error?: string };
        throw new Error(err.error ?? `Database error (${response.status})`);
      }

      return body as { results: SqlResult[] };
    },
  };
}
