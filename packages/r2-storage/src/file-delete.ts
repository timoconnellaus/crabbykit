import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key, validatePath } from "./paths.js";

/**
 * Create a file_delete tool backed by an R2 bucket.
 */
export function createFileDeleteTool(
  getBucket: () => R2Bucket,
  getPrefix: () => string,
): AgentTool {
  return defineTool({
    name: "file_delete",
    description: "Delete a file from storage. Idempotent — no error if the file does not exist.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file, relative to the storage root" }),
    }),
    execute: async ({ path }) => {
      const validation = validatePath(path);
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${validation.error}` }],
          details: { error: "invalid_path" },
        };
      }

      const r2Key = toR2Key(getPrefix(), validation.normalizedPath);

      try {
        await getBucket().delete(r2Key);

        return {
          content: [
            { type: "text" as const, text: `Successfully deleted ${validation.normalizedPath}` },
          ],
          details: { path: validation.normalizedPath },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error deleting file: ${message}` }],
          details: { error: "delete_error", message },
        };
      }
    },
  }) as unknown as AgentTool;
}
