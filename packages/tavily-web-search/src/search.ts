import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { type AgentContext, defineTool, Type } from "@claw-for-cloudflare/agent-runtime";

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

/**
 * Create a web_search tool backed by the Tavily API.
 */
export function createSearchTool(
  getApiKey: () => string,
  maxResults: number,
  context: AgentContext,
): AgentTool {
  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and content snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
    }),
    execute: async (_toolCallId, { query }) => {
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
  }) as unknown as AgentTool;
}
