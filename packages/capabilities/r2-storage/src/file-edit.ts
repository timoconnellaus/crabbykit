import type { AnyAgentTool } from "@claw-for-cloudflare/agent-runtime";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { toR2Key, validatePath } from "./paths.js";

/**
 * Create a file_edit tool backed by an R2 bucket.
 */
export function createFileEditTool(
  getBucket: () => R2Bucket,
  getPrefix: () => string,
): AnyAgentTool {
  return defineTool({
    name: "file_edit",
    description:
      "Edit a file by replacing a specific string. The old_string must match exactly including whitespace and indentation. By default replaces only the first occurrence; use replace_all for all occurrences.",
    guidance:
      "Apply targeted string replacements to a file. The old_string must match exactly including whitespace and indentation. Use this for small changes to existing files instead of file_write, which overwrites the entire file.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file, relative to the storage root" }),
      old_string: Type.String({ description: "The exact string to find and replace" }),
      new_string: Type.String({ description: "The string to replace it with" }),
      replace_all: Type.Optional(
        Type.Boolean({
          description: "Replace all occurrences instead of just the first (default: false)",
        }),
      ),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      const validation = validatePath(path);
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${validation.error}` }],
          details: { error: "invalid_path" },
        };
      }

      if (old_string === new_string) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No changes made: old_string and new_string are identical",
            },
          ],
          details: { path: validation.normalizedPath, replaced: 0 },
        };
      }

      const r2Key = toR2Key(getPrefix(), validation.normalizedPath);
      const bucket = getBucket();
      const replaceAll = replace_all ?? false;

      try {
        const object = await bucket.get(r2Key);
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

        const content = await object.text();

        // Count occurrences
        let count = 0;
        let idx = content.indexOf(old_string);
        while (idx !== -1) {
          count++;
          idx = content.indexOf(old_string, idx + old_string.length);
        }

        if (count === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: String not found in ${validation.normalizedPath}. Verify the exact text including whitespace and indentation.`,
              },
            ],
            details: { error: "string_not_found", path: validation.normalizedPath },
          };
        }

        if (count > 1 && !replaceAll) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Found ${count} occurrences in ${validation.normalizedPath}. Provide more surrounding context to make the match unique, or set replace_all=true.`,
              },
            ],
            details: { error: "ambiguous_match", count, path: validation.normalizedPath },
          };
        }

        let newContent: string;
        if (replaceAll) {
          newContent = content.split(old_string).join(new_string);
        } else {
          const pos = content.indexOf(old_string);
          newContent = content.slice(0, pos) + new_string + content.slice(pos + old_string.length);
        }

        await bucket.put(r2Key, newContent);

        const replaced = replaceAll ? count : 1;
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully replaced ${replaced} occurrence${replaced !== 1 ? "s" : ""} in ${validation.normalizedPath}`,
            },
          ],
          details: { path: validation.normalizedPath, replaced },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error editing file: ${message}` }],
          details: { error: "edit_error", message },
        };
      }
    },
  });
}
