/**
 * Bundle-side vector-memory capability — thin RPC proxy to VectorMemoryService.
 *
 * Reads the unified per-turn capability token from `env.__BUNDLE_TOKEN`
 * whose `scope` array includes `"vector-memory"`. VectorMemoryService
 * verifies the token with `requiredScope: "vector-memory"`. No credentials
 * held here, no business logic beyond RPC marshaling.
 *
 * This client registers two tools (`memory_search`, `memory_get`) and a
 * content-only `promptSections` describing the memory system. It registers
 * NO `hooks` — the static `vectorMemory(...)` capability's
 * `afterToolExecution` indexing hook fires for bundle-originated
 * `file_write`/`file_edit`/`file_delete` events via the Phase 0 host-hook
 * bridge, so auto-reindexing works without a duplicate bundle-side hook.
 */

import type { Capability } from "@crabbykit/agent-runtime";
import { defineTool } from "@crabbykit/agent-runtime";
import {
  MEMORY_GET_TOOL_DESCRIPTION,
  MEMORY_GET_TOOL_NAME,
  MEMORY_SEARCH_TOOL_DESCRIPTION,
  MEMORY_SEARCH_TOOL_NAME,
  MemoryGetArgsSchema,
  MemorySearchArgsSchema,
  SCHEMA_CONTENT_HASH,
} from "./schemas.js";
import type { VectorMemoryService } from "./service.js";

export interface VectorMemoryClientOptions {
  service: Service<VectorMemoryService>;
}

/**
 * Create a bundle-side vector-memory capability that proxies `memory_search`
 * and `memory_get` to VectorMemoryService.
 */
export function vectorMemoryClient(options: VectorMemoryClientOptions): Capability {
  return {
    id: "vector-memory",
    name: "Vector Memory (Bundle Client)",
    description: "Persistent semantic memory with vector search (proxied through service binding)",

    tools: (context) => {
      const env = (context as unknown as { env: { __BUNDLE_TOKEN?: string } }).env;

      return [
        defineTool({
          name: MEMORY_SEARCH_TOOL_NAME,
          description: MEMORY_SEARCH_TOOL_DESCRIPTION,
          parameters: MemorySearchArgsSchema,
          execute: async (args) => {
            const token = env?.__BUNDLE_TOKEN;
            if (!token) throw new Error("Missing __BUNDLE_TOKEN");

            const result = await options.service.search(
              token,
              { query: args.query, maxResults: args.maxResults },
              SCHEMA_CONTENT_HASH,
            );

            if (result.results.length === 0) {
              return "No memory content found matching your query.";
            }

            return result.results
              .map((r, idx) => {
                const score = ` (score: ${r.score.toFixed(3)})`;
                return `[${idx + 1}] ${r.path}${score}\n${r.snippet}`;
              })
              .join("\n\n---\n\n");
          },
        }),

        defineTool({
          name: MEMORY_GET_TOOL_NAME,
          description: MEMORY_GET_TOOL_DESCRIPTION,
          parameters: MemoryGetArgsSchema,
          execute: async (args) => {
            const token = env?.__BUNDLE_TOKEN;
            if (!token) throw new Error("Missing __BUNDLE_TOKEN");

            const result = await options.service.get(
              token,
              { path: args.path },
              SCHEMA_CONTENT_HASH,
            );

            return result.content || "No content found.";
          },
        }),
      ];
    },

    // Prompt text is intentionally identical to the static capability's
    // section. The "automatically indexed" claim is accurate for bundles
    // too via the Phase 0 host-hook bridge.
    promptSections: () => [
      [
        "You have persistent memory across conversations via markdown files.",
        "- Write to MEMORY.md for curated long-term memory (key decisions, preferences, important facts).",
        "- Write to memory/*.md for topic-specific or daily notes (e.g. memory/2026-03-28.md).",
        "- Use file_write/file_edit to create and update memory files — they are automatically indexed for search.",
        "- Use memory_search to find previously saved information by describing what you're looking for.",
        "- Use memory_get to read the full content of a specific memory file.",
      ].join("\n"),
    ],
  };
}
