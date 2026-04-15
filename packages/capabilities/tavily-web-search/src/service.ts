/**
 * TavilyService — host-side WorkerEntrypoint holding Tavily API credentials.
 *
 * Bundle-side clients call through via JSRPC with a capability token.
 * Cost emission via spine. Errors sanitized before crossing RPC boundary.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { SCHEMA_CONTENT_HASH } from "./schemas.js";

const TAVILY_API_URL = "https://api.tavily.com";
const TAVILY_SEARCH_COST_USD = 0.01;
const TAVILY_EXTRACT_COST_USD = 0.005;

export interface TavilyServiceEnv {
  TAVILY_API_KEY: string;
  TAVILY_SUBKEY: CryptoKey;
  SPINE: Fetcher & { emitCost(token: string, costEvent: unknown): Promise<void> };
}

export class TavilyService extends WorkerEntrypoint<TavilyServiceEnv> {
  async search(
    token: string,
    args: {
      query: string;
      maxResults?: number;
      searchDepth?: string;
      includeDomains?: string[];
      excludeDomains?: string[];
    },
    schemaHash?: string,
  ): Promise<{ results: Array<{ title: string; url: string; content: string }> }> {
    // Schema drift detection
    if (schemaHash && schemaHash !== SCHEMA_CONTENT_HASH) {
      throw new Error("ERR_SCHEMA_VERSION");
    }

    // Token verification would happen here via TAVILY_SUBKEY
    // (simplified for initial implementation — full verify in integration)

    try {
      const res = await fetch(`${TAVILY_API_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.env.TAVILY_API_KEY,
          query: args.query,
          max_results: args.maxResults ?? 5,
          search_depth: args.searchDepth ?? "basic",
          include_domains: args.includeDomains,
          exclude_domains: args.excludeDomains,
        }),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error("ERR_UPSTREAM_AUTH");
        if (res.status === 429) throw new Error("ERR_UPSTREAM_RATE");
        throw new Error("ERR_UPSTREAM_OTHER");
      }

      const data = (await res.json()) as {
        results: Array<{ title: string; url: string; content: string }>;
      };

      // Emit cost via spine
      try {
        await this.env.SPINE.emitCost(token, {
          capabilityId: "tavily",
          toolName: "web_search",
          amount: TAVILY_SEARCH_COST_USD,
          currency: "USD",
        });
      } catch {
        // Cost emission failure doesn't block
      }

      return { results: data.results ?? [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("ERR_")) throw new Error(msg);
      throw new Error("ERR_UPSTREAM_OTHER");
    }
  }

  async extract(
    token: string,
    args: { url: string },
    schemaHash?: string,
  ): Promise<{ content: string }> {
    if (schemaHash && schemaHash !== SCHEMA_CONTENT_HASH) {
      throw new Error("ERR_SCHEMA_VERSION");
    }

    try {
      const res = await fetch(`${TAVILY_API_URL}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.env.TAVILY_API_KEY,
          urls: [args.url],
        }),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error("ERR_UPSTREAM_AUTH");
        if (res.status === 429) throw new Error("ERR_UPSTREAM_RATE");
        throw new Error("ERR_UPSTREAM_OTHER");
      }

      const data = (await res.json()) as { results: Array<{ raw_content: string }> };

      try {
        await this.env.SPINE.emitCost(token, {
          capabilityId: "tavily",
          toolName: "web_fetch",
          amount: TAVILY_EXTRACT_COST_USD,
          currency: "USD",
        });
      } catch {
        // Cost emission failure doesn't block
      }

      const content = data.results?.[0]?.raw_content ?? "";
      return { content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("ERR_")) throw new Error(msg);
      throw new Error("ERR_UPSTREAM_OTHER");
    }
  }
}
