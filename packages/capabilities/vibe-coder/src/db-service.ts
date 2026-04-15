import { WorkerEntrypoint } from "cloudflare:workers";
import type { SqlResult } from "./backend-storage-do.js";

/**
 * Environment the DbService needs — must include the BackendStorage DO namespace.
 * The host worker provides this via wrangler service binding config.
 */
export interface DbServiceEnv {
  BACKEND_STORAGE: DurableObjectNamespace;
  [key: string]: unknown;
}

/**
 * WorkerEntrypoint that proxies SQL operations to a BackendStorage Durable Object.
 *
 * Each call includes a `backendId` that identifies which DO instance to use.
 * Different apps get different backend IDs → different DO instances → separate
 * SQLite databases.
 *
 * Dynamic workers loaded via WorkerLoader can't receive DO stubs directly
 * (they aren't serializable). Instead, this entrypoint is registered as a
 * service binding on the host worker and passed to dynamic workers via `env`.
 *
 * The `start_backend` tool generates a wrapper that injects the backend ID
 * automatically, so app code just calls `env.DB.exec(sql, params)`.
 *
 * Consumers export this class and register it as a service binding in wrangler:
 * ```jsonc
 * "services": [{
 *   "binding": "DB_SERVICE",
 *   "service": "<worker-name>",
 *   "entrypoint": "DbService"
 * }]
 * ```
 */
export class DbService extends WorkerEntrypoint<DbServiceEnv> {
  /** Execute a single SQL statement against a specific backend's database. */
  async exec(backendId: string, sql: string, params: unknown[] = []): Promise<SqlResult> {
    const stub = this.getStub(backendId);
    const res = await stub.fetch("http://do/exec", {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) {
      const error = (await res.json()) as { error: string };
      throw new Error(error.error);
    }
    return res.json() as Promise<SqlResult>;
  }

  /** Execute multiple SQL statements as a batch. */
  async batch(
    backendId: string,
    statements: { sql: string; params?: unknown[] }[],
  ): Promise<{ results: SqlResult[] }> {
    const stub = this.getStub(backendId);
    const res = await stub.fetch("http://do/batch", {
      method: "POST",
      body: JSON.stringify({ statements }),
    });
    if (!res.ok) {
      const error = (await res.json()) as { error: string };
      throw new Error(error.error);
    }
    return res.json() as Promise<{ results: SqlResult[] }>;
  }

  private getStub(backendId: string) {
    const id = this.env.BACKEND_STORAGE.idFromName(backendId);
    return this.env.BACKEND_STORAGE.get(id);
  }
}
