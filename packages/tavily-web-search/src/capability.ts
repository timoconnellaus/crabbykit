import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import { createFetchTool } from "./fetch.js";
import type { TavilySearchDefaults } from "./search.js";
import { createSearchTool } from "./search.js";

const DEFAULT_MAX_RESULTS = 5;

export interface TavilyWebSearchOptions {
  /** Tavily API key — string or getter function. */
  tavilyApiKey: string | (() => string);
  /** Maximum search results (default 5). */
  maxResults?: number;
  /** User-Agent header for web_fetch (default "ClawAgent/1.0"). */
  userAgent?: string;
  /** Maximum fetch content size in chars (default 50,000). */
  maxFetchSize?: number;
  /** Default search options applied to every search unless overridden per-call. */
  searchDefaults?: TavilySearchDefaults;
}

/**
 * Create a web search capability with Tavily-powered search and URL fetching.
 *
 * Provides two tools:
 * - `web_search` — Search the web via Tavily API
 * - `web_fetch` — Fetch and extract content from a URL
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   return [
 *     tavilyWebSearch({
 *       tavilyApiKey: () => this.env.TAVILY_API_KEY,
 *     }),
 *   ];
 * }
 * ```
 */
export function tavilyWebSearch(options: TavilyWebSearchOptions): Capability {
  const getApiKey =
    typeof options.tavilyApiKey === "function"
      ? options.tavilyApiKey
      : () => options.tavilyApiKey as string;

  return {
    id: "tavily-web-search",
    name: "Web Search (Tavily)",
    description: "Search the web and fetch URLs for current information.",
    tools: (context: AgentContext) => [
      createSearchTool(
        getApiKey,
        options.maxResults ?? DEFAULT_MAX_RESULTS,
        context,
        options.searchDefaults,
      ),
      createFetchTool(options.userAgent, options.maxFetchSize, context),
    ],
    promptSections: () => [
      "You have access to web search and URL fetching. Use web_search to find current information, then web_fetch to read specific pages in detail.",
    ],
  };
}
