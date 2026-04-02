import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key, validatePath } from "./paths.js";

/**
 * Create a file_move tool backed by an R2 bucket.
 * Implemented as copy + delete (R2 has no native move/rename).
 */
export function createFileMoveTool(getBucket: () => R2Bucket, getPrefix: () => string): AgentTool {
  return defineTool({
    name: "file_move",
    description:
      "Move (rename) a file to a new path. Overwrites the destination if it exists. The source file is deleted after a successful copy.",
    guidance:
      "Rename or relocate a file. Implemented as copy + delete. Overwrites the destination if it already exists.",
    parameters: Type.Object({
      source: Type.String({ description: "Source file path, relative to the storage root" }),
      destination: Type.String({
        description: "Destination file path, relative to the storage root",
      }),
    }),
    execute: async ({ source, destination }) => {
      const srcValidation = validatePath(source);
      if (!srcValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: source path: ${srcValidation.error}` }],
          details: { error: "invalid_path" },
        };
      }

      const dstValidation = validatePath(destination);
      if (!dstValidation.valid) {
        return {
          content: [
            { type: "text" as const, text: `Error: destination path: ${dstValidation.error}` },
          ],
          details: { error: "invalid_path" },
        };
      }

      const bucket = getBucket();
      const prefix = getPrefix();
      const srcKey = toR2Key(prefix, srcValidation.normalizedPath);
      const dstKey = toR2Key(prefix, dstValidation.normalizedPath);

      try {
        const object = await bucket.get(srcKey);
        if (object === null) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: source file not found: ${srcValidation.normalizedPath}`,
              },
            ],
            details: { error: "not_found" },
          };
        }

        // Copy to destination, then delete source
        await bucket.put(dstKey, await object.arrayBuffer());
        await bucket.delete(srcKey);

        return {
          content: [
            {
              type: "text" as const,
              text: `Moved ${srcValidation.normalizedPath} → ${dstValidation.normalizedPath}`,
            },
          ],
          details: {
            source: srcValidation.normalizedPath,
            destination: dstValidation.normalizedPath,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error moving file: ${message}` }],
          details: { error: "move_error", message },
        };
      }
    },
  }) as unknown as AgentTool;
}
