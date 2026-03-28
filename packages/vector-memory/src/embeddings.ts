export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_COST_PER_TOKEN = 0.000000011;

/** Maximum texts per Workers AI embedding call. */
const MAX_BATCH_SIZE = 100;

/** Function that embeds a batch of texts into vectors. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * Create an embedding function backed by Cloudflare Workers AI.
 * Automatically batches requests when texts.length exceeds MAX_BATCH_SIZE.
 */
export function createWorkersAiEmbedder(getAi: () => Ai): EmbedFn {
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];

    const ai = getAi();
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      // biome-ignore lint/suspicious/noExplicitAny: Workers AI model name type is overly strict
      const response = await (ai as any).run(EMBEDDING_MODEL, { text: batch });
      const vectors = (response as { data: number[][] }).data;
      results.push(...vectors);
    }

    return results;
  };
}

/**
 * Estimate token count for a batch of texts.
 * Uses the rough approximation of 1 token ~ 4 characters.
 */
export function estimateTokenCount(texts: string[]): number {
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  return Math.ceil(totalChars / 4);
}
