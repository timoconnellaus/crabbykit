import type { AgentContext, Capability } from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import { createFileCopyTool } from "./file-copy.js";
import { createFileDeleteTool } from "./file-delete.js";
import { createFileEditTool } from "./file-edit.js";
import { createFileFindTool } from "./file-find.js";
import { createFileListTool } from "./file-list.js";
import { createFileMoveTool } from "./file-move.js";
import { createFileReadTool } from "./file-read.js";
import { createFileTreeTool } from "./file-tree.js";
import { createFileWriteTool } from "./file-write.js";

const DEFAULT_MAX_READ_BYTES = 512 * 1024;

export interface R2StorageOptions {
  /** Shared agent storage identity. Provides the R2 bucket and namespace prefix. */
  storage: AgentStorage;
  /** Maximum bytes to return from file_read (default 512KB). */
  maxReadBytes?: number;
}

/**
 * Create an R2-backed file storage capability.
 *
 * Provides nine tools:
 * - `file_read` — Read file contents with optional offset/limit
 * - `file_write` — Create or overwrite a file (max 1MB)
 * - `file_edit` — String replacement editing
 * - `file_delete` — Delete a file
 * - `file_copy` — Duplicate a file
 * - `file_move` — Rename/move a file
 * - `file_list` — List directory contents (one level)
 * - `file_tree` — Hierarchical tree view
 * - `file_find` — Search files by glob pattern
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   const storage = agentStorage({
 *     bucket: () => this.env.STORAGE_BUCKET,
 *     namespace: agentId,
 *   });
 *   return [r2Storage({ storage })];
 * }
 * ```
 */
export function r2Storage(options: R2StorageOptions): Capability {
  const getBucket = options.storage.bucket;
  const getPrefix = options.storage.namespace;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;

  return {
    id: "r2-storage",
    name: "R2 File Storage",
    description: "Read, write, edit, copy, move, and search files in R2-backed storage.",
    tools: (_context: AgentContext) => [
      createFileReadTool(getBucket, getPrefix, maxReadBytes),
      createFileWriteTool(getBucket, getPrefix),
      createFileEditTool(getBucket, getPrefix),
      createFileDeleteTool(getBucket, getPrefix),
      createFileCopyTool(getBucket, getPrefix),
      createFileMoveTool(getBucket, getPrefix),
      createFileListTool(getBucket, getPrefix),
      createFileTreeTool(getBucket, getPrefix),
      createFileFindTool(getBucket, getPrefix),
    ],
    promptSections: () => [
      "You have access to file storage. Use file_read to read files, file_write to create/overwrite files, file_edit for targeted string replacements, file_delete to remove files, file_copy to duplicate files, file_move to rename/move files, file_list to list directory contents, file_tree to view directory structure, and file_find to search files by glob pattern. All paths are relative to the storage root.",
    ],
  };
}
