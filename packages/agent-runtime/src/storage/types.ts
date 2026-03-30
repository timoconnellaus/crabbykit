/**
 * Platform-agnostic storage interfaces.
 * Decouples stores from Cloudflare-specific types (SqlStorage, DurableObjectStorage).
 */

/**
 * Result of a SQL query execution.
 * Provides multiple ways to access rows: array, single row, or iteration.
 */
export interface SqlResult<T> {
  toArray(): T[];
  one(): T | null;
  [Symbol.iterator](): Iterator<T>;
}

/**
 * Synchronous SQL execution interface.
 * Accepts a SQL query string with positional `?` parameter bindings.
 */
export interface SqlStore {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlResult<T>;
}

/**
 * Async key-value storage interface.
 * Provides typed get/put/delete/list operations.
 */
export interface KvStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}
