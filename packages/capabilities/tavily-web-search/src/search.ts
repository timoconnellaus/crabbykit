import { type AgentContext, type AnyAgentTool, defineTool, Type } from "@crabbykit/agent-runtime";

const TAVILY_API_URL = "https://api.tavily.com/search";
const TAVILY_SEARCH_COST_USD = 0.01;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results: TavilyResult[];
}

/** Default search options that can be overridden per-call via tool parameters. */
export interface TavilySearchDefaults {
  /** Search depth: "basic" (faster/cheaper) or "advanced" (deeper). Default "basic". */
  searchDepth?: "basic" | "advanced";
  /** Restrict results to these domains. */
  includeDomains?: string[];
  /** Exclude results from these domains. */
  excludeDomains?: string[];
}

/**
 * Create a web_search tool backed by the Tavily API.
 */
export function createSearchTool(
  getApiKey: () => string,
  maxResults: number,
  context: AgentContext,
  defaults?: TavilySearchDefaults,
): AnyAgentTool {
  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and content snippets.",
    guidance:
      "Use web_search to find current information from the web. Prefer this as a first step when the user asks about something you're unsure of. After searching, use web_fetch to read specific pages in detail.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      search_depth: Type.Optional(
        Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
          description: 'Search depth: "basic" (faster) or "advanced" (deeper). Default "basic".',
        }),
      ),
      include_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Restrict results to these domains (e.g. ["example.com"]).',
        }),
      ),
      exclude_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exclude results from these domains.",
        }),
      ),
    }),
    execute: async ({ query, search_depth, include_domains, exclude_domains }) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [{ type: "text" as const, text: "Error: Tavily API key is not configured." }],
          details: { error: "missing_api_key" },
        };
      }

      try {
        const response = await fetch(TAVILY_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults,
            search_depth: search_depth ?? defaults?.searchDepth ?? "basic",
            ...((include_domains ?? defaults?.includeDomains)
              ? { include_domains: include_domains ?? defaults?.includeDomains }
              : {}),
            ...((exclude_domains ?? defaults?.excludeDomains)
              ? { exclude_domains: exclude_domains ?? defaults?.excludeDomains }
              : {}),
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Tavily API returned ${response.status}: ${errorText}`,
              },
            ],
            details: { error: "api_error", status: response.status },
          };
        }

        const data = (await response.json()) as TavilyResponse;

        if (!data.results || data.results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
            details: { query, resultCount: 0 },
          };
        }

        const formatted = data.results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content}`)
          .join("\n\n");

        context.emitCost({
          capabilityId: "tavily-web-search",
          toolName: "web_search",
          amount: TAVILY_SEARCH_COST_USD,
          currency: "USD",
          detail: `Search: ${query}`,
          metadata: { resultCount: data.results.length },
        });

        return {
          content: [{ type: "text" as const, text: formatted }],
          details: { query, resultCount: data.results.length },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching the web: ${message}`,
            },
          ],
          details: { error: "network_error", message },
        };
      }
    },
  });
}
