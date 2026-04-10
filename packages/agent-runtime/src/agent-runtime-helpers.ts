import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { AssistantMessage } from "@claw-for-cloudflare/ai";

/**
 * Concatenate the text content of the final assistant message in an
 * `agent_end` messages array. Returns the empty string when no assistant
 * message is present (e.g., turn aborted before any assistant output) or
 * when the final assistant message has no text blocks.
 *
 * Walks the array from the end, skipping non-assistant messages (tool
 * results, etc.). For array content, joins the `text` of every
 * `{ type: "text", text }` block.
 *
 * Exported here (rather than from `agent-runtime.ts`) so unit tests can
 * import it without pulling the whole runtime module tree (which itself
 * depends on `cloudflare:workers` at import time via `agent-do.ts`).
 */
export function extractFinalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!("role" in msg) || msg.role !== "assistant") continue;
    const content = (msg as AssistantMessage).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
    }
    return "";
  }
  return "";
}
