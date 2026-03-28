import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { globToRegex, validatePath } from "./paths.js";

const MAX_RESULTS = 200;

/**
 * Create a file_find tool backed by an R2 bucket.
 */
export function createFileFindTool(getBucket: () => R2Bucket, getPrefix: () => string): AgentTool {
  return defineTool({
    name: "file_find",
    description:
      "Search for files by glob pattern. Supports * (within directory), ** (across directories), and ? (single char).",
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "Glob pattern to match against file paths. Examples: **/*.ts, src/**/index.ts, *.json",
      }),
      path: Type.Optional(
        Type.String({
          description: "Optional directory path to scope the search. Defaults to storage root.",
        }),
      ),
    }),
    execute: async ({ pattern, path }) => {
      const storagePrefix = getPrefix();
      const prefixResult = resolveFindPrefix(path, storagePrefix);
      if ("error" in prefixResult) {
        return {
          content: [{ type: "text" as const, text: `Error: ${prefixResult.error}` }],
          details: { error: "invalid_path" },
        };
      }

      const { prefix, stripPrefix } = prefixResult;

      let regex: RegExp;
      try {
        regex = globToRegex(pattern);
      } catch {
        return {
          content: [{ type: "text" as const, text: `Error: Invalid glob pattern: ${pattern}` }],
          details: { error: "invalid_pattern" },
        };
      }

      try {
        const matches: string[] = [];
        let cursor: string | undefined;

        do {
          const result = await getBucket().list({
            prefix,
            cursor,
            limit: 1000,
          });

          for (const obj of result.objects) {
            const relativePath = obj.key.slice(stripPrefix.length);
            if (relativePath.length === 0) continue;

            if (regex.test(relativePath)) {
              matches.push(relativePath);
              if (matches.length >= MAX_RESULTS) {
                break;
              }
            }
          }

          if (matches.length >= MAX_RESULTS) break;
          cursor = result.truncated ? result.cursor : undefined;
        } while (cursor);

        let text: string;
        if (matches.length === 0) {
          text = "No files matched the pattern.";
        } else {
          text = matches.join("\n");
          if (matches.length >= MAX_RESULTS) {
            text += `\n\n[Results capped at ${MAX_RESULTS}. Refine your pattern or scope to see more.]`;
          }
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { pattern, matchCount: matches.length },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error searching files: ${message}` }],
          details: { error: "find_error", message },
        };
      }
    },
  }) as unknown as AgentTool;
}

function resolveFindPrefix(
  path: string | undefined,
  storagePrefix: string,
): { prefix: string; stripPrefix: string } | { error: string } {
  const rootPrefix = `${storagePrefix}/`;

  if (!path || path.trim() === "" || path.trim() === ".") {
    return { prefix: rootPrefix, stripPrefix: rootPrefix };
  }

  const validation = validatePath(path);
  if (!validation.valid) {
    return { error: validation.error };
  }

  const scopePrefix = `${storagePrefix}/${validation.normalizedPath}/`;
  return { prefix: scopePrefix, stripPrefix: scopePrefix };
}
