import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key } from "./paths.js";

const DEFAULT_MAX_READ_BYTES = 512 * 1024;

/** Validate a path to prevent directory traversal and other malicious inputs. */
function validateMemoryPath(path: string): string | null {
  if (!path || path.length === 0) return "Path cannot be empty";
  if (path.length > 512) return "Path exceeds maximum length (512 bytes)";
  if (path.includes("..")) return "Path cannot contain '..'";
  if (path.includes("\0")) return "Path cannot contain null bytes";
  if (path.startsWith("/")) return "Path must be relative";
  return null;
}

export function createMemoryGetTool(
  getBucket: () => R2Bucket,
  getPrefix: () => string,
  maxReadBytes: number = DEFAULT_MAX_READ_BYTES,
) {
  return defineTool({
    name: "memory_get",
    description: "Read the full content of a memory file, with optional line range.",
    guidance:
      "Read the full content of a specific memory file. Use this after memory_search to read the complete file when search snippets aren't sufficient. Supports optional line range for partial reads.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the memory file (e.g. 'MEMORY.md' or 'memory/notes.md')",
      }),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "Line number to start from (0-based)" }),
      ),
      lines: Type.Optional(Type.Integer({ minimum: 1, description: "Number of lines to read" })),
    }),
    execute: async ({ path, offset, lines }) => {
      const pathError = validateMemoryPath(path);
      if (pathError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pathError}: ${path}` }],
          details: { error: "invalid_path" },
        };
      }

      const prefix = getPrefix();
      const r2Key = toR2Key(prefix, path);
      const bucket = getBucket();

      const object = await bucket.get(r2Key);
      if (object === null) {
        return {
          content: [{ type: "text" as const, text: `Error: File not found: ${path}` }],
          details: { error: "not_found" },
        };
      }

      let text = await object.text();

      // Apply offset/lines slicing
      if (offset !== undefined) {
        const allLines = text.split("\n");
        const start = Math.min(offset, allLines.length);
        const end =
          lines !== undefined ? Math.min(start + lines, allLines.length) : allLines.length;
        text = allLines.slice(start, end).join("\n");
      }

      // Truncate if over max
      if (new TextEncoder().encode(text).byteLength > maxReadBytes) {
        const truncated = text.slice(0, maxReadBytes);
        const lastNewline = truncated.lastIndexOf("\n");
        text = `${lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated}\n\n[Truncated — file exceeds ${maxReadBytes} bytes]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: { path, byteLength: new TextEncoder().encode(text).byteLength },
      };
    },
  });
}
