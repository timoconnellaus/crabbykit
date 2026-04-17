/**
 * VectorMemoryService — host-side WorkerEntrypoint that bundles call to
 * search and read their memory files.
 *
 * Bundle-side `vectorMemoryClient` proxies to this service via JSRPC with the
 * unified `__BUNDLE_TOKEN`. The service verifies the token with
 * `requiredScope: "vector-memory"`, embeds queries via the Workers AI
 * binding, queries Vectorize for matches, and reads R2 content directly.
 *
 * Auto-reindexing of `MEMORY.md` / `memory/*.md` on file mutations stays on
 * the static `vectorMemory(...)` capability host-side. The Phase 0 host-hook
 * bridge fires its `afterToolExecution` hook automatically for
 * bundle-originated `file_write` / `file_edit` / `file_delete` events, so
 * bundle agents observe the same indexing behavior as static agents.
 *
 * The HKDF subkey is derived from `AGENT_AUTH_KEY` using the shared
 * `BUNDLE_SUBKEY_LABEL` (`"claw/bundle-v1"`) on first call and cached for
 * the lifetime of the entrypoint instance.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  BUNDLE_SUBKEY_LABEL,
  deriveVerifyOnlySubkey,
  verifyToken,
} from "@claw-for-cloudflare/bundle-token";
import { SCHEMA_CONTENT_HASH } from "./schemas.js";

/** Default maximum matches Vectorize is asked for when `maxResults` is omitted. */
const DEFAULT_MAX_RESULTS = 5;

/** Maximum bytes returned by `get` — matches the static capability's cap. */
const MAX_CONTENT_BYTES = 512 * 1024;

/** Embedding model — must match the static `vectorMemory(...)` factory's default embedder. */
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Maximum chars per snippet returned to the caller. */
const SNIPPET_MAX_CHARS = 700;

export interface VectorMemoryServiceEnv {
  /**
   * Master HMAC secret (string). Used to lazily derive the verify-only
   * subkey on first call via HKDF with label `BUNDLE_SUBKEY_LABEL`.
   */
  AGENT_AUTH_KEY: string;
  /** R2 bucket storing memory files under `{STORAGE_NAMESPACE}/<path>`. */
  STORAGE_BUCKET: R2Bucket;
  /** R2 namespace prefix (typically the agent id). */
  STORAGE_NAMESPACE: string;
  /** Vectorize index holding embedded memory chunks. */
  MEMORY_INDEX: VectorizeIndex;
  /** Workers AI binding used to embed search queries. */
  AI: Ai;
}

/** Truncate a snippet to SNIPPET_MAX_CHARS at a word boundary when possible. */
function truncateSnippet(text: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  const truncated = text.slice(0, SNIPPET_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}…`;
}

/** Extract lines `startLine..endLine` (1-based, inclusive) from text. */
function extractLines(text: string, startLine: number, endLine: number): string {
  const lines = text.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

interface ChunkMetadata {
  path: string;
  startLine: number;
  endLine: number;
}

function isChunkMetadata(value: unknown): value is ChunkMetadata {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    typeof r.startLine === "number" &&
    typeof r.endLine === "number"
  );
}

export interface MemorySearchResult {
  path: string;
  snippet: string;
  score: number;
}

export class VectorMemoryService extends WorkerEntrypoint<VectorMemoryServiceEnv> {
  private subkeyPromise: Promise<CryptoKey> | null = null;

  /**
   * Lazily derive (and cache) the verify-only HKDF subkey from the master
   * `AGENT_AUTH_KEY`. Uses the unified `BUNDLE_SUBKEY_LABEL`.
   */
  private getSubkey(): Promise<CryptoKey> {
    if (!this.subkeyPromise) {
      if (!this.env.AGENT_AUTH_KEY) {
        throw new Error(
          "VectorMemoryService misconfigured: env.AGENT_AUTH_KEY is missing",
        );
      }
      this.subkeyPromise = deriveVerifyOnlySubkey(
        this.env.AGENT_AUTH_KEY,
        BUNDLE_SUBKEY_LABEL,
      );
    }
    return this.subkeyPromise;
  }

  async search(
    token: string,
    args: { query: string; maxResults?: number },
    schemaHash?: string,
  ): Promise<{ results: MemorySearchResult[] }> {
    // Schema drift detection (cheapest check first)
    if (schemaHash && schemaHash !== SCHEMA_CONTENT_HASH) {
      throw new Error("ERR_SCHEMA_VERSION");
    }

    // Verify token — requires "vector-memory" scope in the unified bundle token
    const subkey = await this.getSubkey();
    const verifyResult = await verifyToken(token, subkey, {
      requiredScope: "vector-memory",
    });
    if (!verifyResult.valid) {
      throw new Error(verifyResult.code);
    }

    const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;
    const namespace = this.env.STORAGE_NAMESPACE;

    // Embed the query via Workers AI.
    // biome-ignore lint/suspicious/noExplicitAny: Workers AI model name type is overly strict
    const response = (await (this.env.AI as any).run(EMBEDDING_MODEL, {
      text: [args.query],
    })) as { data: number[][] };
    const vectors = response.data;
    if (!vectors || vectors.length === 0) {
      return { results: [] };
    }
    const queryVector = vectors[0];

    // Query Vectorize.
    const queryResult = await this.env.MEMORY_INDEX.query(queryVector, {
      topK: maxResults,
      namespace,
      returnMetadata: "all",
    });
    const matches = queryResult.matches;
    if (!matches || matches.length === 0) {
      return { results: [] };
    }

    // Deduplicate by path (keep highest score) and sort descending.
    const bestByPath = new Map<string, VectorizeMatch>();
    for (const match of matches) {
      const metadata = match.metadata;
      if (!isChunkMetadata(metadata)) continue;
      const existing = bestByPath.get(metadata.path);
      if (!existing || (match.score ?? 0) > (existing.score ?? 0)) {
        bestByPath.set(metadata.path, match);
      }
    }
    const ordered = Array.from(bestByPath.values()).sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    );

    // Fetch snippets from R2 for each deduplicated match.
    const results: MemorySearchResult[] = [];
    for (const match of ordered.slice(0, maxResults)) {
      const metadata = match.metadata;
      if (!isChunkMetadata(metadata)) continue;
      const { path, startLine, endLine } = metadata;
      const r2Key = `${namespace}/${path}`;

      let snippet = "";
      try {
        const object = await this.env.STORAGE_BUCKET.get(r2Key);
        if (object !== null) {
          const text = await object.text();
          snippet = truncateSnippet(extractLines(text, startLine, endLine));
        }
      } catch {
        // Snippet fetch failures don't break the search — return the
        // match with an empty snippet so the caller still sees the path
        // and score.
      }

      results.push({ path, score: match.score ?? 0, snippet });
    }

    return { results };
  }

  async get(
    token: string,
    args: { path: string },
    schemaHash?: string,
  ): Promise<{ content: string }> {
    if (schemaHash && schemaHash !== SCHEMA_CONTENT_HASH) {
      throw new Error("ERR_SCHEMA_VERSION");
    }

    const subkey = await this.getSubkey();
    const verifyResult = await verifyToken(token, subkey, {
      requiredScope: "vector-memory",
    });
    if (!verifyResult.valid) {
      throw new Error(verifyResult.code);
    }

    const r2Key = `${this.env.STORAGE_NAMESPACE}/${args.path}`;
    const object = await this.env.STORAGE_BUCKET.get(r2Key);
    if (object === null) {
      // Missing file is not an error — return empty content so the
      // caller can decide how to surface it.
      return { content: "" };
    }

    let text = await object.text();

    // Byte-cap truncation — matches the static `memory_get` default.
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > MAX_CONTENT_BYTES) {
      // Decode the first MAX_CONTENT_BYTES bytes and drop any incomplete
      // trailing UTF-8 sequence by trimming at the last newline when
      // possible.
      const truncated = new TextDecoder().decode(encoded.slice(0, MAX_CONTENT_BYTES));
      const lastNewline = truncated.lastIndexOf("\n");
      text = `${lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated}\n\n[Truncated — file exceeds ${MAX_CONTENT_BYTES} bytes]`;
    }

    return { content: text };
  }
}
