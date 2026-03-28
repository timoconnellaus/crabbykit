import type { EmbedFn } from "./embeddings.js";
import { toR2Key } from "./paths.js";

const SNIPPET_MAX_CHARS = 700;
const KEYWORD_CONTEXT_LINES = 5;

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score?: number;
  snippet: string;
}

/**
 * Extract lines startLine..endLine (1-based, inclusive) from text.
 * Returns the joined lines, or the whole text if out of range.
 */
function extractLines(text: string, startLine: number, endLine: number): string {
  const lines = text.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

/**
 * Truncate a snippet to SNIPPET_MAX_CHARS, breaking at a word boundary when possible.
 */
function truncateSnippet(text: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  const truncated = text.slice(0, SNIPPET_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}…`;
}

/**
 * Perform vector search via Vectorize, then fetch snippets from R2.
 * Returns null if embedding fails or Vectorize throws.
 */
export async function vectorSearch(
  query: string,
  maxResults: number,
  prefix: string,
  embed: EmbedFn,
  vectorizeIndex: VectorizeIndex,
  getBucket: () => R2Bucket,
): Promise<SearchResult[] | null> {
  // Embed query
  const vectors = await embed([query]);
  if (vectors.length === 0) return null;
  const queryVector = vectors[0];

  // Query Vectorize
  let matches: VectorizeMatch[];
  try {
    const result = await vectorizeIndex.query(queryVector, {
      topK: Math.min(maxResults * 3, 20),
      namespace: prefix,
      returnMetadata: "all",
    });
    matches = result.matches;
  } catch (err) {
    console.error("[vector-memory/searcher] Vectorize query failed:", err);
    return null;
  }

  if (matches.length === 0) return [];

  // Deduplicate by path (keep highest score)
  const bestByPath = new Map<string, VectorizeMatch>();
  for (const match of matches) {
    const metadata = match.metadata as
      | { path: string; startLine: number; endLine: number }
      | undefined;
    if (!metadata?.path) continue;

    const existing = bestByPath.get(metadata.path);
    if (!existing || (match.score ?? 0) > (existing.score ?? 0)) {
      bestByPath.set(metadata.path, match);
    }
  }

  // Build results with snippets
  const results: SearchResult[] = [];
  const bucket = getBucket();

  for (const match of matches) {
    if (results.length >= maxResults) break;

    const metadata = match.metadata as
      | { path: string; startLine: number; endLine: number }
      | undefined;
    if (!metadata?.path) continue;

    const { path, startLine, endLine } = metadata;
    const r2Key = toR2Key(prefix, path);

    let snippet = "";
    try {
      const object = await bucket.get(r2Key);
      if (object !== null) {
        const text = await object.text();
        snippet = truncateSnippet(extractLines(text, startLine, endLine));
      }
    } catch (err) {
      console.error(`[vector-memory/searcher] Failed to fetch snippet for ${r2Key}:`, err);
    }

    results.push({
      path,
      startLine,
      endLine,
      score: match.score,
      snippet,
    });
  }

  return results;
}

/**
 * List memory R2 keys for an agent.
 * Checks both MEMORY.md and memory/*.
 */
async function listMemoryKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];

  // Check top-level MEMORY.md
  const topLevelKey = `${prefix}/MEMORY.md`;
  try {
    const head = await bucket.head(topLevelKey);
    if (head !== null) keys.push(topLevelKey);
  } catch {
    // not found
  }

  // List memory/ directory
  try {
    const listed = await bucket.list({ prefix: `${prefix}/memory/` });
    for (const obj of listed.objects) {
      if (obj.key.endsWith(".md")) {
        keys.push(obj.key);
      }
    }
  } catch (err) {
    console.error("[vector-memory/searcher] Failed to list memory/ objects:", err);
  }

  return keys;
}

/**
 * Keyword fallback search: case-insensitive substring match with context window.
 */
export async function keywordSearch(
  query: string,
  maxResults: number,
  prefix: string,
  getBucket: () => R2Bucket,
): Promise<SearchResult[]> {
  const lowerQuery = query.toLowerCase();
  const bucket = getBucket();
  const keys = await listMemoryKeys(bucket, prefix);
  const results: SearchResult[] = [];

  for (const r2Key of keys) {
    if (results.length >= maxResults) break;

    let text: string;
    try {
      const object = await bucket.get(r2Key);
      if (object === null) continue;
      text = await object.text();
    } catch (err) {
      console.error(`[vector-memory/searcher] Failed to read ${r2Key}:`, err);
      continue;
    }

    const lines = text.split("\n");
    const lowerLines = lines.map((l) => l.toLowerCase());
    const visitedRanges: Array<[number, number]> = [];

    // Strip the prefix to get the relative path
    const path = r2Key.slice(prefix.length + 1);

    for (let i = 0; i < lowerLines.length; i++) {
      if (!lowerLines[i].includes(lowerQuery)) continue;

      const ctxStart = Math.max(0, i - KEYWORD_CONTEXT_LINES);
      const ctxEnd = Math.min(lines.length - 1, i + KEYWORD_CONTEXT_LINES);

      // Avoid overlapping results from the same file
      const overlaps = visitedRanges.some(([s, e]) => ctxStart <= e && ctxEnd >= s);
      if (overlaps) continue;

      visitedRanges.push([ctxStart, ctxEnd]);

      const snippetLines = lines.slice(ctxStart, ctxEnd + 1);
      const snippet = truncateSnippet(snippetLines.join("\n"));

      results.push({
        path,
        startLine: ctxStart + 1,
        endLine: ctxEnd + 1,
        snippet,
      });

      if (results.length >= maxResults) break;
    }
  }

  return results;
}

/**
 * Format search results for display to the agent.
 */
export function formatResults(results: SearchResult[], notice?: string): string {
  if (results.length === 0) {
    return `${notice ?? ""}No memory content found matching your query.`;
  }

  const formatted = results
    .map((r, idx) => {
      const location = `${r.path}:${r.startLine}-${r.endLine}`;
      const scoreStr = r.score !== undefined ? ` (score: ${r.score.toFixed(3)})` : "";
      return `[${idx + 1}] ${location}${scoreStr}\n${r.snippet}`;
    })
    .join("\n\n---\n\n");

  return (notice ?? "") + formatted;
}
