import { DurableObject } from "cloudflare:workers";

/** Result shape returned by SQL exec/query operations. */
export interface SqlResult {
  columns: string[];
  rows: unknown[][];
}

/**
 * Durable Object that provides SQLite storage for vibe-coder app backends.
 *
 * Each agent gets its own BackendStorage instance (keyed by agent ID).
 * Exposes SQL operations via fetch handler so dynamic workers loaded
 * through WorkerLoader can access the database.
 *
 * Consumers export this class from their worker and reference it
 * in wrangler.jsonc under `durable_objects` with `new_sqlite_classes`.
 *
 * @example
 * ```ts
 * // worker.ts
 * export { BackendStorage } from "@claw-for-cloudflare/vibe-coder";
 * ```
 */
export class BackendStorage extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (pathname === "/exec") {
      return this.handleExec(request);
    }

    if (pathname === "/batch") {
      return this.handleBatch(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleExec(request: Request): Promise<Response> {
    const { sql, params = [] } = (await request.json()) as {
      sql: string;
      params?: unknown[];
    };

    try {
      const cursor = this.ctx.storage.sql.exec(sql, ...params);
      const result: SqlResult = {
        columns: cursor.columnNames,
        rows: [...cursor.raw()],
      };
      return Response.json(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  private async handleBatch(request: Request): Promise<Response> {
    const { statements } = (await request.json()) as {
      statements: { sql: string; params?: unknown[] }[];
    };

    try {
      const results: SqlResult[] = [];
      for (const stmt of statements) {
        const cursor = this.ctx.storage.sql.exec(stmt.sql, ...(stmt.params ?? []));
        results.push({
          columns: cursor.columnNames,
          rows: [...cursor.raw()],
        });
      }
      return Response.json({ results });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ error: message }, { status: 400 });
    }
  }
}
