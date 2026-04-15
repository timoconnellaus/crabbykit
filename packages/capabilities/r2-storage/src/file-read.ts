import type { AnyAgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key, validatePath } from "./paths.js";

const DEFAULT_MAX_READ_BYTES = 512 * 1024; // 512KB

/**
 * Create a file_read tool backed by an R2 bucket.
 */
export function createFileReadTool(
  getBucket: () => R2Bucket,
  getPrefix: () => string,
  maxReadBytes: number = DEFAULT_MAX_READ_BYTES,
): AnyAgentTool {
  return defineTool({
    name: "file_read",
    description:
      "Read file contents from storage. Supports optional line-based offset and limit for partial reads. Large files are automatically truncated.",
    guidance:
      "Read the contents of a file in storage. Supports optional line-based offset and limit for partial reads. Large files are automatically truncated with a notice. Prefer this over other methods for reading files — it provides better error handling.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file, relative to the storage root" }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Line number to start reading from (0-based)",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Maximum number of lines to read",
        }),
      ),
    }),
    execute: async ({ path, offset, limit }) => {
      const validation = validatePath(path);
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${validation.error}` }],
          details: { error: "invalid_path" },
        };
      }

      const r2Key = toR2Key(getPrefix(), validation.normalizedPath);

      try {
        const object = await getBucket().get(r2Key);
        if (object === null) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: File not found: ${validation.normalizedPath}`,
              },
            ],
            details: { error: "not_found", path: validation.normalizedPath },
          };
        }

        const text = await object.text();
        const result = applyOffsetLimitAndTruncate(text, maxReadBytes, offset, limit);

        return {
          content: [{ type: "text" as const, text: result }],
          details: {
            path: validation.normalizedPath,
            bytes: new TextEncoder().encode(result).byteLength,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error reading file: ${message}` }],
          details: { error: "read_error", message },
        };
      }
    },
  });
}

function applyOffsetLimitAndTruncate(
  text: string,
  maxBytes: number,
  offset?: number,
  limit?: number,
): string {
  let lines = text.split("\n");
  const totalLines = lines.length;

  const startLine = offset ?? 0;
  lines = lines.slice(startLine);

  if (limit !== undefined) {
    lines = lines.slice(0, limit);
  }

  let result = lines.join("\n");

  // Apply byte-based truncation
  const encoded = new TextEncoder().encode(result);
  if (encoded.byteLength > maxBytes) {
    const truncated = new TextDecoder().decode(encoded.slice(0, maxBytes));
    // Find the last complete line
    const lastNewline = truncated.lastIndexOf("\n");
    result = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;

    const shownLines = result.split("\n").length;
    result += `\n\n[File truncated at ${shownLines} lines (of ${totalLines} total). Use offset/limit parameters to read more.]`;
  }

  return result;
}
