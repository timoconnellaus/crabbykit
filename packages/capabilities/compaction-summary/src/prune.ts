import type { AgentMessage } from "@crabbykit/agent-core";

const CHARS_PER_TOKEN = 3.5;
const PRUNED_MARKER = "[pruned]";

/**
 * Estimate token count for a text string.
 */
function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Check if a message is a tool result.
 */
function isToolResult(message: AgentMessage): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: AgentMessage role is opaque
  const role = (message as any).role;
  return role === "tool" || role === "toolResult";
}

/**
 * Get the total text token count from a message's content blocks.
 */
function getToolResultTokens(message: AgentMessage): number {
  // biome-ignore lint/suspicious/noExplicitAny: AgentMessage content is opaque
  const content = (message as any).content;
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
      total += estimateTextTokens(block.text);
    }
  }
  return total;
}

/**
 * Replace all text content in a tool result message with "[pruned]".
 */
function pruneMessage(message: AgentMessage): AgentMessage {
  // biome-ignore lint/suspicious/noExplicitAny: AgentMessage content is opaque
  const content = (message as any).content;
  if (typeof content === "string") {
    return { ...message, content: PRUNED_MARKER } as AgentMessage;
  }
  if (!Array.isArray(content)) return message;

  const newContent = content.map((block: unknown) => {
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
      return { ...block, text: PRUNED_MARKER };
    }
    return block;
  });
  return { ...message, content: newContent } as AgentMessage;
}

/**
 * Prune old tool result outputs to fit within a token budget.
 *
 * Walks tool results from newest to oldest, preserving the most recent
 * results that fit within `budgetTokens`. Older results have their content
 * replaced with "[pruned]".
 *
 * Non-tool messages (user, assistant, system) are never modified.
 *
 * @returns The pruned message array (new array, original not mutated).
 */
export function pruneToolOutputs(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
  // First, find all tool result indices and their token counts (newest first)
  const toolIndices: Array<{ index: number; tokens: number }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isToolResult(messages[i])) {
      toolIndices.push({ index: i, tokens: getToolResultTokens(messages[i]) });
    }
  }

  if (toolIndices.length === 0) return messages;

  // Determine which tool results to keep (newest first until budget exhausted)
  let remaining = budgetTokens;
  const keepSet = new Set<number>();
  for (const { index, tokens } of toolIndices) {
    if (remaining >= tokens) {
      keepSet.add(index);
      remaining -= tokens;
    }
  }

  // Build result, pruning tool results not in keep set
  return messages.map((msg, i) => {
    if (isToolResult(msg) && !keepSet.has(i)) {
      return pruneMessage(msg);
    }
    return msg;
  });
}
