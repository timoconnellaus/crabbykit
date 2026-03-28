import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { chunkMarkdown } from "./chunker.js";
import type { EmbedFn } from "./embeddings.js";

export interface IndexResult {
  chunksTotal: number;
  chunksEmbedded: number;
  vectorsDeleted: number;
}

/**
 * Index (or re-index) a memory file into Vectorize.
 *
 * Uses SHA-256 content hashing to avoid re-embedding unchanged chunks.
 * Vector IDs are formatted as `{path}:{startLine}`.
 * All errors are caught and logged — this function never throws.
 */
export async function indexDocument(
  path: string,
  content: string,
  prefix: string,
  embed: EmbedFn,
  vectorizeIndex: VectorizeIndex,
  storage: CapabilityStorage,
): Promise<IndexResult> {
  try {
    // Step 1: chunk
    const chunks = await chunkMarkdown(content);

    // Step 2: build new ID list and hash map
    const newIds = chunks.map((c) => `${path}:${c.startLine}`);
    const newHashes: Record<string, string> = {};
    for (const c of chunks) {
      newHashes[String(c.startLine)] = c.hash;
    }

    // Step 3: load old hashes from storage
    const oldHashes = (await storage.get<Record<string, string>>(`hashes:${path}`)) ?? {};
    const oldIds = (await storage.get<string[]>(`vectors:${path}`)) ?? [];

    // Step 4: find changed/new chunks
    const changedChunks = chunks.filter((c) => oldHashes[String(c.startLine)] !== c.hash);

    let chunksEmbedded = 0;

    if (changedChunks.length > 0) {
      // Step 5: embed changed chunks
      const texts = changedChunks.map((c) => c.content);
      const vectors = await embed(texts);

      if (vectors.length !== changedChunks.length) {
        console.error(
          `[vector-memory/indexer] embed returned ${vectors.length} vectors for ${changedChunks.length} chunks — skipping upsert`,
        );
      } else {
        // Step 6: upsert vectors
        const upsertPayload = changedChunks.map((chunk, idx) => ({
          id: `${path}:${chunk.startLine}`,
          values: vectors[idx],
          namespace: prefix,
          metadata: {
            path,
            prefix,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            hash: chunk.hash,
          },
        }));

        await vectorizeIndex.upsert(upsertPayload);
        chunksEmbedded = changedChunks.length;
      }
    }

    // Step 7: delete stale IDs
    const newIdSet = new Set(newIds);
    const staleIds = oldIds.filter((id) => !newIdSet.has(id));
    if (staleIds.length > 0) {
      await vectorizeIndex.deleteByIds(staleIds);
    }

    // Step 8: persist new hash map and vector IDs
    await storage.put(`hashes:${path}`, newHashes);
    await storage.put(`vectors:${path}`, newIds);

    return {
      chunksTotal: chunks.length,
      chunksEmbedded,
      vectorsDeleted: staleIds.length,
    };
  } catch (err) {
    console.error(`[vector-memory/indexer] indexDocument failed for ${path}:`, err);
    return { chunksTotal: 0, chunksEmbedded: 0, vectorsDeleted: 0 };
  }
}

/**
 * Remove all Vectorize entries for a deleted memory file.
 * Loads the stored vector ID list, deletes them from Vectorize,
 * then removes the storage keys. Never throws.
 */
export async function removeDocument(
  path: string,
  prefix: string,
  vectorizeIndex: VectorizeIndex,
  storage: CapabilityStorage,
): Promise<number> {
  try {
    const ids = (await storage.get<string[]>(`vectors:${path}`)) ?? [];

    if (ids.length > 0) {
      await vectorizeIndex.deleteByIds(ids);
    }

    await storage.delete(`hashes:${path}`);
    await storage.delete(`vectors:${path}`);

    return ids.length;
  } catch (err) {
    console.error(`[vector-memory/indexer] removeDocument failed for ${path}:`, err);
    return 0;
  }
}
