import type { SubagentProfile } from "@claw-for-cloudflare/subagent";

/** Default read-only tool name patterns. */
const DEFAULT_READ_ONLY_PATTERNS = [
  "read",
  "search",
  "list",
  "get",
  "find",
  "grep",
  "glob",
  "tree",
  "show",
  "check",
  "status",
];

const EXPLORER_SYSTEM_PROMPT = (parentPrompt: string) =>
  `You are an explorer subagent. Your job is to quickly find information in the codebase and report back concisely.

RULES:
- You have READ-ONLY access. Do NOT attempt to modify any files.
- Focus on finding the specific information requested.
- Be concise — report findings in a structured format.
- If you can't find what you're looking for, say so clearly.

CONTEXT FROM PARENT AGENT:
${parentPrompt}`;

export interface ExplorerOptions {
  /** Override the default model. E.g., "google/gemini-2.5-flash" for speed. */
  model?: string;
  /**
   * Override the tool allowlist. By default, tools are filtered to
   * read-only operations using name pattern matching.
   */
  tools?: string[];
}

/**
 * Create an explorer subagent profile.
 *
 * The explorer is a read-only codebase search agent optimized for
 * finding information quickly. Uses a fast model by default.
 *
 * @example
 * ```ts
 * getSubagentProfiles() {
 *   return [
 *     explorer({ model: "google/gemini-2.5-flash" }),
 *   ];
 * }
 * ```
 */
export function explorer(options?: ExplorerOptions): SubagentProfile {
  return {
    id: "explorer",
    name: "Explorer",
    description: "Fast, read-only codebase search agent",
    systemPrompt: EXPLORER_SYSTEM_PROMPT,
    tools: options?.tools,
    model: options?.model,
  };
}

/**
 * Default read-only tool filter. Returns true if the tool name
 * contains any of the default read-only patterns.
 *
 * Used by the subagent capability when the explorer profile
 * doesn't specify an explicit tools list.
 */
export function isReadOnlyTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return DEFAULT_READ_ONLY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Filter a list of tool names to only read-only tools.
 */
export function filterReadOnlyTools(toolNames: string[]): string[] {
  return toolNames.filter(isReadOnlyTool);
}
