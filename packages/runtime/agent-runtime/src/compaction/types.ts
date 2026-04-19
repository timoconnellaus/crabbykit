import type { AgentMessage } from "@crabbykit/agent-core";

export interface CompactionConfig {
  /** Fraction of context window that triggers compaction (default 0.75) */
  threshold: number;
  /** Context window size in tokens */
  contextWindowTokens: number;
  /** Tokens to keep from recent messages after compaction */
  keepRecentTokens: number;
  /** Base chunk ratio — fraction of budget per chunk (default 0.4) */
  baseChunkRatio?: number;
  /** Minimum chunk ratio (default 0.15) */
  minChunkRatio?: number;
}

export type SummarizeFn = (
  messages: AgentMessage[],
  previousSummary?: string,
  signal?: AbortSignal,
) => Promise<string>;

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}
