/**
 * Cloudflare adapter functions that wrap CF primitives into generic storage interfaces.
 */

import type { KvStore, SqlResult, SqlStore } from "./types.js";

/**
 * Wrap a Cloudflare SqlStorage into a platform-agnostic SqlStore.
 * Delegates exec() directly — CF's cursor already satisfies SqlResult.
 */
export function createCfSqlStore(sql: SqlStorage): SqlStore {
  return {
    exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlResult<T> =>
      // CF's SqlStorageCursor satisfies SqlResult — the generic cast is safe
      // because the cursor's toArray/one/iterator return the same row shape
      sql.exec(query, ...bindings) as unknown as SqlResult<T>,
  };
}

/**
 * Wrap a Cloudflare DurableObjectStorage into a platform-agnostic KvStore.
 * Delegates all operations to the corresponding DurableObjectStorage methods.
 */
export function createCfKvStore(storage: DurableObjectStorage): KvStore {
  return {
    get: <T = unknown>(key: string) => storage.get<T>(key),
    put: (key: string, value: unknown) => storage.put(key, value),
    delete: (key: string) => storage.delete(key),
    list: <T = unknown>(options?: { prefix?: string }) =>
      storage.list<T>(options ? { prefix: options.prefix } : undefined),
  };
}
