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

// Re-export from r2-storage to avoid duplicate definition.
export { toR2Key } from "@claw-for-cloudflare/r2-storage";
