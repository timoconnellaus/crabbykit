import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key, validatePath } from "./paths.js";

const MAX_CONTENT_BYTES = 1_048_576; // 1MB

/**
 * Create a file_write tool backed by an R2 bucket.
 */
export function createFileWriteTool(getBucket: () => R2Bucket, getPrefix: () => string): AgentTool {
  return defineTool({
    name: "file_write",
    description:
      "Create or overwrite a file in storage. Parent directories are created automatically. Maximum content size is 1MB.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file, relative to the storage root" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    execute: async ({ path, content }) => {
      const validation = validatePath(path);
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${validation.error}` }],
          details: { error: "invalid_path" },
        };
      }

      const contentBytes = new TextEncoder().encode(content).byteLength;
      if (contentBytes > MAX_CONTENT_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Content size (${contentBytes} bytes) exceeds the 1MB limit`,
            },
          ],
          details: { error: "content_too_large", bytes: contentBytes },
        };
      }

      const prefix = getPrefix();
      const r2Key = toR2Key(prefix, validation.normalizedPath);
      const bucket = getBucket();

      try {
        // Create zero-byte directory markers for intermediate path segments
        const segments = validation.normalizedPath.split("/");
        if (segments.length > 1) {
          for (let i = 1; i < segments.length; i++) {
            const dirPath = `${prefix}/${segments.slice(0, i).join("/")}/`;
            const existing = await bucket.head(dirPath);
            if (existing === null) {
              await bucket.put(dirPath, "");
            }
          }
        }

        await bucket.put(r2Key, content);

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully wrote ${contentBytes} bytes to ${validation.normalizedPath}`,
            },
          ],
          details: { path: validation.normalizedPath, bytes: contentBytes },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error writing file: ${message}` }],
          details: { error: "write_error", message },
        };
      }
    },
  }) as unknown as AgentTool;
}
