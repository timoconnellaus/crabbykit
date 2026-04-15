import type { CapabilityHookContext, ToolExecutionEvent } from "@claw-for-cloudflare/agent-runtime";
import { resolveListPrefix, toR2Key, validatePath } from "./paths.js";

/**
 * UI bridge for the file-tools capability.
 *
 * Surfaces file operations to a UI panel through the existing
 * `capability_action` / `capability_state` transport, without adding
 * HTTP routes or polluting the agent's session history with tool calls.
 *
 * Protocol:
 * - Client → server: `capability_action { capabilityId: "file-tools", action, data }`
 * - Server → client: `capability_state { capabilityId: "file-tools", event, data }`
 *
 * Action              Request data                                   Response event
 * ---------------     --------------------------------------------   ----------------
 * `list`              `{ path?: string }`                             `dir_listing { path, entries }`
 * `read`              `{ path: string }`                              `file_content { path, content, etag, isBinary, isLarge, largeSize? }`
 * `write`             `{ path, content, etag? }`                      `file_saved { path, etag }` or `file_conflict { path, reason }`
 * `create`            `{ path }`                                      `file_saved { path, etag }` or `file_error { action: "create", path, message }`
 * `delete`            `{ path }`                                      `file_changed { path }` (and parent invalidate)
 * `rename`            `{ oldPath, newPath }`                          `file_changed { path: oldPath | newPath }`
 *
 * When the agent itself mutates a file via one of the file-tools tools,
 * `afterToolExecution` fires a `file_changed` broadcast so the UI
 * invalidates its cache without a polling loop.
 */

const EDITOR_BYTE_LIMIT = 512 * 1024;
const BINARY_PROBE_BYTES = 8192;

export interface DirEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  etag: string;
  isBinary: boolean;
  isLarge: boolean;
  largeSize?: number;
}

export interface FileSaved {
  path: string;
  etag: string;
}

export interface FileConflict {
  path: string;
  reason: string;
}

export interface FileChanged {
  path: string;
}

export interface FileError {
  action: string;
  path?: string;
  message: string;
}

/**
 * Compute a content-hash etag. SHA-256 truncated to 16 hex chars is
 * plenty to disambiguate the small editor window — we're not doing
 * cryptographic integrity, just optimistic concurrency.
 */
async function computeEtag(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex: string[] = [];
  const view = new Uint8Array(digest, 0, 8);
  for (const byte of view) {
    hex.push(byte.toString(16).padStart(2, "0"));
  }
  return hex.join("");
}

/**
 * Binary detection: scan first 8k bytes for NUL characters. Matches the
 * heuristic the agent-side tools use and keeps the editor from trying
 * to render arbitrary binary blobs.
 */
function isLikelyBinary(bytes: Uint8Array): boolean {
  const probe = Math.min(bytes.byteLength, BINARY_PROBE_BYTES);
  for (let i = 0; i < probe; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

async function listDirectory(
  bucket: R2Bucket,
  storagePrefix: string,
  path: string | undefined,
): Promise<DirListing> {
  const normalizedPath = path && path.trim() !== "" && path.trim() !== "." ? path : "";
  const prefixResult = resolveListPrefix(normalizedPath, storagePrefix);
  if ("error" in prefixResult) {
    throw new Error(prefixResult.error);
  }

  const { prefix } = prefixResult;
  const entries: DirEntry[] = [];
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
        entries.push({ name, type: "file", size: obj.size });
      }
    }

    for (const dirPrefix of result.delimitedPrefixes) {
      const name = dirPrefix.slice(prefix.length).replace(/\/$/, "");
      if (name.length > 0) {
        entries.push({ name, type: "directory" });
      }
    }

    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: normalizedPath, entries };
}

async function readFile(
  bucket: R2Bucket,
  storagePrefix: string,
  path: string,
): Promise<FileContent> {
  const validation = validatePath(path);
  if (!validation.valid) throw new Error(validation.error);

  const key = toR2Key(storagePrefix, validation.normalizedPath);
  const object = await bucket.get(key);
  if (object === null) {
    throw new Error(`File not found: ${validation.normalizedPath}`);
  }

  const buffer = await object.arrayBuffer();
  const size = buffer.byteLength;
  const bytes = new Uint8Array(buffer);

  if (isLikelyBinary(bytes)) {
    return {
      path: validation.normalizedPath,
      content: "",
      etag: "",
      isBinary: true,
      isLarge: false,
    };
  }

  if (size > EDITOR_BYTE_LIMIT) {
    return {
      path: validation.normalizedPath,
      content: "",
      etag: "",
      isBinary: false,
      isLarge: true,
      largeSize: size,
    };
  }

  const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const etag = await computeEtag(buffer);
  return {
    path: validation.normalizedPath,
    content,
    etag,
    isBinary: false,
    isLarge: false,
  };
}

async function currentEtag(
  bucket: R2Bucket,
  key: string,
): Promise<{ etag: string; exists: boolean }> {
  const object = await bucket.get(key);
  if (object === null) return { etag: "", exists: false };
  const buffer = await object.arrayBuffer();
  const etag = await computeEtag(buffer);
  return { etag, exists: true };
}

async function writeFile(
  bucket: R2Bucket,
  storagePrefix: string,
  path: string,
  content: string,
  expectedEtag: string | undefined,
): Promise<FileSaved | FileConflict> {
  const validation = validatePath(path);
  if (!validation.valid) throw new Error(validation.error);

  const key = toR2Key(storagePrefix, validation.normalizedPath);
  const current = await currentEtag(bucket, key);

  if (expectedEtag !== undefined && current.exists && current.etag !== expectedEtag) {
    return {
      path: validation.normalizedPath,
      reason: "File was modified since you opened it.",
    };
  }

  // Create zero-byte directory markers for intermediate path segments
  const segments = validation.normalizedPath.split("/");
  if (segments.length > 1) {
    for (let i = 1; i < segments.length; i++) {
      const dirPath = `${storagePrefix}/${segments.slice(0, i).join("/")}/`;
      const existing = await bucket.head(dirPath);
      if (existing === null) {
        await bucket.put(dirPath, "");
      }
    }
  }

  await bucket.put(key, content);
  const newBuffer = new TextEncoder().encode(content);
  const etag = await computeEtag(
    newBuffer.buffer.slice(newBuffer.byteOffset, newBuffer.byteOffset + newBuffer.byteLength),
  );
  return { path: validation.normalizedPath, etag };
}

async function createFile(
  bucket: R2Bucket,
  storagePrefix: string,
  path: string,
): Promise<FileSaved> {
  const validation = validatePath(path);
  if (!validation.valid) throw new Error(validation.error);

  const key = toR2Key(storagePrefix, validation.normalizedPath);
  const existing = await bucket.head(key);
  if (existing !== null) {
    throw new Error(`File already exists: ${validation.normalizedPath}`);
  }

  // Create parent directory markers
  const segments = validation.normalizedPath.split("/");
  if (segments.length > 1) {
    for (let i = 1; i < segments.length; i++) {
      const dirPath = `${storagePrefix}/${segments.slice(0, i).join("/")}/`;
      const existingDir = await bucket.head(dirPath);
      if (existingDir === null) {
        await bucket.put(dirPath, "");
      }
    }
  }

  await bucket.put(key, "");
  const etag = await computeEtag(new ArrayBuffer(0));
  return { path: validation.normalizedPath, etag };
}

async function deleteFile(bucket: R2Bucket, storagePrefix: string, path: string): Promise<string> {
  const validation = validatePath(path);
  if (!validation.valid) throw new Error(validation.error);

  const key = toR2Key(storagePrefix, validation.normalizedPath);
  await bucket.delete(key);
  return validation.normalizedPath;
}

async function renameFile(
  bucket: R2Bucket,
  storagePrefix: string,
  oldPath: string,
  newPath: string,
): Promise<{ oldPath: string; newPath: string }> {
  const srcValidation = validatePath(oldPath);
  if (!srcValidation.valid) throw new Error(`source: ${srcValidation.error}`);
  const dstValidation = validatePath(newPath);
  if (!dstValidation.valid) throw new Error(`destination: ${dstValidation.error}`);

  const srcKey = toR2Key(storagePrefix, srcValidation.normalizedPath);
  const dstKey = toR2Key(storagePrefix, dstValidation.normalizedPath);

  if (srcKey === dstKey) {
    return { oldPath: srcValidation.normalizedPath, newPath: dstValidation.normalizedPath };
  }

  const existing = await bucket.head(dstKey);
  if (existing !== null) {
    throw new Error(`Destination already exists: ${dstValidation.normalizedPath}`);
  }

  const object = await bucket.get(srcKey);
  if (object === null) {
    throw new Error(`Source file not found: ${srcValidation.normalizedPath}`);
  }

  await bucket.put(dstKey, await object.arrayBuffer());
  await bucket.delete(srcKey);

  return {
    oldPath: srcValidation.normalizedPath,
    newPath: dstValidation.normalizedPath,
  };
}

/**
 * Recursively list every object key under the given prefix (no delimiter),
 * paging through cursors. Used by directory-level mutations.
 */
async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of result.objects) keys.push(obj.key);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return keys;
}

async function createDirectory(
  bucket: R2Bucket,
  storagePrefix: string,
  path: string,
): Promise<string> {
  const validation = validatePath(path);
  if (!validation.valid) throw new Error(validation.error);

  const segments = validation.normalizedPath.split("/");
  // Create intermediate + leaf directory markers.
  for (let i = 1; i <= segments.length; i++) {
    const dirPath = `${storagePrefix}/${segments.slice(0, i).join("/")}/`;
    const existing = await bucket.head(dirPath);
    if (existing === null) {
      await bucket.put(dirPath, "");
    }
  }
  return validation.normalizedPath;
}

async function deleteDirectory(
  bucket: R2Bucket,
  storagePrefix: string,
  path: string,
): Promise<string> {
  const validation = validatePath(path);
  if (!validation.valid) throw new Error(validation.error);

  const prefix = `${storagePrefix}/${validation.normalizedPath}/`;
  const keys = await listAllKeys(bucket, prefix);
  // Also include the bare marker if it exists (`prefix` ends with /, so it
  // should be in `keys` already — but list delimiter behavior can miss the
  // marker key itself, so head/delete defensively.
  const markerHead = await bucket.head(prefix);
  if (markerHead !== null && !keys.includes(prefix)) {
    keys.push(prefix);
  }
  if (keys.length === 0) {
    throw new Error(`Directory not found: ${validation.normalizedPath}`);
  }
  // R2's batch delete accepts up to 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
  return validation.normalizedPath;
}

async function renameDirectory(
  bucket: R2Bucket,
  storagePrefix: string,
  oldPath: string,
  newPath: string,
): Promise<{ oldPath: string; newPath: string }> {
  const srcValidation = validatePath(oldPath);
  if (!srcValidation.valid) throw new Error(`source: ${srcValidation.error}`);
  const dstValidation = validatePath(newPath);
  if (!dstValidation.valid) throw new Error(`destination: ${dstValidation.error}`);

  if (srcValidation.normalizedPath === dstValidation.normalizedPath) {
    return { oldPath: srcValidation.normalizedPath, newPath: dstValidation.normalizedPath };
  }

  // Refuse to move a directory into itself.
  if (dstValidation.normalizedPath.startsWith(`${srcValidation.normalizedPath}/`)) {
    throw new Error("Cannot move a directory into itself.");
  }

  const srcPrefix = `${storagePrefix}/${srcValidation.normalizedPath}/`;
  const dstPrefix = `${storagePrefix}/${dstValidation.normalizedPath}/`;

  // Refuse to clobber an existing destination.
  const destMarker = await bucket.head(dstPrefix);
  if (destMarker !== null) {
    throw new Error(`Destination already exists: ${dstValidation.normalizedPath}`);
  }
  const destContents = await bucket.list({ prefix: dstPrefix, limit: 1 });
  if (destContents.objects.length > 0) {
    throw new Error(`Destination already exists: ${dstValidation.normalizedPath}`);
  }

  const keys = await listAllKeys(bucket, srcPrefix);
  const markerHead = await bucket.head(srcPrefix);
  if (markerHead !== null && !keys.includes(srcPrefix)) {
    keys.push(srcPrefix);
  }
  if (keys.length === 0) {
    throw new Error(`Directory not found: ${srcValidation.normalizedPath}`);
  }

  for (const key of keys) {
    const relative = key.slice(srcPrefix.length);
    const newKey = `${dstPrefix}${relative}`;
    if (key === srcPrefix) {
      // Directory marker — recreate empty at destination.
      await bucket.put(newKey, "");
      continue;
    }
    const object = await bucket.get(key);
    if (object === null) continue;
    await bucket.put(newKey, await object.arrayBuffer());
  }

  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }

  return {
    oldPath: srcValidation.normalizedPath,
    newPath: dstValidation.normalizedPath,
  };
}

/**
 * Dispatch a `capability_action` message for the file-tools capability.
 * Looks up the bucket/prefix from the supplied closures so tests can
 * inject a mock without touching the capability factory signature.
 */
export async function dispatchUiAction(
  action: string,
  data: unknown,
  ctx: CapabilityHookContext,
  getBucket: () => R2Bucket,
  getPrefix: () => string,
): Promise<void> {
  const bucket = getBucket();
  const storagePrefix = getPrefix();
  const record = (data ?? {}) as Record<string, unknown>;

  const emitError = (message: string, path?: string) => {
    ctx.broadcastState?.("file_error", { action, path, message } satisfies FileError, "global");
  };

  try {
    switch (action) {
      case "list": {
        const path = typeof record.path === "string" ? record.path : undefined;
        const listing = await listDirectory(bucket, storagePrefix, path);
        ctx.broadcastState?.("dir_listing", listing satisfies DirListing, "global");
        return;
      }
      case "read": {
        const path = typeof record.path === "string" ? record.path : "";
        if (!path) {
          emitError("A path is required.");
          return;
        }
        const file = await readFile(bucket, storagePrefix, path);
        ctx.broadcastState?.("file_content", file satisfies FileContent, "global");
        return;
      }
      case "write": {
        const path = typeof record.path === "string" ? record.path : "";
        const content = typeof record.content === "string" ? record.content : "";
        const etag = typeof record.etag === "string" ? record.etag : undefined;
        if (!path) {
          emitError("A path is required.");
          return;
        }
        const result = await writeFile(bucket, storagePrefix, path, content, etag);
        if ("reason" in result) {
          ctx.broadcastState?.("file_conflict", result satisfies FileConflict, "global");
          return;
        }
        ctx.broadcastState?.("file_saved", result satisfies FileSaved, "global");
        ctx.broadcastState?.("file_changed", { path: result.path } satisfies FileChanged, "global");
        return;
      }
      case "create": {
        const path = typeof record.path === "string" ? record.path : "";
        if (!path) {
          emitError("A path is required.", path);
          return;
        }
        const result = await createFile(bucket, storagePrefix, path);
        ctx.broadcastState?.("file_saved", result satisfies FileSaved, "global");
        ctx.broadcastState?.("file_changed", { path: result.path } satisfies FileChanged, "global");
        return;
      }
      case "delete": {
        const path = typeof record.path === "string" ? record.path : "";
        if (!path) {
          emitError("A path is required.");
          return;
        }
        const deleted = await deleteFile(bucket, storagePrefix, path);
        ctx.broadcastState?.("file_changed", { path: deleted } satisfies FileChanged, "global");
        return;
      }
      case "rename": {
        const oldPath = typeof record.oldPath === "string" ? record.oldPath : "";
        const newPath = typeof record.newPath === "string" ? record.newPath : "";
        if (!oldPath || !newPath) {
          emitError("Both oldPath and newPath are required.");
          return;
        }
        const result = await renameFile(bucket, storagePrefix, oldPath, newPath);
        ctx.broadcastState?.(
          "file_changed",
          { path: result.oldPath } satisfies FileChanged,
          "global",
        );
        ctx.broadcastState?.(
          "file_changed",
          { path: result.newPath } satisfies FileChanged,
          "global",
        );
        return;
      }
      case "mkdir": {
        const path = typeof record.path === "string" ? record.path : "";
        if (!path) {
          emitError("A path is required.");
          return;
        }
        const created = await createDirectory(bucket, storagePrefix, path);
        ctx.broadcastState?.("file_changed", { path: created } satisfies FileChanged, "global");
        return;
      }
      case "rmdir": {
        const path = typeof record.path === "string" ? record.path : "";
        if (!path) {
          emitError("A path is required.");
          return;
        }
        const deleted = await deleteDirectory(bucket, storagePrefix, path);
        ctx.broadcastState?.("file_changed", { path: deleted } satisfies FileChanged, "global");
        return;
      }
      case "rename_dir": {
        const oldPath = typeof record.oldPath === "string" ? record.oldPath : "";
        const newPath = typeof record.newPath === "string" ? record.newPath : "";
        if (!oldPath || !newPath) {
          emitError("Both oldPath and newPath are required.");
          return;
        }
        const result = await renameDirectory(bucket, storagePrefix, oldPath, newPath);
        ctx.broadcastState?.(
          "file_changed",
          { path: result.oldPath } satisfies FileChanged,
          "global",
        );
        ctx.broadcastState?.(
          "file_changed",
          { path: result.newPath } satisfies FileChanged,
          "global",
        );
        return;
      }
      default: {
        emitError(`Unknown action: ${action}`);
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError(message, typeof record.path === "string" ? record.path : undefined);
  }
}

/**
 * Map of agent-side file tools to the argument field that carries the
 * mutated path. Used by `afterToolExecution` to emit a `file_changed`
 * broadcast so the UI invalidates its cache without polling.
 *
 * Read-only tools are omitted — the UI only cares about mutations.
 */
const MUTATION_PATH_FIELDS: Record<string, "path" | "destination"> = {
  file_write: "path",
  file_edit: "path",
  file_delete: "path",
  file_copy: "destination",
  file_move: "destination",
};

/**
 * afterToolExecution hook that broadcasts `file_changed` events when
 * the agent mutates a file. Observation-only — errors caught by the
 * runtime, failed tool invocations skipped.
 */
export async function broadcastAgentMutation(
  event: ToolExecutionEvent,
  ctx: CapabilityHookContext,
): Promise<void> {
  if (event.isError) return;
  const field = MUTATION_PATH_FIELDS[event.toolName];
  if (!field) return;

  const args = (event.args ?? {}) as Record<string, unknown>;
  const path = args[field];
  if (typeof path !== "string" || path.length === 0) return;

  const validation = validatePath(path);
  if (!validation.valid) return;

  ctx.broadcastState?.(
    "file_changed",
    { path: validation.normalizedPath } satisfies FileChanged,
    "global",
  );

  // For moves, also notify the source path so the UI drops its cache entry.
  if (event.toolName === "file_move") {
    const source = args.source;
    if (typeof source === "string" && source.length > 0) {
      const srcValidation = validatePath(source);
      if (srcValidation.valid) {
        ctx.broadcastState?.(
          "file_changed",
          { path: srcValidation.normalizedPath } satisfies FileChanged,
          "global",
        );
      }
    }
  }
}
