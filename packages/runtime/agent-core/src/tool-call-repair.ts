import type { AgentTool } from "./types.js";

/**
 * Compute Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Find the closest tool name by Levenshtein distance.
 * Returns the closest match if distance <= half the name length.
 */
export function findClosestTool(name: string, tools: AgentTool[]): string | null {
  let closest: string | null = null;
  let minDist = Number.POSITIVE_INFINITY;

  for (const tool of tools) {
    const dist = levenshtein(name.toLowerCase(), tool.name.toLowerCase());
    if (dist < minDist) {
      minDist = dist;
      closest = tool.name;
    }
  }

  // Only suggest if distance is reasonable (at most half the name length)
  if (closest && minDist <= Math.ceil(name.length / 2)) {
    return closest;
  }
  return null;
}

/**
 * Attempt to resolve a tool call name that doesn't have an exact match.
 *
 * 1. Try case-insensitive match
 * 2. If no match, return null (caller builds error with closest suggestion)
 */
export function repairToolName(name: string, tools: AgentTool[]): AgentTool | null {
  // Try case-insensitive match
  const ciMatch = tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (ciMatch) return ciMatch;

  return null;
}

/**
 * Build a helpful error message for an unresolved tool call.
 */
export function buildToolNotFoundError(name: string, tools: AgentTool[]): string {
  const available = tools.map((t) => t.name);
  const closest = findClosestTool(name, tools);

  let msg = `Tool '${name}' not found.`;
  if (closest) {
    msg += ` Did you mean '${closest}'?`;
  }
  msg += ` Available tools: ${available.join(", ")}`;
  return msg;
}
