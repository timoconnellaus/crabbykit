import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";

/**
 * In-memory mock of CapabilityStorage for testing.
 */
export function createMockStorage(): CapabilityStorage {
  const data = new Map<string, unknown>();

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },

    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },

    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },

    async list<T = unknown>(prefix?: string): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [k, v] of data) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v as T);
        }
      }
      return result;
    },
  };
}
