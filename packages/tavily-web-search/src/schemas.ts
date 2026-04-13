/**
 * Shared tool schemas for Tavily web search.
 * Used by both the static capability (index.ts) and the capability service
 * (service.ts/client.ts) to ensure schema consistency.
 */

import { Type } from "@sinclair/typebox";

// --- Search tool schema ---

export const SearchArgsSchema = Type.Object({
  query: Type.String({ description: "The search query" }),
  maxResults: Type.Optional(
    Type.Number({
      description: "Max results to return (default: from config)",
      minimum: 1,
      maximum: 20,
    }),
  ),
  searchDepth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "Search depth: basic (faster) or advanced (deeper)",
    }),
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), { description: "Restrict results to these domains" }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), { description: "Exclude results from these domains" }),
  ),
});

export const SEARCH_TOOL_NAME = "web_search";
export const SEARCH_TOOL_DESCRIPTION =
  "Search the web for current information. Returns titles, URLs, and content snippets.";

// --- Fetch tool schema ---

export const FetchArgsSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch content from" }),
});

export const FETCH_TOOL_NAME = "web_fetch";
export const FETCH_TOOL_DESCRIPTION =
  "Fetch and extract content from a specific web page URL. Returns the page text content.";

// --- Schema content hash for drift detection ---

/**
 * Content hash of the schemas. Both service and client compare this
 * at RPC time to detect cross-version drift. This is a defensive
 * consistency check, not a security boundary.
 */
export const SCHEMA_CONTENT_HASH = "tavily-schemas-v1";
