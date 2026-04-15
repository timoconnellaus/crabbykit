import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type {
  AgentContext,
  Capability,
  CapabilityHookContext,
} from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { EmbedFn } from "./embeddings.js";
import { createWorkersAiEmbedder } from "./embeddings.js";
import { indexDocument, removeDocument } from "./indexer.js";
import { createMemoryGetTool } from "./memory-get.js";
import { createMemorySearchTool } from "./memory-search.js";
import { isMemoryPath, toR2Key } from "./paths.js";

const DEFAULT_MAX_SEARCH_RESULTS = 5;
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const CAPABILITY_ID = "vector-memory";

export interface VectorMemoryOptions {
  /** Shared agent storage identity. Provides the R2 bucket and namespace prefix. */
  storage: AgentStorage;

  /** Vectorize index — instance or getter function. */
  vectorizeIndex: VectorizeIndex | (() => VectorizeIndex);

  /**
   * Embedding function. Defaults to Workers AI `@cf/baai/bge-base-en-v1.5`.
   * When using default, the `ai` binding must be provided.
   */
  embed?: EmbedFn;

  /**
   * Workers AI binding. Required when using the default embedder.
   * Ignored when custom `embed` is provided.
   */
  ai?: Ai | (() => Ai);

  /** Maximum search results returned by memory_search (default 5). */
  maxSearchResults?: number;

  /** Maximum bytes returned by memory_get (default 512KB). */
  maxReadBytes?: number;

  /**
   * Determine whether a file path should be indexed as memory.
   * Receives the normalized path (e.g. "MEMORY.md", "memory/notes.md").
   * Defaults to matching `MEMORY.md` (case-insensitive) and `memory/*.md`.
   */
  isMemoryPath?: (path: string) => boolean;
}

/**
 * Create a vector memory capability backed by R2 files and Cloudflare Vectorize.
 *
 * Provides two tools:
 * - `memory_search` — Semantic search across memory files
 * - `memory_get` — Read a specific memory file
 *
 * Automatically indexes memory files (MEMORY.md, memory/*.md) when they are
 * written via r2-storage's `file_write`/`file_edit` tools, using the
 * `afterToolExecution` hook.
 *
 * @example
 * ```ts
 * getCapabilities() {
 *   const storage = agentStorage({
 *     bucket: () => this.env.STORAGE_BUCKET,
 *     namespace: agentId,
 *   });
 *   return [
 *     r2Storage({ storage }),
 *     vectorMemory({
 *       storage,
 *       vectorizeIndex: () => this.env.MEMORY_INDEX,
 *       ai: () => this.env.AI,
 *     }),
 *   ];
 * }
 * ```
 */
export function vectorMemory(options: VectorMemoryOptions): Capability {
  const getBucket = options.storage.bucket;
  const getIndex =
    typeof options.vectorizeIndex === "function"
      ? options.vectorizeIndex
      : () => options.vectorizeIndex as VectorizeIndex;
  const getPrefix = options.storage.namespace;
  const maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const shouldIndex = options.isMemoryPath ?? isMemoryPath;

  // Build embed function
  let embed: EmbedFn;
  if (options.embed) {
    embed = options.embed;
  } else if (options.ai) {
    const getAi = typeof options.ai === "function" ? options.ai : () => options.ai as Ai;
    embed = createWorkersAiEmbedder(getAi);
  } else {
    throw new Error("vectorMemory: provide either 'embed' or 'ai' option");
  }

  return {
    id: CAPABILITY_ID,
    name: "Vector Memory",
    description: "Persistent semantic memory with vector search, backed by R2 files and Vectorize.",
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance — defineTool returns specific TObject but Capability expects TSchema
    tools: (context: AgentContext): AgentTool<any>[] => [
      createMemorySearchTool(getBucket, getIndex, getPrefix, embed, maxSearchResults, context),
      createMemoryGetTool(getBucket, getPrefix, maxReadBytes),
    ],
    promptSections: () => [
      [
        "You have persistent memory across conversations via markdown files.",
        "- Write to MEMORY.md for curated long-term memory (key decisions, preferences, important facts).",
        "- Write to memory/*.md for topic-specific or daily notes (e.g. memory/2026-03-28.md).",
        "- Use file_write/file_edit to create and update memory files — they are automatically indexed for search.",
        "- Use memory_search to find previously saved information by describing what you're looking for.",
        "- Use memory_get to read the full content of a specific memory file.",
      ].join("\n"),
    ],
    hooks: {
      afterToolExecution: async (event, ctx) => {
        if (event.isError) return;

        const args = event.args as { path?: string; content?: string } | undefined;
        if (!args?.path || !shouldIndex(args.path)) return;

        const prefix = getPrefix();

        if (event.toolName === "file_write") {
          if (!args.content) return;
          const result = await indexDocument(
            args.path,
            args.content,
            prefix,
            embed,
            getIndex(),
            ctx.storage,
          );
          if (result.chunksEmbedded > 0) {
            emitIndexingCost(ctx, args.path, result.chunksEmbedded);
          }
        } else if (event.toolName === "file_edit") {
          // file_edit args don't contain full content — fetch from R2
          try {
            const r2Key = toR2Key(prefix, args.path);
            const object = await getBucket().get(r2Key);
            if (object !== null) {
              const content = await object.text();
              const result = await indexDocument(
                args.path,
                content,
                prefix,
                embed,
                getIndex(),
                ctx.storage,
              );
              if (result.chunksEmbedded > 0) {
                emitIndexingCost(ctx, args.path, result.chunksEmbedded);
              }
            }
          } catch (err) {
            console.error(
              `[vector-memory] Failed to re-index after file_edit for ${args.path}:`,
              err,
            );
          }
        } else if (event.toolName === "file_delete") {
          await removeDocument(args.path, prefix, getIndex(), ctx.storage);
        }
      },
    },
  };

  function emitIndexingCost(
    _ctx: CapabilityHookContext,
    path: string,
    chunksEmbedded: number,
  ): void {
    // Cost emission from hooks doesn't have access to AgentContext.emitCost.
    // Indexing costs are tracked at the embedding level (Workers AI billing).
    // Future: extend CapabilityHookContext to support cost emission.
  }
}
