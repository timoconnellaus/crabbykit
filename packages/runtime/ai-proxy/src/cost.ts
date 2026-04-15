import type { CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";

const TOTAL_COST_KEY = "totalCost";
const COST_LOG_KEY = "costLog";

/** A recorded cost entry. */
export interface CostEntry {
  model: string;
  amount: number;
  currency: string;
  promptTokens: number;
  completionTokens: number;
  timestamp: string;
}

/** Read the current cumulative cost from storage. */
export async function getCumulativeCost(storage: CapabilityStorage): Promise<number> {
  return (await storage.get<number>(TOTAL_COST_KEY)) ?? 0;
}

/**
 * Persist a cost entry to storage and update the running total.
 * This is called synchronously before returning the response to the caller,
 * ensuring cost is never lost.
 */
export async function persistCost(storage: CapabilityStorage, entry: CostEntry): Promise<number> {
  const current = await getCumulativeCost(storage);
  const newTotal = current + entry.amount;
  await storage.put(TOTAL_COST_KEY, newTotal);

  // Append to log (keep last 1000 entries)
  const log = (await storage.get<CostEntry[]>(COST_LOG_KEY)) ?? [];
  log.push(entry);
  if (log.length > 1000) {
    log.splice(0, log.length - 1000);
  }
  await storage.put(COST_LOG_KEY, log);

  return newTotal;
}

/** Reset cumulative cost (e.g., on de-elevate). */
export async function resetCost(storage: CapabilityStorage): Promise<void> {
  await storage.put(TOTAL_COST_KEY, 0);
  await storage.delete(COST_LOG_KEY);
}
