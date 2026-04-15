/**
 * Per-turn RPC budget enforcement.
 * Tracks call counts per token nonce per category.
 * Throws SpineError when a budget is exceeded.
 */

export interface SpineBudgetConfig {
  maxSqlOps: number;
  maxKvOps: number;
  maxBroadcasts: number;
  maxAlarms: number;
}

export const DEFAULT_BUDGET: SpineBudgetConfig = {
  maxSqlOps: 100,
  maxKvOps: 50,
  maxBroadcasts: 200,
  maxAlarms: 5,
};

export type BudgetCategory = "sql" | "kv" | "broadcast" | "alarm";

export class BudgetExceededError extends Error {
  readonly code = "ERR_BUDGET_EXCEEDED";
  constructor(category: BudgetCategory, limit: number) {
    super(`${category} budget exceeded (limit: ${limit})`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetTracker {
  private readonly counters = new Map<string, Map<BudgetCategory, number>>();
  private readonly config: SpineBudgetConfig;

  constructor(config: SpineBudgetConfig = DEFAULT_BUDGET) {
    this.config = config;
  }

  /**
   * Check and increment budget for a given nonce + category.
   * Throws BudgetExceededError if budget exceeded.
   */
  check(nonce: string, category: BudgetCategory): void {
    let categories = this.counters.get(nonce);
    if (!categories) {
      categories = new Map();
      this.counters.set(nonce, categories);
    }

    const current = categories.get(category) ?? 0;
    const limit = this.getLimit(category);

    if (current >= limit) {
      throw new BudgetExceededError(category, limit);
    }

    categories.set(category, current + 1);
  }

  private getLimit(category: BudgetCategory): number {
    switch (category) {
      case "sql":
        return this.config.maxSqlOps;
      case "kv":
        return this.config.maxKvOps;
      case "broadcast":
        return this.config.maxBroadcasts;
      case "alarm":
        return this.config.maxAlarms;
    }
  }

  /** Clean up counters for a completed turn. */
  cleanup(nonce: string): void {
    this.counters.delete(nonce);
  }
}
