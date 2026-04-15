/**
 * A cost event emitted by a capability or tool execution.
 */
export interface CostEvent {
  /** Which capability emitted this cost (kebab-case ID). */
  capabilityId: string;
  /** Which tool incurred the cost, if applicable. */
  toolName?: string;
  /** Monetary amount (e.g., 0.01). */
  amount: number;
  /** ISO 4217 currency code (e.g., "USD"). */
  currency: string;
  /** Human-readable description (e.g., "Web search: cats"). */
  detail?: string;
  /** Arbitrary metadata for the consumer. */
  metadata?: Record<string, unknown>;
}
