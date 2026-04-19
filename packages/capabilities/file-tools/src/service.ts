/**
 * FileToolsService — host-side WorkerEntrypoint that bundles call to perform
 * R2-backed file operations.
 *
 * Bundle-side `fileToolsClient` proxies to this service via JSRPC with the
 * unified `__BUNDLE_TOKEN`. The service verifies the token with
 * `requiredScope: "file-tools"`, validates paths, and performs the same R2
 * operations the static tools perform against the namespaced bucket.
 *
 * No `SPINE` binding is required on the service env. UI mutation broadcasts
 * for bundle-originated `file_write`/`file_edit`/`file_delete`/`file_copy`/
 * `file_move` events are produced by the static `fileTools(...)` capability's
 * `broadcastAgentMutation` (`afterToolExecution`) hook firing via the Phase 0
 * host hook bridge. The service is a pure RPC executor.
 *
 * The HKDF subkey is derived from `AGENT_AUTH_KEY` using the shared
 * `BUNDLE_SUBKEY_LABEL` (`"claw/bundle-v1"`) on first call and cached for
 * the lifetime of the entrypoint instance.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { BUNDLE_SUBKEY_LABEL, deriveVerifyOnlySubkey, verifyToken } from "@crabbykit/bundle-token";
import { globToRegex, toR2Key, validatePath } from "./paths.js";
import { SCHEMA_CONTENT_HASH } from "./schemas.js";

/** Default maximum bytes returned by `read` — matches the static capability's default. */
const DEFAULT_MAX_READ_BYTES = 512 * 1024;

/** Maximum bytes accepted by `write` — matches the static capability. */
const MAX_WRITE_BYTES = 1_048_576;

/** Maximum tree depth `tree` will traverse. */
const MAX_TREE_DEPTH = 5;

/** Maximum entries per level before `tree` truncates. */
const MAX_TREE_ENTRIES_PER_LEVEL = 100;

/** Maximum results `find` will return. */
const MAX_FIND_RESULTS = 200;

export interface FileToolsServiceEnv {
  /**
   * Master HMAC secret (string). Used to lazily derive the verify-only
   * subkey on first call via HKDF with label `BUNDLE_SUBKEY_LABEL`.
   */
  AGENT_AUTH_KEY: string;
  /** R2 bucket storing files under `{STORAGE_NAMESPACE}/<path>`. */
  STORAGE_BUCKET: R2Bucket;
  /** R2 namespace prefix (typically the agent id). */
  STORAGE_NAMESPACE: string;
}

/**
 * Compile-time check documenting Decision 8: the service env intentionally
 * does NOT declare a SPINE binding. UI broadcasts are produced by the
 * static capability's hook firing via the Phase 0 bridge, not by the
 * service. If a future change adds `SPINE` to `FileToolsServiceEnv`, this
 * assertion flips and the build fails — forcing a re-review of Decision 8.
 */
// biome-ignore lint/correctness/noUnusedVariables: intentional compile-time assertion
type _NoSpine = FileToolsServiceEnv extends { SPINE: unknown } ? never : true;

/** Method result shape — `text` is what the client renders to the LLM. */
export interface FileToolResult<Details = Record<string, unknown>> {
  text: string;
  details: Details;
}

// --- Helpers ---

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

  const encoded = new TextEncoder().encode(result);
  if (encoded.byteLength > maxBytes) {
    const truncated = new TextDecoder().decode(encoded.slice(0, maxBytes));
    const lastNewline = truncated.lastIndexOf("\n");
    result = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;

    const shownLines = result.split("\n").length;
    result += `\n\n[File truncated at ${shownLines} lines (of ${totalLines} total). Use offset/limit parameters to read more.]`;
  }

  return result;
}

function resolveListPrefix(
  path: string | undefined,
  storagePrefix: string,
): { prefix: string } | { error: string } {
  if (!path || path.trim() === "" || path.trim() === ".") {
    return { prefix: `${storagePrefix}/` };
  }
  const validation = validatePath(path);
  if (!validation.valid) return { error: validation.error };
  return { prefix: `${storagePrefix}/${validation.normalizedPath}/` };
}

function resolveTreePrefix(
  path: string | undefined,
  storagePrefix: string,
): { prefix: string; displayRoot: string } | { error: string } {
  if (!path || path.trim() === "" || path.trim() === ".") {
    return { prefix: `${storagePrefix}/`, displayRoot: "" };
  }
  const validation = validatePath(path);
  if (!validation.valid) return { error: validation.error };
  return {
    prefix: `${storagePrefix}/${validation.normalizedPath}/`,
    displayRoot: validation.normalizedPath,
  };
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
  if (!validation.valid) return { error: validation.error };
  const scopePrefix = `${storagePrefix}/${validation.normalizedPath}/`;
  return { prefix: scopePrefix, stripPrefix: scopePrefix };
}

async function buildTree(
  bucket: R2Bucket,
  prefix: string,
  maxDepth: number,
  currentDepth: number,
  lines: string[],
): Promise<void> {
  if (currentDepth >= maxDepth) return;

  const indent = "  ".repeat(currentDepth + 1);

  const files: string[] = [];
  const dirs: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 });

    for (const obj of result.objects) {
      const name = obj.key.slice(prefix.length);
      if (name.length > 0) files.push(name);
    }

    for (const dirPrefix of result.delimitedPrefixes) {
      const name = dirPrefix.slice(prefix.length).replace(/\/$/, "");
      if (name.length > 0) dirs.push(name);
    }

    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  const totalEntries = files.length + dirs.length;
  const truncated = totalEntries > MAX_TREE_ENTRIES_PER_LEVEL;
  const visibleFiles = truncated ? files.slice(0, MAX_TREE_ENTRIES_PER_LEVEL) : files;
  const visibleDirs = truncated
    ? dirs.slice(0, MAX_TREE_ENTRIES_PER_LEVEL - visibleFiles.length)
    : dirs;

  for (const name of visibleFiles) lines.push(`${indent}${name}`);
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

// --- Service ---

export class FileToolsService extends WorkerEntrypoint<FileToolsServiceEnv> {
  private subkeyPromise: Promise<CryptoKey> | null = null;

  /**
   * Lazily derive (and cache) the verify-only HKDF subkey from the master
   * `AGENT_AUTH_KEY`. Uses the unified `BUNDLE_SUBKEY_LABEL`.
   */
  private getSubkey(): Promise<CryptoKey> {
    if (!this.subkeyPromise) {
      if (!this.env.AGENT_AUTH_KEY) {
        throw new Error("FileToolsService misconfigured: env.AGENT_AUTH_KEY is missing");
      }
      this.subkeyPromise = deriveVerifyOnlySubkey(this.env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    }
    return this.subkeyPromise;
  }

  /** Shared preamble: schema-drift check + token verify. Throws on failure. */
  private async verify(token: string, schemaHash?: string): Promise<void> {
    if (schemaHash && schemaHash !== SCHEMA_CONTENT_HASH) {
      throw new Error("ERR_SCHEMA_VERSION");
    }
    const subkey = await this.getSubkey();
    const verifyResult = await verifyToken(token, subkey, { requiredScope: "file-tools" });
    if (!verifyResult.valid) {
      throw new Error(verifyResult.code);
    }
  }

  // --- read ---

  async read(
    token: string,
    args: { path: string; offset?: number; limit?: number },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const validation = validatePath(args.path);
    if (!validation.valid) {
      return { text: `Error: ${validation.error}`, details: { error: "invalid_path" } };
    }

    const r2Key = toR2Key(this.env.STORAGE_NAMESPACE, validation.normalizedPath);

    try {
      const object = await this.env.STORAGE_BUCKET.get(r2Key);
      if (object === null) {
        return {
          text: `Error: File not found: ${validation.normalizedPath}`,
          details: { error: "not_found", path: validation.normalizedPath },
        };
      }
      const text = await object.text();
      const result = applyOffsetLimitAndTruncate(
        text,
        DEFAULT_MAX_READ_BYTES,
        args.offset,
        args.limit,
      );
      return {
        text: result,
        details: {
          path: validation.normalizedPath,
          bytes: new TextEncoder().encode(result).byteLength,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: `Error reading file: ${message}`, details: { error: "read_error", message } };
    }
  }

  // --- write ---

  async write(
    token: string,
    args: { path: string; content: string },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const validation = validatePath(args.path);
    if (!validation.valid) {
      return { text: `Error: ${validation.error}`, details: { error: "invalid_path" } };
    }

    const contentBytes = new TextEncoder().encode(args.content).byteLength;
    if (contentBytes > MAX_WRITE_BYTES) {
      return {
        text: `Error: Content size (${contentBytes} bytes) exceeds the 1MB limit`,
        details: { error: "content_too_large", bytes: contentBytes },
      };
    }

    const prefix = this.env.STORAGE_NAMESPACE;
    const r2Key = toR2Key(prefix, validation.normalizedPath);
    const bucket = this.env.STORAGE_BUCKET;

    try {
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

      await bucket.put(r2Key, args.content);

      return {
        text: `Successfully wrote ${contentBytes} bytes to ${validation.normalizedPath}`,
        details: { path: validation.normalizedPath, bytes: contentBytes },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        text: `Error writing file: ${message}`,
        details: { error: "write_error", message },
      };
    }
  }

  // --- edit ---

  async edit(
    token: string,
    args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const validation = validatePath(args.path);
    if (!validation.valid) {
      return { text: `Error: ${validation.error}`, details: { error: "invalid_path" } };
    }

    if (args.old_string === args.new_string) {
      return {
        text: "No changes made: old_string and new_string are identical",
        details: { path: validation.normalizedPath, replaced: 0 },
      };
    }

    const r2Key = toR2Key(this.env.STORAGE_NAMESPACE, validation.normalizedPath);
    const bucket = this.env.STORAGE_BUCKET;
    const replaceAll = args.replace_all ?? false;

    try {
      const object = await bucket.get(r2Key);
      if (object === null) {
        return {
          text: `Error: File not found: ${validation.normalizedPath}`,
          details: { error: "not_found", path: validation.normalizedPath },
        };
      }

      const content = await object.text();

      let count = 0;
      let idx = content.indexOf(args.old_string);
      while (idx !== -1) {
        count++;
        idx = content.indexOf(args.old_string, idx + args.old_string.length);
      }

      if (count === 0) {
        return {
          text: `Error: String not found in ${validation.normalizedPath}. Verify the exact text including whitespace and indentation.`,
          details: { error: "string_not_found", path: validation.normalizedPath },
        };
      }

      if (count > 1 && !replaceAll) {
        return {
          text: `Error: Found ${count} occurrences in ${validation.normalizedPath}. Provide more surrounding context to make the match unique, or set replace_all=true.`,
          details: { error: "ambiguous_match", count, path: validation.normalizedPath },
        };
      }

      let newContent: string;
      if (replaceAll) {
        newContent = content.split(args.old_string).join(args.new_string);
      } else {
        const pos = content.indexOf(args.old_string);
        newContent =
          content.slice(0, pos) + args.new_string + content.slice(pos + args.old_string.length);
      }

      await bucket.put(r2Key, newContent);

      const replaced = replaceAll ? count : 1;
      return {
        text: `Successfully replaced ${replaced} occurrence${replaced !== 1 ? "s" : ""} in ${validation.normalizedPath}`,
        details: { path: validation.normalizedPath, replaced },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: `Error editing file: ${message}`, details: { error: "edit_error", message } };
    }
  }

  // --- delete ---

  async delete(
    token: string,
    args: { path: string },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const validation = validatePath(args.path);
    if (!validation.valid) {
      return { text: `Error: ${validation.error}`, details: { error: "invalid_path" } };
    }

    const r2Key = toR2Key(this.env.STORAGE_NAMESPACE, validation.normalizedPath);

    try {
      await this.env.STORAGE_BUCKET.delete(r2Key);
      return {
        text: `Successfully deleted ${validation.normalizedPath}`,
        details: { path: validation.normalizedPath },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        text: `Error deleting file: ${message}`,
        details: { error: "delete_error", message },
      };
    }
  }

  // --- copy ---

  async copy(
    token: string,
    args: { source: string; destination: string },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const srcValidation = validatePath(args.source);
    if (!srcValidation.valid) {
      return {
        text: `Error: source path: ${srcValidation.error}`,
        details: { error: "invalid_path" },
      };
    }

    const dstValidation = validatePath(args.destination);
    if (!dstValidation.valid) {
      return {
        text: `Error: destination path: ${dstValidation.error}`,
        details: { error: "invalid_path" },
      };
    }

    const bucket = this.env.STORAGE_BUCKET;
    const prefix = this.env.STORAGE_NAMESPACE;
    const srcKey = toR2Key(prefix, srcValidation.normalizedPath);
    const dstKey = toR2Key(prefix, dstValidation.normalizedPath);

    try {
      const object = await bucket.get(srcKey);
      if (object === null) {
        return {
          text: `Error: source file not found: ${srcValidation.normalizedPath}`,
          details: { error: "not_found" },
        };
      }
      await bucket.put(dstKey, await object.arrayBuffer());

      return {
        text: `Copied ${srcValidation.normalizedPath} → ${dstValidation.normalizedPath}`,
        details: {
          source: srcValidation.normalizedPath,
          destination: dstValidation.normalizedPath,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: `Error copying file: ${message}`, details: { error: "copy_error", message } };
    }
  }

  // --- move ---

  async move(
    token: string,
    args: { source: string; destination: string },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const srcValidation = validatePath(args.source);
    if (!srcValidation.valid) {
      return {
        text: `Error: source path: ${srcValidation.error}`,
        details: { error: "invalid_path" },
      };
    }

    const dstValidation = validatePath(args.destination);
    if (!dstValidation.valid) {
      return {
        text: `Error: destination path: ${dstValidation.error}`,
        details: { error: "invalid_path" },
      };
    }

    const bucket = this.env.STORAGE_BUCKET;
    const prefix = this.env.STORAGE_NAMESPACE;
    const srcKey = toR2Key(prefix, srcValidation.normalizedPath);
    const dstKey = toR2Key(prefix, dstValidation.normalizedPath);

    try {
      const object = await bucket.get(srcKey);
      if (object === null) {
        return {
          text: `Error: source file not found: ${srcValidation.normalizedPath}`,
          details: { error: "not_found" },
        };
      }
      await bucket.put(dstKey, await object.arrayBuffer());
      await bucket.delete(srcKey);

      return {
        text: `Moved ${srcValidation.normalizedPath} → ${dstValidation.normalizedPath}`,
        details: {
          source: srcValidation.normalizedPath,
          destination: dstValidation.normalizedPath,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: `Error moving file: ${message}`, details: { error: "move_error", message } };
    }
  }

  // --- list ---

  async list(
    token: string,
    args: { path?: string; cursor?: string },
    schemaHash?: string,
  ): Promise<
    FileToolResult<{
      entries?: Array<{ name: string; type: "file" | "directory" }>;
      cursor?: string;
      error?: string;
      message?: string;
    }>
  > {
    await this.verify(token, schemaHash);

    const prefixResult = resolveListPrefix(args.path, this.env.STORAGE_NAMESPACE);
    if ("error" in prefixResult) {
      return { text: `Error: ${prefixResult.error}`, details: { error: "invalid_path" } };
    }
    const { prefix } = prefixResult;

    try {
      const result = await this.env.STORAGE_BUCKET.list({
        prefix,
        delimiter: "/",
        cursor: args.cursor,
        limit: 1000,
      });

      const entries: Array<{ name: string; type: "file" | "directory" }> = [];

      for (const obj of result.objects) {
        const name = obj.key.slice(prefix.length);
        if (name.length > 0) entries.push({ name, type: "file" });
      }
      for (const dirPrefix of result.delimitedPrefixes) {
        const name = dirPrefix.slice(prefix.length).replace(/\/$/, "");
        if (name.length > 0) entries.push({ name, type: "directory" });
      }

      const formatted = entries
        .map((e) => `${e.type === "directory" ? "📁" : "📄"} ${e.name}`)
        .join("\n");

      const text =
        entries.length === 0
          ? "Directory is empty."
          : result.truncated
            ? `${formatted}\n\n[Truncated — use cursor "${result.cursor}" to see more]`
            : formatted;

      return {
        text,
        details: { entries, cursor: result.truncated ? result.cursor : undefined },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        text: `Error listing directory: ${message}`,
        details: { error: "list_error", message },
      };
    }
  }

  // --- tree ---

  async tree(
    token: string,
    args: { path?: string; depth?: number },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const cappedDepth = Math.min(args.depth ?? 3, MAX_TREE_DEPTH);
    const storagePrefix = this.env.STORAGE_NAMESPACE;

    const prefixResult = resolveTreePrefix(args.path, storagePrefix);
    if ("error" in prefixResult) {
      return { text: `Error: ${prefixResult.error}`, details: { error: "invalid_path" } };
    }
    const { prefix, displayRoot } = prefixResult;

    try {
      const lines: string[] = [];
      if (displayRoot) lines.push(`${displayRoot}/`);
      await buildTree(this.env.STORAGE_BUCKET, prefix, cappedDepth, 0, lines);

      const text = lines.length === 0 ? "Directory is empty." : lines.join("\n");
      return { text, details: { path: args.path ?? "/", depth: cappedDepth } };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        text: `Error building tree: ${message}`,
        details: { error: "tree_error", message },
      };
    }
  }

  // --- find ---

  async find(
    token: string,
    args: { pattern: string; path?: string },
    schemaHash?: string,
  ): Promise<FileToolResult> {
    await this.verify(token, schemaHash);

    const prefixResult = resolveFindPrefix(args.path, this.env.STORAGE_NAMESPACE);
    if ("error" in prefixResult) {
      return { text: `Error: ${prefixResult.error}`, details: { error: "invalid_path" } };
    }
    const { prefix, stripPrefix } = prefixResult;

    let regex: RegExp;
    try {
      regex = globToRegex(args.pattern);
    } catch {
      return {
        text: `Error: Invalid glob pattern: ${args.pattern}`,
        details: { error: "invalid_pattern" },
      };
    }

    try {
      const matches: string[] = [];
      let cursor: string | undefined;

      do {
        const result = await this.env.STORAGE_BUCKET.list({ prefix, cursor, limit: 1000 });

        for (const obj of result.objects) {
          const relativePath = obj.key.slice(stripPrefix.length);
          if (relativePath.length === 0) continue;
          if (regex.test(relativePath)) {
            matches.push(relativePath);
            if (matches.length >= MAX_FIND_RESULTS) break;
          }
        }

        if (matches.length >= MAX_FIND_RESULTS) break;
        cursor = result.truncated ? result.cursor : undefined;
      } while (cursor);

      let text: string;
      if (matches.length === 0) {
        text = "No files matched the pattern.";
      } else {
        text = matches.join("\n");
        if (matches.length >= MAX_FIND_RESULTS) {
          text += `\n\n[Results capped at ${MAX_FIND_RESULTS}. Refine your pattern or scope to see more.]`;
        }
      }

      return { text, details: { pattern: args.pattern, matchCount: matches.length } };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        text: `Error searching files: ${message}`,
        details: { error: "find_error", message },
      };
    }
  }
}
