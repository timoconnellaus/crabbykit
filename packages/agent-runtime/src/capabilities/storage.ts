/**
 * Scoped persistent key-value storage for capabilities.
 * Each capability gets its own key namespace in Durable Object storage.
 */

/**
 * Key-value storage scoped to a single capability.
 * Keys are automatically namespaced — capabilities cannot access each other's data.
 */
export interface CapabilityStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(prefix?: string): Promise<Map<string, T>>;
}

/**
 * Create a CapabilityStorage backed by Durable Object KV storage.
 * All keys are prefixed with `cap:{capabilityId}:` to isolate capability data.
 */
export function createCapabilityStorage(
  doStorage: DurableObjectStorage,
  capabilityId: string,
): CapabilityStorage {
  const keyPrefix = `cap:${capabilityId}:`;

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return doStorage.get<T>(`${keyPrefix}${key}`);
    },

    async put(key: string, value: unknown): Promise<void> {
      await doStorage.put(`${keyPrefix}${key}`, value);
    },

    async delete(key: string): Promise<boolean> {
      return doStorage.delete(`${keyPrefix}${key}`);
    },

    async list<T = unknown>(prefix?: string): Promise<Map<string, T>> {
      const fullPrefix = `${keyPrefix}${prefix ?? ""}`;
      const raw = await doStorage.list<T>({ prefix: fullPrefix });
      const stripped = new Map<string, T>();
      for (const [k, v] of raw) {
        stripped.set(k.slice(keyPrefix.length), v);
      }
      return stripped;
    },
  };
}

/**
 * No-op storage that discards writes and returns empty results.
 * Used when no real Durable Object storage is available (e.g., tests without DO).
 */
export function createNoopStorage(): CapabilityStorage {
  return {
    async get() {
      return undefined;
    },
    async put() {},
    async delete() {
      return false;
    },
    async list() {
      return new Map();
    },
  };
}
