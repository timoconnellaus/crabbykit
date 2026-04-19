/**
 * TavilyService — host-side WorkerEntrypoint holding Tavily API credentials.
 *
 * Bundle-side clients call through via JSRPC with a capability token.
 * Cost emission via spine. Errors sanitized before crossing RPC boundary.
 *
 * Token verification: the unified bundle capability token is verified with
 * `requiredScope: "tavily-web-search"` (this capability's kebab-case id).
 * The HKDF subkey is derived from `AGENT_AUTH_KEY` using the shared
 * `BUNDLE_SUBKEY_LABEL` (`"claw/bundle-v1"`), same as SpineService and
 * LlmService.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { BUNDLE_SUBKEY_LABEL, deriveVerifyOnlySubkey, verifyToken } from "@crabbykit/bundle-token";
import { SCHEMA_CONTENT_HASH } from "./schemas.js";

const TAVILY_API_URL = "https://api.tavily.com";
const TAVILY_SEARCH_COST_USD = 0.01;
const TAVILY_EXTRACT_COST_USD = 0.005;

export interface TavilyServiceEnv {
  TAVILY_API_KEY: string;
  /**
   * Master HMAC secret (string). TavilyService derives its own verify-only
   * subkey from this on first call using the unified HKDF label
   * `claw/bundle-v1` (via `BUNDLE_SUBKEY_LABEL`). Replaces the previous
   * `TAVILY_SUBKEY: CryptoKey` field which was declared but never populated.
   */
  AGENT_AUTH_KEY: string;
  SPINE: Fetcher & { emitCost(token: string, costEvent: unknown): Promise<void> };
}

export class TavilyService extends WorkerEntrypoint<TavilyServiceEnv> {
  private subkeyPromise: Promise<CryptoKey> | null = null;

  /**
   * Lazily derive (and cache) the verify-only HKDF subkey from the
   * master `AGENT_AUTH_KEY`. Uses the unified `BUNDLE_SUBKEY_LABEL`.
   */
  private getSubkey(): Promise<CryptoKey> {
    if (!this.subkeyPromise) {
      if (!this.env.AGENT_AUTH_KEY) {
        throw new Error("TavilyService misconfigured: env.AGENT_AUTH_KEY is missing");
      }
      this.subkeyPromise = deriveVerifyOnlySubkey(this.env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    }
    return this.subkeyPromise;
  }

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

    // Verify token — requires "tavily-web-search" scope in the unified bundle token
    const subkey = await this.getSubkey();
    const verifyResult = await verifyToken(token, subkey, {
      requiredScope: "tavily-web-search",
    });
    if (!verifyResult.valid) {
      throw new Error(verifyResult.code);
    }

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

    // Verify token — requires "tavily-web-search" scope
    const subkey = await this.getSubkey();
    const verifyResult = await verifyToken(token, subkey, {
      requiredScope: "tavily-web-search",
    });
    if (!verifyResult.valid) {
      throw new Error(verifyResult.code);
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
