import type { AnyAgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key, validatePath } from "./paths.js";

/**
 * Create a file_copy tool backed by an R2 bucket.
 */
export function createFileCopyTool(getBucket: () => R2Bucket, getPrefix: () => string): AnyAgentTool {
  return defineTool({
    name: "file_copy",
    description: "Copy a file to a new path. Overwrites the destination if it exists.",
    guidance:
      "Duplicate a file to a new path. Overwrites the destination if it already exists. Use file_move instead if you want to rename without keeping the original.",
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

        await bucket.put(dstKey, await object.arrayBuffer());

        return {
          content: [
            {
              type: "text" as const,
              text: `Copied ${srcValidation.normalizedPath} → ${dstValidation.normalizedPath}`,
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
          content: [{ type: "text" as const, text: `Error copying file: ${message}` }],
          details: { error: "copy_error", message },
        };
      }
    },
  });
}
