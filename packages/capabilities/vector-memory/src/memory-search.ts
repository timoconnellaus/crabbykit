import { type AgentContext, defineTool, Type } from "@crabbykit/agent-runtime";
import type { EmbedFn } from "./embeddings.js";
import { EMBEDDING_COST_PER_TOKEN, estimateTokenCount } from "./embeddings.js";
import { formatResults, keywordSearch, vectorSearch } from "./searcher.js";

const CAPABILITY_ID = "vector-memory";
const _DEFAULT_MAX_RESULTS = 5;

export function createMemorySearchTool(
  getBucket: () => R2Bucket,
  getIndex: () => VectorizeIndex,
  getPrefix: () => string,
  embed: EmbedFn,
  maxSearchResults: number,
  context: AgentContext,
) {
  return defineTool({
    name: "memory_search",
    description:
      "Search memory files using semantic similarity. Returns relevant snippets with file locations.",
    guidance:
      "Search memory files using semantic similarity. Use this to find previously saved information by describing what you're looking for in natural language. Falls back to keyword search if vector search is unavailable.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      max_results: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: `Maximum results to return (default ${maxSearchResults})`,
        }),
      ),
    }),
    execute: async ({ query, max_results }) => {
      const effectiveMax = max_results ?? maxSearchResults;
      const prefix = getPrefix();

      // Try vector search first
      let results = await vectorSearch(query, effectiveMax, prefix, embed, getIndex(), getBucket);
      let notice = "";

      if (results !== null) {
        // Emit embedding cost for query
        const tokens = estimateTokenCount([query]);
        if (tokens > 0) {
          context.emitCost({
            capabilityId: CAPABILITY_ID,
            toolName: "memory_search",
            amount: tokens * EMBEDDING_COST_PER_TOKEN,
            currency: "USD",
            detail: `Search: ${query}`,
            metadata: { query, resultCount: results.length },
          });
        }
      } else {
        // Vector search failed — fall back to keyword search
        notice = "[Results from keyword search — semantic search unavailable]\n\n";
        results = await keywordSearch(query, effectiveMax, prefix, getBucket);
      }

      const text = formatResults(results, notice);
      return {
        content: [{ type: "text" as const, text }],
        details: { resultCount: results.length },
      };
    },
  });
}
