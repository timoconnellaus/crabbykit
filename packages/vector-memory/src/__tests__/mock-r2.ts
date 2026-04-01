/**
 * In-memory mock of R2Bucket for testing searcher, memory-get, memory-search.
 */

interface StoredObject {
  key: string;
  body: string;
}

export function createMockR2Bucket(
  initial: Record<string, string> = {},
): R2Bucket {
  const store = new Map<string, StoredObject>();

  for (const [key, body] of Object.entries(initial)) {
    store.set(key, { key, body });
  }

  return {
    async get(key: string) {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        key: obj.key,
        text: async () => obj.body,
        arrayBuffer: async () => new TextEncoder().encode(obj.body).buffer,
      } as unknown as R2ObjectBody;
    },

    async put(key: string, value: string | ArrayBuffer | ReadableStream) {
      const body =
        typeof value === "string"
          ? value
          : value instanceof ArrayBuffer
            ? new TextDecoder().decode(value)
            : "";
      store.set(key, { key, body });
      return {} as R2Object;
    },

    async head(key: string) {
      return store.has(key)
        ? ({ key } as R2Object)
        : null;
    },

    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? "";
      const objects: Array<{ key: string }> = [];
      for (const [key] of store) {
        if (key.startsWith(prefix)) {
          objects.push({ key });
        }
      }
      return {
        objects,
        truncated: false,
        cursor: undefined,
      } as unknown as R2Objects;
    },

    async delete(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        store.delete(k);
      }
    },
  } as unknown as R2Bucket;
}
