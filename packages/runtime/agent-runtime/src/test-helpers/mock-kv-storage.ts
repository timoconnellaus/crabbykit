/**
 * In-memory KvStore mock for testing.
 */

import type { KvStore } from "../storage/types.js";

export function createMockKvStore(): KvStore {
  const store = new Map<string, unknown>();

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },

    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },

    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },

    async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (!options?.prefix || k.startsWith(options.prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}
