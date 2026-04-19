import type { Mode } from "@crabbykit/subagent";

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
   * Explicit tool allow list. When provided, only tools whose names
   * appear in this array are exposed to the explorer subagent. When
   * omitted, the mode inherits the parent's full tool surface — use
   * {@link filterReadOnlyTools} at the registration site if you want
   * to constrain to read-only tools by name pattern.
   */
  tools?: string[];
}

/**
 * Create an explorer subagent {@link Mode}.
 *
 * The explorer is a read-only codebase search agent optimized for
 * finding information quickly. Uses a fast model by default.
 *
 * @example
 * ```ts
 * import { defineAgent } from "@crabbykit/agent-runtime";
 * import { explorer } from "@crabbykit/subagent-explorer";
 *
 * defineAgent({
 *   subagentModes: () => [explorer({ model: "google/gemini-2.5-flash" })],
 *   // ...
 * });
 * ```
 */
export function explorer(options?: ExplorerOptions): Mode {
  return {
    id: "explorer",
    name: "Explorer",
    description: "Fast, read-only codebase search agent",
    systemPromptOverride: (base: string) => EXPLORER_SYSTEM_PROMPT(base),
    tools: options?.tools ? { allow: options.tools } : undefined,
    model: options?.model,
  };
}

/**
 * Default read-only tool filter. Returns true if the tool name
 * contains any of the default read-only patterns.
 *
 * Used at mode registration time to constrain explorer's tool surface
 * to read-only operations based on the parent agent's actual tool set.
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
