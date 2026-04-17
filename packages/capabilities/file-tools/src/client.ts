/**
 * Bundle-side file-tools capability — thin RPC proxy to FileToolsService.
 *
 * Reads the unified per-turn capability token from `env.__BUNDLE_TOKEN`
 * whose `scope` array includes `"file-tools"`. FileToolsService verifies the
 * token with `requiredScope: "file-tools"`. No credentials held here, no
 * business logic beyond RPC marshaling.
 *
 * This client registers nine tools (`file_read`, `file_write`, `file_edit`,
 * `file_delete`, `file_copy`, `file_move`, `file_list`, `file_tree`,
 * `file_find`) and NOTHING else. No `hooks`, no `httpHandlers`, no
 * `configNamespaces`, no `onAction`, no `promptSections` — the static
 * `fileTools(...)` capability's `afterToolExecution` mutation-broadcast hook
 * and `onAction` UI dispatcher stay on the host side and fire against
 * bundle-originated file mutations via the Phase 0 host-hook bridge.
 */

import type { Capability } from "@claw-for-cloudflare/agent-runtime";
import { defineTool } from "@claw-for-cloudflare/agent-runtime";
import {
  FILE_COPY_TOOL_DESCRIPTION,
  FILE_COPY_TOOL_NAME,
  FILE_DELETE_TOOL_DESCRIPTION,
  FILE_DELETE_TOOL_NAME,
  FILE_EDIT_TOOL_DESCRIPTION,
  FILE_EDIT_TOOL_NAME,
  FILE_FIND_TOOL_DESCRIPTION,
  FILE_FIND_TOOL_NAME,
  FILE_LIST_TOOL_DESCRIPTION,
  FILE_LIST_TOOL_NAME,
  FILE_MOVE_TOOL_DESCRIPTION,
  FILE_MOVE_TOOL_NAME,
  FILE_READ_TOOL_DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_TREE_TOOL_DESCRIPTION,
  FILE_TREE_TOOL_NAME,
  FILE_WRITE_TOOL_DESCRIPTION,
  FILE_WRITE_TOOL_NAME,
  FileCopyArgsSchema,
  FileDeleteArgsSchema,
  FileEditArgsSchema,
  FileFindArgsSchema,
  FileListArgsSchema,
  FileMoveArgsSchema,
  FileReadArgsSchema,
  FileTreeArgsSchema,
  FileWriteArgsSchema,
  SCHEMA_CONTENT_HASH,
} from "./schemas.js";
import type { FileToolResult, FileToolsService } from "./service.js";

export interface FileToolsClientOptions {
  service: Service<FileToolsService>;
}

/** Render a FileToolResult as the tool-call text output the LLM consumes. */
function renderResult<D>(result: FileToolResult<D>): {
  content: Array<{ type: "text"; text: string }>;
  details: D;
} {
  return {
    content: [{ type: "text" as const, text: result.text }],
    details: result.details,
  };
}

/**
 * Create a bundle-side file-tools capability that proxies each `file_*` tool
 * to FileToolsService.
 */
export function fileToolsClient(options: FileToolsClientOptions): Capability {
  return {
    id: "file-tools",
    name: "File Tools (Bundle Client)",
    description:
      "Read, write, edit, copy, move, and search files in R2-backed storage (proxied through service binding).",

    tools: (context) => {
      const env = (context as unknown as { env: { __BUNDLE_TOKEN?: string } }).env;
      const requireToken = (): string => {
        const token = env?.__BUNDLE_TOKEN;
        if (!token) throw new Error("Missing __BUNDLE_TOKEN");
        return token;
      };

      return [
        defineTool({
          name: FILE_READ_TOOL_NAME,
          description: FILE_READ_TOOL_DESCRIPTION,
          parameters: FileReadArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.read(
              token,
              { path: args.path, offset: args.offset, limit: args.limit },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_WRITE_TOOL_NAME,
          description: FILE_WRITE_TOOL_DESCRIPTION,
          parameters: FileWriteArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.write(
              token,
              { path: args.path, content: args.content },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_EDIT_TOOL_NAME,
          description: FILE_EDIT_TOOL_DESCRIPTION,
          parameters: FileEditArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.edit(
              token,
              {
                path: args.path,
                old_string: args.old_string,
                new_string: args.new_string,
                replace_all: args.replace_all,
              },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_DELETE_TOOL_NAME,
          description: FILE_DELETE_TOOL_DESCRIPTION,
          parameters: FileDeleteArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.delete(
              token,
              { path: args.path },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_COPY_TOOL_NAME,
          description: FILE_COPY_TOOL_DESCRIPTION,
          parameters: FileCopyArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.copy(
              token,
              { source: args.source, destination: args.destination },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_MOVE_TOOL_NAME,
          description: FILE_MOVE_TOOL_DESCRIPTION,
          parameters: FileMoveArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.move(
              token,
              { source: args.source, destination: args.destination },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_LIST_TOOL_NAME,
          description: FILE_LIST_TOOL_DESCRIPTION,
          parameters: FileListArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.list(
              token,
              { path: args.path, cursor: args.cursor },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_TREE_TOOL_NAME,
          description: FILE_TREE_TOOL_DESCRIPTION,
          parameters: FileTreeArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.tree(
              token,
              { path: args.path, depth: args.depth },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
        defineTool({
          name: FILE_FIND_TOOL_NAME,
          description: FILE_FIND_TOOL_DESCRIPTION,
          parameters: FileFindArgsSchema,
          execute: async (args) => {
            const token = requireToken();
            const result = await options.service.find(
              token,
              { pattern: args.pattern, path: args.path },
              SCHEMA_CONTENT_HASH,
            );
            return renderResult(result);
          },
        }),
      ];
    },
  };
}
