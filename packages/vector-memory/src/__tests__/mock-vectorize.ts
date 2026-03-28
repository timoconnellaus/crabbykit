/**
 * In-memory mock of the Cloudflare Vectorize index.
 * Stores vectors and implements basic cosine similarity search.
 */

interface StoredVector {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

export function createMockVectorize(): VectorizeIndex {
  const store = new Map<string, StoredVector>();

  return {
    async upsert(vectors: VectorizeVector[]) {
      for (const v of vectors) {
        store.set(v.id, {
          id: v.id,
          values: v.values as number[],
          namespace: v.namespace,
          metadata: v.metadata as Record<string, unknown> | undefined,
        });
      }
      return {
        mutationId: "mock",
        ids: vectors.map((v) => v.id),
        count: vectors.length,
      } as VectorizeVectorMutation;
    },

    async query(
      vector: number[] | Float32Array | Float64Array,
      options?: VectorizeQueryOptions,
    ): Promise<VectorizeMatches> {
      const queryVec = Array.from(vector);
      const topK = options?.topK ?? 10;
      const namespace = options?.namespace;

      const scored: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];

      for (const stored of store.values()) {
        if (namespace && stored.namespace !== namespace) continue;
        const score = cosineSimilarity(queryVec, stored.values);
        scored.push({
          id: stored.id,
          score,
          metadata: options?.returnMetadata ? stored.metadata : undefined,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      const matches = scored.slice(0, topK).map((s) => ({
        id: s.id,
        score: s.score,
        metadata: s.metadata ?? null,
        values: undefined as unknown as number[],
        namespace: namespace ?? undefined,
      }));

      return { matches, count: matches.length } as unknown as VectorizeMatches;
    },

    async deleteByIds(ids: string[]) {
      for (const id of ids) {
        store.delete(id);
      }
      return { mutationId: "mock", ids, count: ids.length } as VectorizeVectorMutation;
    },

    // Stubs for unused methods
    async insert(vectors: VectorizeVector[]) {
      return this.upsert(vectors);
    },
    async getByIds(_ids: string[]): Promise<VectorizeVector[]> {
      return [];
    },
    async describe(): Promise<VectorizeIndexDetails> {
      return {} as VectorizeIndexDetails;
    },
  };
}
