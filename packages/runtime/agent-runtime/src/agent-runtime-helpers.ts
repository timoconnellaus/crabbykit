import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { AssistantMessage } from "@claw-for-cloudflare/ai";

/**
 * Match `pathname` against a `pattern` that may contain `/:name` wildcard
 * segments. Returns `null` if the pattern does not match, or a
 * `{ name: value }` object of extracted segment values on success.
 *
 * Exact-match patterns (no `:` segments) return an empty object when the
 * pathname equals the pattern, and `null` otherwise.
 *
 * Scope is intentionally minimal: single-segment `:param` only, no
 * optional segments, no regex constraints, no catch-all `*`, no query
 * string handling. Callers that need more can split on `?` first.
 *
 * Exported from this helpers module (rather than `agent-runtime.ts`) so
 * unit tests can import it without pulling in the full runtime tree,
 * which transitively depends on `cloudflare:workers` via `agent-do.ts`.
 *
 * Examples:
 *   matchPathPattern("/telegram/webhook/:accountId", "/telegram/webhook/abc")
 *     → { accountId: "abc" }
 *   matchPathPattern("/telegram/webhook/:accountId", "/telegram/webhook")
 *     → null
 *   matchPathPattern("/a/b", "/a/b") → {}
 *   matchPathPattern("/a/b", "/a/c") → null
 */
export function matchPathPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i];
    const v = pathSegments[i];
    if (p.startsWith(":")) {
      // Empty segment values are not valid captures — e.g. `/foo/`
      // should NOT match `/foo/:bar` with bar="".
      if (v === "") return null;
      params[p.slice(1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return null;
    }
  }
  return params;
}

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
