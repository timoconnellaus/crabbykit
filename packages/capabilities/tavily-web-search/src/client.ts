/**
 * Bundle-side Tavily capability — thin RPC proxy to TavilyService.
 *
 * Reads the capability token from env.__SPINE_TOKEN. No credentials.
 * No business logic beyond RPC marshaling.
 */

import type { Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import {
  FETCH_TOOL_DESCRIPTION,
  FETCH_TOOL_NAME,
  SCHEMA_CONTENT_HASH,
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_NAME,
} from "./schemas.js";
import type { TavilyService } from "./service.js";

export interface TavilyClientOptions {
  service: Service<TavilyService>;
}

/**
 * Create a bundle-side Tavily capability that proxies to TavilyService.
 */
export function tavilyClient(options: TavilyClientOptions): Capability {
  return {
    id: "tavily-web-search",
    name: "Tavily Web Search (Bundle Client)",
    description: "Web search and page fetch via Tavily API (proxied through service binding)",

    tools: (context) => {
      const env = (context as unknown as { env: { __SPINE_TOKEN?: string } }).env;

      return [
        defineTool({
          name: SEARCH_TOOL_NAME,
          description: SEARCH_TOOL_DESCRIPTION,
          parameters: Type.Object({
            query: Type.String({ description: "The search query" }),
            maxResults: Type.Optional(
              Type.Number({ description: "Max results", minimum: 1, maximum: 20 }),
            ),
          }),
          execute: async (args) => {
            const token = env?.__SPINE_TOKEN;
            if (!token) throw new Error("Missing __SPINE_TOKEN");

            const result = await options.service.search(
              token,
              { query: args.query, maxResults: args.maxResults },
              SCHEMA_CONTENT_HASH,
            );

            const text = result.results
              .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content}`)
              .join("\n\n");

            return text || "No results found.";
          },
        }),

        defineTool({
          name: FETCH_TOOL_NAME,
          description: FETCH_TOOL_DESCRIPTION,
          parameters: Type.Object({
            url: Type.String({ description: "The URL to fetch" }),
          }),
          execute: async (args) => {
            const token = env?.__SPINE_TOKEN;
            if (!token) throw new Error("Missing __SPINE_TOKEN");

            const result = await options.service.extract(
              token,
              { url: args.url },
              SCHEMA_CONTENT_HASH,
            );

            return result.content || "No content extracted.";
          },
        }),
      ];
    },
  };
}
