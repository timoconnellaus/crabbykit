import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import { validatePath } from "./paths.js";

const MAX_DEPTH = 5;
const MAX_ENTRIES_PER_LEVEL = 100;

/**
 * Create a file_tree tool backed by an R2 bucket.
 */
export function createFileTreeTool(getBucket: () => R2Bucket, getPrefix: () => string): AgentTool {
  return defineTool({
    name: "file_tree",
    description:
      "View storage structure as a hierarchical tree. Configurable depth (default 3, max 5).",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Directory path relative to storage root. Omit or leave empty for root.",
        }),
      ),
      depth: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_DEPTH,
          description: `Maximum depth to traverse (default 3, max ${MAX_DEPTH})`,
        }),
      ),
    }),
    execute: async ({ path, depth }) => {
      const cappedDepth = Math.min(depth ?? 3, MAX_DEPTH);
      const storagePrefix = getPrefix();

      const prefixResult = resolveTreePrefix(path, storagePrefix);
      if ("error" in prefixResult) {
        return {
          content: [{ type: "text" as const, text: `Error: ${prefixResult.error}` }],
          details: { error: "invalid_path" },
        };
      }

      const { prefix, displayRoot } = prefixResult;

      try {
        const lines: string[] = [];
        if (displayRoot) {
          lines.push(`${displayRoot}/`);
        }
        await buildTree(getBucket(), prefix, cappedDepth, 0, lines);

        const text = lines.length === 0 ? "Directory is empty." : lines.join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { path: path ?? "/", depth: cappedDepth },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error building tree: ${message}` }],
          details: { error: "tree_error", message },
        };
      }
    },
  }) as unknown as AgentTool;
}

async function buildTree(
  bucket: R2Bucket,
  prefix: string,
  maxDepth: number,
  currentDepth: number,
  lines: string[],
): Promise<void> {
  if (currentDepth >= maxDepth) {
    return;
  }

  const indent = "  ".repeat(currentDepth + 1);

  const files: string[] = [];
  const dirs: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix,
      delimiter: "/",
      cursor,
      limit: 1000,
    });

    for (const obj of result.objects) {
      const name = obj.key.slice(prefix.length);
      if (name.length > 0) {
        files.push(name);
      }
    }

    for (const dirPrefix of result.delimitedPrefixes) {
      const name = dirPrefix.slice(prefix.length).replace(/\/$/, "");
      if (name.length > 0) {
        dirs.push(name);
      }
    }

    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  const totalEntries = files.length + dirs.length;
  const truncated = totalEntries > MAX_ENTRIES_PER_LEVEL;
  const visibleFiles = truncated ? files.slice(0, MAX_ENTRIES_PER_LEVEL) : files;
  const visibleDirs = truncated ? dirs.slice(0, MAX_ENTRIES_PER_LEVEL - visibleFiles.length) : dirs;

  for (const name of visibleFiles) {
    lines.push(`${indent}${name}`);
  }

  for (const name of visibleDirs) {
    lines.push(`${indent}${name}/`);
    await buildTree(bucket, `${prefix}${name}/`, maxDepth, currentDepth + 1, lines);
  }

  if (truncated) {
    const shown = visibleFiles.length + visibleDirs.length;
    const remaining = totalEntries - shown;
    lines.push(`${indent}... and ${remaining} more items`);
  }
}

function resolveTreePrefix(
  path: string | undefined,
  storagePrefix: string,
): { prefix: string; displayRoot: string } | { error: string } {
  if (!path || path.trim() === "" || path.trim() === ".") {
    return { prefix: `${storagePrefix}/`, displayRoot: "" };
  }

  const validation = validatePath(path);
  if (!validation.valid) {
    return { error: validation.error };
  }

  return {
    prefix: `${storagePrefix}/${validation.normalizedPath}/`,
    displayRoot: validation.normalizedPath,
  };
}
