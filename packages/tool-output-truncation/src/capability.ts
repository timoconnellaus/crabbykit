import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { Capability } from "@claw-for-cloudflare/agent-runtime";

const DEFAULT_MAX_TOKENS = 30_000;
const CHARS_PER_TOKEN = 3.5;
const HEAD_RATIO = 0.4;
const TAIL_RATIO = 0.4;

export interface ToolOutputTruncationOptions {
  /** Maximum tokens per tool result text block before truncation (default 30,000). */
  maxTokens?: number;
}

/**
 * Estimate token count for a text string.
 * Uses 3.5 chars/token as a balanced heuristic.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate a text string to fit within a token budget.
 * Preserves the first 40% and last 40% of the allowed content,
 * replacing the middle with a marker.
 */
const TRUNCATION_MARKER = "[... truncated";

export function truncateText(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTextTokens(text);
  if (estimatedTokens <= maxTokens) return text;
  // Already truncated — don't re-truncate
  if (text.includes(TRUNCATION_MARKER)) return text;

  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = Math.floor(maxChars * TAIL_RATIO);
  const removed = estimatedTokens - maxTokens;

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);

  return `${head}\n\n[... truncated ${removed} tokens, ${maxTokens} of ${estimatedTokens} kept ...]\n\n${tail}`;
}

/**
 * Check if a tool result message has opted out of truncation
 * via `details.skipTruncation`.
 */
function hasSkipTruncation(message: AgentMessage): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: AgentMessage details structure is opaque
  const details = (message as any).details;
  return details?.skipTruncation === true;
}

/**
 * Check if a message is a tool result (role === "tool" or role === "toolResult").
 */
function isToolResult(message: AgentMessage): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: AgentMessage role is opaque from pi-agent-core
  const role = (message as any).role;
  return role === "tool" || role === "toolResult";
}

/**
 * Truncate text content blocks in a message if they exceed the token limit.
 * Returns a new message with truncated content, or the original if unchanged.
 */
function truncateMessageContent(message: AgentMessage, maxTokens: number): AgentMessage {
  // biome-ignore lint/suspicious/noExplicitAny: AgentMessage content structure is opaque
  const content = (message as any).content;
  if (!Array.isArray(content)) {
    if (typeof content === "string") {
      const truncated = truncateText(content, maxTokens);
      if (truncated === content) return message;
      return { ...message, content: truncated } as AgentMessage;
    }
    return message;
  }

  let changed = false;
  const newContent = content.map((block: unknown) => {
    if (block && typeof block === "object" && "text" in block) {
      const textBlock = block as { type: string; text: string };
      if (typeof textBlock.text === "string") {
        const truncated = truncateText(textBlock.text, maxTokens);
        if (truncated !== textBlock.text) {
          changed = true;
          return { ...textBlock, text: truncated };
        }
      }
    }
    return block;
  });

  if (!changed) return message;
  return { ...message, content: newContent } as AgentMessage;
}

/**
 * Create a tool output truncation capability.
 *
 * Scans tool result messages before each inference call and truncates
 * oversized text content blocks, preserving the first and last 40%
 * of the allowed content.
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   return [
 *     toolOutputTruncation({ maxTokens: 30_000 }),
 *   ];
 * }
 * ```
 */
export function toolOutputTruncation(options: ToolOutputTruncationOptions = {}): Capability {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    id: "tool-output-truncation",
    name: "Tool Output Truncation",
    description: "Truncates oversized tool results before they enter the LLM context window.",
    hooks: {
      beforeInference: async (messages) => {
        return messages.map((msg) => {
          if (!isToolResult(msg)) return msg;
          if (hasSkipTruncation(msg)) return msg;
          return truncateMessageContent(msg, maxTokens);
        });
      },
    },
  };
}
