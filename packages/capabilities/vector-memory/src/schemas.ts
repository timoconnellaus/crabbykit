/**
 * Shared tool schemas for vector-memory.
 *
 * Used by both the static capability (capability.ts) and the capability service
 * (service.ts/client.ts) to ensure schema consistency across the bundle
 * boundary.
 */

import { Type } from "@sinclair/typebox";

// --- Memory search tool schema ---

export const MemorySearchArgsSchema = Type.Object({
  query: Type.String({ description: "Natural language search query" }),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default 5)",
      minimum: 1,
      maximum: 20,
    }),
  ),
});

export const MEMORY_SEARCH_TOOL_NAME = "memory_search";
export const MEMORY_SEARCH_TOOL_DESCRIPTION =
  "Search memory files using semantic similarity. Returns relevant snippets with file locations.";

// --- Memory get tool schema ---

export const MemoryGetArgsSchema = Type.Object({
  path: Type.String({
    description: "Path to the memory file (e.g. 'MEMORY.md' or 'memory/notes.md')",
  }),
});

export const MEMORY_GET_TOOL_NAME = "memory_get";
export const MEMORY_GET_TOOL_DESCRIPTION =
  "Read the full content of a memory file.";

// --- Schema content hash for drift detection ---

/**
 * Content hash of the schemas. Both service and client compare this at RPC
 * time to detect cross-version drift. Defensive consistency check, not a
 * security boundary. Bumped by hand when the args schemas change in a way
 * that would silently mistype older bundles against a newer host.
 */
export const SCHEMA_CONTENT_HASH = "vector-memory-schemas-v1";
