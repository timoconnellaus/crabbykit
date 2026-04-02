import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { type AgentContext, defineTool, Type } from "@claw-for-cloudflare/agent-runtime";

const DEFAULT_MAX_FETCH_SIZE = 50_000;
const DEFAULT_USER_AGENT = "ClawAgent/1.0";

/**
 * Strip HTML tags and normalize whitespace from an HTML string.
 */
export function stripHtml(html: string): string {
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Unescape common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/**
 * Create a web_fetch tool that fetches a URL and returns its text content.
 */
export function createFetchTool(
  userAgent: string = DEFAULT_USER_AGENT,
  maxSize: number = DEFAULT_MAX_FETCH_SIZE,
  _context: AgentContext,
): AgentTool {
  return defineTool({
    name: "web_fetch",
    description: "Fetch the content of a URL. Returns the page text (HTML stripped) or JSON.",
    guidance:
      "Fetch and read the full content of a URL. Use this after web_search to get detailed information from a specific page, or when the user provides a URL to read. Returns plain text with HTML stripped.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
    }),
    execute: async ({ url }) => {
      // Basic URL validation
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: "text" as const, text: `Error: Invalid URL: ${url}` }],
          details: { error: "invalid_url" },
        };
      }

      try {
        const response = await fetch(url, {
          headers: { "User-Agent": userAgent },
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: HTTP ${response.status} fetching ${url}`,
              },
            ],
            details: { error: "http_error", status: response.status },
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        let text: string;

        if (contentType.includes("application/json")) {
          const json = await response.json();
          text = JSON.stringify(json, null, 2);
        } else if (contentType.includes("text/html")) {
          const html = await response.text();
          text = stripHtml(html);
        } else {
          text = await response.text();
        }

        if (text.length > maxSize) {
          text =
            text.slice(0, maxSize) +
            `\n\n[Content truncated — original was ${text.length.toLocaleString()} chars, limit is ${maxSize.toLocaleString()}]`;
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { url, contentType, length: text.length },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching URL: ${message}`,
            },
          ],
          details: { error: "network_error", message },
        };
      }
    },
  }) as unknown as AgentTool;
}
