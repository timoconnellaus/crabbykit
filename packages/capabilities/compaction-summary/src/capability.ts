import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type {
  Capability,
  CapabilityHookContext,
  CompactionConfig,
} from "@claw-for-cloudflare/agent-runtime";
import { compactSession, estimateMessagesTokens } from "@claw-for-cloudflare/agent-runtime";
import { pruneToolOutputs } from "./prune.js";
import { createLlmSummarizer } from "./summarize.js";

const DEFAULT_COMPACTION_THRESHOLD = 0.75;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_PRUNE_BUDGET = 40_000;

export interface CompactionSummaryOptions {
  /** Provider name (e.g., 'openrouter'). */
  provider: string;
  /** Model ID for summarization (e.g., 'google/gemini-2.0-flash-001'). */
  modelId: string;
  /** API key getter — called at summarization time. */
  getApiKey: () => string;
  /** Compaction configuration overrides. */
  compaction?: Partial<CompactionConfig>;
  /** Token budget for preserved tool outputs during pruning (default 40,000). */
  pruneBudget?: number;
}

/**
 * Create a compaction capability that uses LLM summarization to compress
 * conversation history when the context window fills up.
 *
 * Register via `getCapabilities()` on your AgentDO subclass.
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   return [
 *     compactionSummary({
 *       provider: "openrouter",
 *       modelId: "google/gemini-2.0-flash-001",
 *       getApiKey: () => this.env.OPENROUTER_API_KEY,
 *     }),
 *   ];
 * }
 * ```
 */
export function compactionSummary(options: CompactionSummaryOptions): Capability {
  const pruneBudget = options.pruneBudget ?? DEFAULT_PRUNE_BUDGET;
  const config: CompactionConfig = {
    threshold: options.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
    contextWindowTokens: options.compaction?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    keepRecentTokens: options.compaction?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    baseChunkRatio: options.compaction?.baseChunkRatio,
    minChunkRatio: options.compaction?.minChunkRatio,
  };

  return {
    id: "compaction-summary",
    name: "Compaction (Summary)",
    description:
      "Compacts conversation history via LLM summarization when context window fills up.",
    hooks: {
      beforeInference: async (
        messages: AgentMessage[],
        ctx: CapabilityHookContext,
      ): Promise<AgentMessage[]> => {
        const totalTokens = estimateMessagesTokens(messages);

        if (totalTokens <= config.threshold * config.contextWindowTokens) {
          return messages;
        }

        // Prune old tool outputs before expensive LLM summarization
        const pruned = pruneToolOutputs(messages, pruneBudget);
        const prunedTokens = estimateMessagesTokens(pruned);

        // If pruning alone brought us under threshold, skip summarization
        if (prunedTokens <= config.threshold * config.contextWindowTokens) {
          return pruned;
        }

        // Use pruned messages for summarization (smaller context = cheaper)
        const messagesToCompact = pruned;

        try {
          const summarize = createLlmSummarizer(
            options.provider,
            options.modelId,
            options.getApiKey,
          );

          const entries = ctx.sessionStore.getEntries(ctx.sessionId);
          const entryIds = entries.filter((e) => e.type === "message").map((e) => e.id);

          const result = await compactSession(messagesToCompact, entryIds, config, summarize);

          if (result) {
            ctx.sessionStore.appendEntry(ctx.sessionId, {
              type: "compaction",
              data: {
                summary: result.summary,
                firstKeptEntryId: result.firstKeptEntryId,
                tokensBefore: result.tokensBefore,
              },
            });

            return ctx.sessionStore.buildContext(ctx.sessionId);
          }
        } catch (err) {
          console.error(
            "[compaction-summary] Compaction failed, returning original messages:",
            err,
          );
        }

        return messages;
      },
    },
  };
}
