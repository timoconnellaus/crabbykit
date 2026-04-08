import type { AnyAgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { resolveListPrefix } from "./paths.js";

/**
 * Create a file_list tool backed by an R2 bucket.
 */
export function createFileListTool(getBucket: () => R2Bucket, getPrefix: () => string): AnyAgentTool {
  return defineTool({
    name: "file_list",
    description:
      "List directory contents (one level deep). Returns files and subdirectories at the given path.",
    guidance:
      "List directory contents one level deep. Use file_tree for a recursive view of directory structure, or file_find to search by glob pattern.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Directory path relative to storage root. Omit or leave empty for root.",
        }),
      ),
      cursor: Type.Optional(
        Type.String({ description: "Pagination cursor from a previous file_list call" }),
      ),
    }),
    execute: async ({ path, cursor }) => {
      const prefixResult = resolveListPrefix(path, getPrefix());
      if ("error" in prefixResult) {
        return {
          content: [{ type: "text" as const, text: `Error: ${prefixResult.error}` }],
          details: { error: "invalid_path" },
        };
      }

      const { prefix } = prefixResult;

      try {
        const result = await getBucket().list({
          prefix,
          delimiter: "/",
          cursor,
          limit: 1000,
        });

        const entries: Array<{ name: string; type: "file" | "directory" }> = [];

        for (const obj of result.objects) {
          const name = obj.key.slice(prefix.length);
          if (name.length > 0) {
            entries.push({ name, type: "file" });
          }
        }

        for (const dirPrefix of result.delimitedPrefixes) {
          const name = dirPrefix.slice(prefix.length).replace(/\/$/, "");
          if (name.length > 0) {
            entries.push({ name, type: "directory" });
          }
        }

        const formatted = entries
          .map((e) => `${e.type === "directory" ? "📁" : "📄"} ${e.name}`)
          .join("\n");

        const text =
          entries.length === 0
            ? "Directory is empty."
            : result.truncated
              ? `${formatted}\n\n[Truncated — use cursor "${result.cursor}" to see more]`
              : formatted;

        return {
          content: [{ type: "text" as const, text }],
          details: {
            entries,
            cursor: result.truncated ? result.cursor : undefined,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error listing directory: ${message}` }],
          details: { error: "list_error", message },
        };
      }
    },
  });
}
