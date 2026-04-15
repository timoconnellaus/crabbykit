import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { AgentCard } from "../types.js";

const DEFAULT_CACHE_TTL_SECONDS = 300;

interface CachedAgentCard {
  card: AgentCard;
  fetchedAt: number;
}

/**
 * Fetch an Agent Card from a target agent's well-known URL.
 */
export async function fetchAgentCard(agentUrl: string, fetchFn: typeof fetch): Promise<AgentCard> {
  const url = agentUrl.endsWith("/")
    ? `${agentUrl}.well-known/agent-card.json`
    : `${agentUrl}/.well-known/agent-card.json`;

  const response = await fetchFn(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agent card from ${url}: ${response.status}`);
  }

  return (await response.json()) as AgentCard;
}

/**
 * Get an Agent Card with caching.
 * Cards are cached in CapabilityStorage (survives DO hibernation).
 */
export async function getAgentCard(
  agentUrl: string,
  fetchFn: typeof fetch,
  storage: CapabilityStorage,
  cacheTtlSeconds: number = DEFAULT_CACHE_TTL_SECONDS,
): Promise<AgentCard> {
  const cacheKey = `card:${agentUrl}`;
  const cached = await storage.get<CachedAgentCard>(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < cacheTtlSeconds * 1000) {
    return cached.card;
  }

  const card = await fetchAgentCard(agentUrl, fetchFn);
  await storage.put(cacheKey, { card, fetchedAt: Date.now() });
  return card;
}
