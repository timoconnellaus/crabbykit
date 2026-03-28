import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key } from "./paths.js";

const DEFAULT_MAX_READ_BYTES = 512 * 1024;

export function createMemoryGetTool(
  getBucket: () => R2Bucket,
  getPrefix: () => string,
  maxReadBytes: number = DEFAULT_MAX_READ_BYTES,
) {
  return defineTool({
    name: "memory_get",
    description: "Read the full content of a memory file, with optional line range.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the memory file (e.g. 'MEMORY.md' or 'memory/notes.md')",
      }),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "Line number to start from (0-based)" }),
      ),
      lines: Type.Optional(Type.Integer({ minimum: 1, description: "Number of lines to read" })),
    }),
    execute: async (_toolCallId, { path, offset, lines }) => {
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
