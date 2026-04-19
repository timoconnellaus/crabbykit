import type { AgentMessage } from "@crabbykit/agent-core";
import type { CompactionConfig, CompactionResult, SummarizeFn } from "./types.js";

const SAFETY_MARGIN = 1.15;
const DEFAULT_BASE_CHUNK_RATIO = 0.4;
const DEFAULT_MIN_CHUNK_RATIO = 0.15;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000;
const EMERGENCY_TRUNCATION_BUDGET_RATIO = 0.5;

/**
 * Per-message overhead in tokens (role, delimiters, metadata).
 * Most LLM APIs add ~4-7 tokens per message for framing.
 */
const MESSAGE_OVERHEAD_TOKENS = 5;

/**
 * Estimate token count for a text string.
 *
 * Uses a refined heuristic that accounts for common tokenizer patterns:
 * - English prose averages ~4 chars/token
 * - Code averages ~3 chars/token (more symbols, shorter identifiers)
 * - Whitespace-heavy content tokenizes more efficiently (~5 chars/token)
 * - JSON/structured content averages ~2.5 chars/token (many single-char tokens)
 *
 * We use 3.5 chars/token as a balanced default with a safety margin.
 */
function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // Detect content type for better estimation
  const codeIndicators = /[{}[\]();=><|&!~^%]/.test(text);
  const jsonLike = text.startsWith("{") || text.startsWith("[");

  let charsPerToken: number;
  if (jsonLike) {
    charsPerToken = 2.5;
  } else if (codeIndicators) {
    charsPerToken = 3.0;
  } else {
    charsPerToken = 3.5;
  }

  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate token count for a single message.
 * Uses content-aware heuristics with a safety margin.
 */
export function estimateTokens(message: AgentMessage): number {
  // biome-ignore lint/suspicious/noExplicitAny: AgentMessage content type is opaque from pi-agent-core
  const content = (message as any).content;
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  if (typeof content === "string") {
    tokens += estimateTextTokens(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        tokens += estimateTextTokens(block);
      } else if (block && typeof block === "object") {
        if ("text" in block && typeof block.text === "string") {
          tokens += estimateTextTokens(block.text);
        }
        // Tool calls include the function name + JSON arguments
        if (block.type === "toolCall") {
          const argsStr =
            typeof block.arguments === "string"
              ? block.arguments
              : JSON.stringify(block.arguments ?? {});
          tokens += estimateTextTokens(argsStr) + 5; // +5 for tool call framing
        }
      }
    }
  }

  return Math.ceil(tokens * SAFETY_MARGIN);
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg);
  }
  return total;
}

/**
 * Check if compaction should be triggered.
 */
export function shouldCompact(
  estimatedTokens: number,
  config: Pick<CompactionConfig, "threshold" | "contextWindowTokens">,
): boolean {
  return estimatedTokens > config.threshold * config.contextWindowTokens;
}

/**
 * Find the cut point: walk backwards from the end, accumulating tokens
 * until keepRecentTokens is reached. Returns the index where compactable
 * messages end (everything before this index can be compacted).
 */
export function findCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number,
): { cutIndex: number; recentTokens: number } | null {
  let accumulated = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // Cut at i — messages [0, i) are compactable, [i, end] are kept
      if (i === 0) return null; // Nothing to compact
      return { cutIndex: i, recentTokens: accumulated };
    }
  }

  // All messages fit in keepRecentTokens
  return null;
}

/**
 * Split messages proportionally by token share into N chunks.
 */
export function splitByTokenShare(messages: AgentMessage[], numChunks: number): AgentMessage[][] {
  if (numChunks <= 1) return [messages];

  const totalTokens = estimateMessagesTokens(messages);
  const targetPerChunk = totalTokens / numChunks;

  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const tokens = estimateTokens(msg);
    currentChunk.push(msg);
    currentTokens += tokens;

    if (currentTokens >= targetPerChunk && chunks.length < numChunks - 1) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Summarize messages in stages: split into chunks, summarize each with
 * previous summary for continuity, merge if multiple chunks.
 */
export async function summarizeInStages(
  messages: AgentMessage[],
  config: CompactionConfig,
  summarize: SummarizeFn,
  signal?: AbortSignal,
): Promise<string> {
  const totalTokens = estimateMessagesTokens(messages);
  const baseChunkRatio = config.baseChunkRatio ?? DEFAULT_BASE_CHUNK_RATIO;
  const minChunkRatio = config.minChunkRatio ?? DEFAULT_MIN_CHUNK_RATIO;

  // Adaptive chunk ratio: reduce for very large contexts
  const chunkRatio = Math.max(
    minChunkRatio,
    baseChunkRatio * Math.min(1, config.contextWindowTokens / (totalTokens * 2)),
  );
  const maxChunkTokens = Math.floor(config.contextWindowTokens * chunkRatio);
  const numChunks = Math.max(1, Math.ceil(totalTokens / maxChunkTokens));

  const chunks = splitByTokenShare(messages, numChunks);

  if (chunks.length === 1) {
    return summarize(chunks[0], undefined, signal);
  }

  // Multi-stage: summarize each chunk with previous summary as context
  const partialSummaries: string[] = [];
  let previousSummary: string | undefined;

  for (const chunk of chunks) {
    signal?.throwIfAborted();
    const summary = await summarize(chunk, previousSummary, signal);
    partialSummaries.push(summary);
    previousSummary = summary;
  }

  // Merge all partial summaries
  const mergeMessages: AgentMessage[] = partialSummaries.map(
    (s, i) =>
      ({
        role: "user",
        content: `[Summary part ${i + 1}/${partialSummaries.length}]\n\n${s}`,
        timestamp: Date.now(),
      }) as AgentMessage,
  );

  return summarize(mergeMessages, undefined, signal);
}

/**
 * Orchestrate full compaction: threshold check → cut point → summarize → result.
 */
export async function compactSession(
  messages: AgentMessage[],
  entryIds: string[],
  config: CompactionConfig,
  summarize: SummarizeFn,
  signal?: AbortSignal,
): Promise<CompactionResult | null> {
  const totalTokens = estimateMessagesTokens(messages);

  if (!shouldCompact(totalTokens, config)) {
    return null;
  }

  const cutResult = findCutPoint(messages, config.keepRecentTokens);
  if (!cutResult) {
    return null; // Nothing to compact
  }

  const compactableMessages = messages.slice(0, cutResult.cutIndex);
  const summary = await summarizeInStages(compactableMessages, config, summarize, signal);

  return {
    summary,
    firstKeptEntryId: entryIds[cutResult.cutIndex],
    tokensBefore: totalTokens,
  };
}

/**
 * Truncate a tool result that exceeds the hard character limit.
 * Uses prefix + suffix strategy.
 */
export function truncateToolResult(
  content: string,
  maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS,
): string {
  if (content.length <= maxChars) return content;

  const marker =
    "\n\n⚠️ [Content truncated — original was " +
    `${content.length.toLocaleString()} chars, limit is ${maxChars.toLocaleString()}]\n\n`;
  const available = maxChars - marker.length;
  const prefixLen = Math.floor(available / 2);
  const suffixLen = available - prefixLen;

  return content.slice(0, prefixLen) + marker + content.slice(-suffixLen);
}

/**
 * Emergency truncation: keep only recent messages within budget,
 * prepend a notice about lost context.
 */
export function emergencyTruncate(
  messages: AgentMessage[],
  contextWindowTokens: number,
): AgentMessage[] {
  const budget = Math.floor(contextWindowTokens * EMERGENCY_TRUNCATION_BUDGET_RATIO);
  const result: AgentMessage[] = [];
  let tokens = 0;

  // Walk backwards, keep what fits
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i]);
    if (tokens + msgTokens > budget) break;
    result.unshift(messages[i]);
    tokens += msgTokens;
  }

  // Prepend truncation notice
  result.unshift({
    role: "user",
    content:
      "[System notice: Earlier conversation context was lost due to context window overflow. " +
      "The conversation continues from the most recent messages below.]",
    timestamp: Date.now(),
  } as AgentMessage);

  return result;
}
