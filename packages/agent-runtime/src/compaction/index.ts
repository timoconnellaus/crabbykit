export {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompact,
  findCutPoint,
  splitByTokenShare,
  summarizeInStages,
  compactSession,
  truncateToolResult,
  emergencyTruncate,
} from "./compaction.js";

export type { CompactionConfig, CompactionResult, SummarizeFn } from "./types.js";
