/**
 * Returns true if the given normalized path is a memory file that should
 * be indexed in Vectorize.
 *
 * Matches:
 * - `MEMORY.md` / `memory.md` (case-insensitive top-level)
 * - `memory/<anything>.md`
 */
export function isMemoryPath(path: string): boolean {
  if (path.toLowerCase() === "memory.md") return true;
  if (path.startsWith("memory/") && path.endsWith(".md")) return true;
  return false;
}

/**
 * Resolves a validated normalized path to an R2 key.
 * Prepends the configured prefix to isolate storage per-agent.
 */
export function toR2Key(prefix: string, path: string): string {
  return `${prefix}/${path}`;
}
