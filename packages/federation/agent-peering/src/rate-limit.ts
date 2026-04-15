import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";

const DEFAULT_MAX_PER_WINDOW = 10;
const DEFAULT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Check and increment rate limit for a sender agent.
 * Returns `true` if the request is allowed, `false` if rate limited.
 */
export async function checkRateLimit(
  storage: CapabilityStorage,
  senderAgentId: string,
  maxPerWindow: number = DEFAULT_MAX_PER_WINDOW,
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<boolean> {
  const key = `rl:${senderAgentId}`;
  const now = Date.now();
  const entry = await storage.get<RateLimitEntry>(key);

  if (!entry || now - entry.windowStart > windowMs) {
    // New window
    await storage.put(key, { count: 1, windowStart: now } satisfies RateLimitEntry);
    return true;
  }

  if (entry.count >= maxPerWindow) {
    return false;
  }

  await storage.put(key, {
    count: entry.count + 1,
    windowStart: entry.windowStart,
  } satisfies RateLimitEntry);
  return true;
}
