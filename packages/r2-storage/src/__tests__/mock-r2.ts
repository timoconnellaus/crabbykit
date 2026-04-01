/**
 * In-memory mock of R2Bucket for unit testing.
 * Implements the subset of R2Bucket used by the file tools.
 */
export function createMockR2Bucket(): R2Bucket {
  const store = new Map<string, string>();

  return {
    get: async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      const encoded = new TextEncoder().encode(value);
      return {
        text: async () => value,
        arrayBuffer: async () => encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
        key,
        size: encoded.byteLength,
      } as unknown as R2ObjectBody;
    },

    put: async (key: string, value: string | ReadableStream | ArrayBuffer | null) => {
      if (typeof value === "string") {
        store.set(key, value);
      } else if (value instanceof ArrayBuffer) {
        store.set(key, new TextDecoder().decode(value));
      } else {
        store.set(key, "");
      }
      return {} as R2Object;
    },

    delete: async (keys: string | string[]) => {
      if (Array.isArray(keys)) {
        for (const k of keys) store.delete(k);
      } else {
        store.delete(keys);
      }
    },

    head: async (key: string) => {
      if (!store.has(key)) return null;
      return { key } as R2Object;
    },

    list: async (options?: R2ListOptions) => {
      const prefix = options?.prefix ?? "";
      const delimiter = options?.delimiter;
      const limit = options?.limit ?? 1000;

      const objects: Array<{ key: string }> = [];
      const delimitedPrefixes: string[] = [];
      const prefixSet = new Set<string>();

      const sortedKeys = [...store.keys()].sort();

      for (const key of sortedKeys) {
        if (!key.startsWith(prefix)) continue;

        const rest = key.slice(prefix.length);
        if (delimiter) {
          const delimIndex = rest.indexOf(delimiter);
          if (delimIndex >= 0) {
            // This key falls into a "directory" — add the prefix
            const dirPrefix = prefix + rest.slice(0, delimIndex + 1);
            if (!prefixSet.has(dirPrefix)) {
              prefixSet.add(dirPrefix);
              delimitedPrefixes.push(dirPrefix);
            }
            continue;
          }
        }

        objects.push({ key });
      }

      // Apply limit (simplified — real R2 limits total, here we just cap)
      const totalVisible = objects.length + delimitedPrefixes.length;
      const truncated = totalVisible > limit;

      return {
        objects: objects.slice(0, limit) as unknown as R2Object[],
        delimitedPrefixes: delimitedPrefixes.slice(0, limit),
        truncated,
        cursor: truncated ? "mock-cursor" : undefined,
      } as unknown as R2Objects;
    },

    createMultipartUpload: () => {
      throw new Error("Not implemented in mock");
    },
    resumeMultipartUpload: () => {
      throw new Error("Not implemented in mock");
    },
  } as unknown as R2Bucket;
}

/**
 * Create a mock R2Bucket where every operation throws.
 * Useful for testing error catch paths in tool implementations.
 */
export function createFailingR2Bucket(message = "R2 service unavailable"): R2Bucket {
  const fail = () => {
    throw new Error(message);
  };
  return {
    get: fail,
    put: fail,
    delete: fail,
    head: fail,
    list: fail,
    createMultipartUpload: fail,
    resumeMultipartUpload: fail,
  } as unknown as R2Bucket;
}

/** Helper to seed the mock bucket with files */
export function seedBucket(
  bucket: R2Bucket,
  prefix: string,
  files: Record<string, string>,
): Promise<unknown[]> {
  return Promise.all(
    Object.entries(files).map(([path, content]) => bucket.put(`${prefix}/${path}`, content)),
  );
}
