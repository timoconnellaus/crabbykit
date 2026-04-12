import {
  type AgentContext,
  type Capability,
  type Static,
  Type,
} from "@claw-for-cloudflare/agent-runtime";
import { createFetchTool } from "./fetch.js";
import { createSearchTool } from "./search.js";

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_USER_AGENT = "ClawAgent/1.0";
const DEFAULT_MAX_FETCH_SIZE = 50_000;

/**
 * TypeBox schema for the tavily-web-search capability's agent-level
 * config. `tavilyApiKey` intentionally stays in the factory closure —
 * it's a secret, not tunable config.
 */
export const TavilyConfigSchema = Type.Object({
  maxResults: Type.Integer({ default: DEFAULT_MAX_RESULTS, minimum: 1, maximum: 50 }),
  userAgent: Type.String({ default: DEFAULT_USER_AGENT }),
  maxFetchSize: Type.Integer({
    default: DEFAULT_MAX_FETCH_SIZE,
    minimum: 1_000,
    maximum: 1_000_000,
  }),
  searchDefaults: Type.Object({
    searchDepth: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("advanced")])),
    includeDomains: Type.Optional(Type.Array(Type.String())),
    excludeDomains: Type.Optional(Type.Array(Type.String())),
  }),
});

export type TavilyConfig = Static<typeof TavilyConfigSchema>;

export interface TavilyWebSearchOptions {
  /** Tavily API key — string or getter function. Stays in-closure. */
  tavilyApiKey: string | (() => string);
  /**
   * Agent-level config mapping. Typically `(c) => c.search`. Receives
   * the full agent config record and returns the slice this capability
   * consumes on each turn.
   */
  config?: (agentConfig: Record<string, unknown>) => TavilyConfig;

  /** @deprecated Use the agent-level `config` mapping. */
  maxResults?: number;
  /** @deprecated Use the agent-level `config` mapping. */
  userAgent?: string;
  /** @deprecated Use the agent-level `config` mapping. */
  maxFetchSize?: number;
  /** @deprecated Use the agent-level `config` mapping. */
  searchDefaults?: TavilyConfig["searchDefaults"];
}

function resolveConfig(
  options: TavilyWebSearchOptions,
  context: AgentContext,
): TavilyConfig {
  const mapped = context.agentConfig as TavilyConfig | undefined;
  if (mapped) return mapped;
  return {
    maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    maxFetchSize: options.maxFetchSize ?? DEFAULT_MAX_FETCH_SIZE,
    searchDefaults: options.searchDefaults ?? {},
  };
}

/**
 * Create a web search capability with Tavily-powered search and URL fetching.
 *
 * Provides two tools:
 * - `web_search` — Search the web via Tavily API
 * - `web_fetch` — Fetch and extract content from a URL
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
    agentConfigMapping: options.config,
    tools: (context: AgentContext) => {
      const config = resolveConfig(options, context);
      return [
        createSearchTool(getApiKey, config.maxResults, context, config.searchDefaults),
        createFetchTool(config.userAgent, config.maxFetchSize, context),
      ];
    },
  };
}
