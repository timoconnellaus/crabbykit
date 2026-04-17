/**
 * Shared tool schemas for file-tools.
 *
 * Used by both the static capability (capability.ts / file-*.ts) and the
 * capability service (service.ts/client.ts) to ensure schema consistency
 * across the bundle boundary. The per-tool schemas here match the inline
 * schemas in each `src/file-*.ts` static tool definition — bundles call the
 * same surface the static brain does.
 */

import { Type } from "@sinclair/typebox";

// --- Tool name + description constants ---

export const FILE_READ_TOOL_NAME = "file_read";
export const FILE_READ_TOOL_DESCRIPTION =
  "Read file contents from storage. Supports optional line-based offset and limit for partial reads. Large files are automatically truncated.";

export const FILE_WRITE_TOOL_NAME = "file_write";
export const FILE_WRITE_TOOL_DESCRIPTION =
  "Create or overwrite a file in storage. Parent directories are created automatically. Maximum content size is 1MB.";

export const FILE_EDIT_TOOL_NAME = "file_edit";
export const FILE_EDIT_TOOL_DESCRIPTION =
  "Edit a file by replacing a specific string. The old_string must match exactly including whitespace and indentation. By default replaces only the first occurrence; use replace_all for all occurrences.";

export const FILE_DELETE_TOOL_NAME = "file_delete";
export const FILE_DELETE_TOOL_DESCRIPTION =
  "Delete a file from storage. Idempotent — no error if the file does not exist.";

export const FILE_COPY_TOOL_NAME = "file_copy";
export const FILE_COPY_TOOL_DESCRIPTION =
  "Copy a file to a new path. Overwrites the destination if it exists.";

export const FILE_MOVE_TOOL_NAME = "file_move";
export const FILE_MOVE_TOOL_DESCRIPTION =
  "Move (rename) a file to a new path. Overwrites the destination if it exists. The source file is deleted after a successful copy.";

export const FILE_LIST_TOOL_NAME = "file_list";
export const FILE_LIST_TOOL_DESCRIPTION =
  "List directory contents (one level deep). Returns files and subdirectories at the given path.";

export const FILE_TREE_TOOL_NAME = "file_tree";
export const FILE_TREE_TOOL_DESCRIPTION =
  "View storage structure as a hierarchical tree. Configurable depth (default 3, max 5).";

export const FILE_FIND_TOOL_NAME = "file_find";
export const FILE_FIND_TOOL_DESCRIPTION =
  "Search for files by glob pattern. Supports * (within directory), ** (across directories), and ? (single char).";

// --- Per-tool args schemas ---

export const FileReadArgsSchema = Type.Object({
  path: Type.String({ description: "Path to the file, relative to the storage root" }),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Line number to start reading from (0-based)",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum number of lines to read",
    }),
  ),
});

export const FileWriteArgsSchema = Type.Object({
  path: Type.String({ description: "Path to the file, relative to the storage root" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export const FileEditArgsSchema = Type.Object({
  path: Type.String({ description: "Path to the file, relative to the storage root" }),
  old_string: Type.String({ description: "The exact string to find and replace" }),
  new_string: Type.String({ description: "The string to replace it with" }),
  replace_all: Type.Optional(
    Type.Boolean({
      description: "Replace all occurrences instead of just the first (default: false)",
    }),
  ),
});

export const FileDeleteArgsSchema = Type.Object({
  path: Type.String({ description: "Path to the file, relative to the storage root" }),
});

export const FileCopyArgsSchema = Type.Object({
  source: Type.String({ description: "Source file path, relative to the storage root" }),
  destination: Type.String({
    description: "Destination file path, relative to the storage root",
  }),
});

export const FileMoveArgsSchema = Type.Object({
  source: Type.String({ description: "Source file path, relative to the storage root" }),
  destination: Type.String({
    description: "Destination file path, relative to the storage root",
  }),
});

export const FileListArgsSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Directory path relative to storage root. Omit or leave empty for root.",
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: "Pagination cursor from a previous file_list call" }),
  ),
});

export const FileTreeArgsSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Directory path relative to storage root. Omit or leave empty for root.",
    }),
  ),
  depth: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Maximum depth to traverse (default 3, max 5)",
    }),
  ),
});

export const FileFindArgsSchema = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern to match against file paths. Examples: **/*.ts, src/**/index.ts, *.json",
  }),
  path: Type.Optional(
    Type.String({
      description: "Optional directory path to scope the search. Defaults to storage root.",
    }),
  ),
});

// --- Schema content hash for drift detection ---

/**
 * Content hash of the schemas. Both service and client compare this at RPC
 * time to detect cross-version drift. Defensive consistency check, not a
 * security boundary. Bumped by hand when any of the args schemas change in
 * a way that would silently mistype older bundles against a newer host.
 */
export const SCHEMA_CONTENT_HASH = "file-tools-schemas-v1";
