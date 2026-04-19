import type { AgentTool } from "@crabbykit/agent-core";
import { estimateTextTokens } from "./build-system-prompt.js";
import type { PromptSection } from "./types.js";

/**
 * Build prompt sections for the tool list and tool guidance.
 *
 * Returns 0-2 sections:
 * 1. "## Tools" — bullet list of every tool with its short description.
 * 2. "## Tool Guidance" — per-tool behavioral instructions (only for tools
 *    whose `guidance` field is set and differs from `description`).
 */
// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
export function buildToolPromptSections(tools: AgentTool<any>[]): PromptSection[] {
  if (tools.length === 0) return [];

  const sections: PromptSection[] = [];

  // --- Tool list ---
  const listLines = [
    "## Tools",
    "",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    "",
    ...tools.map((t) => (t.description ? `- **${t.name}**: ${t.description}` : `- **${t.name}**`)),
  ];
  const listContent = listLines.join("\n");
  sections.push({
    name: "Tools",
    key: "auto-tools",
    content: listContent,
    lines: listLines.length,
    tokens: estimateTextTokens(listContent),
    source: { type: "tools" },
    included: true,
  });

  // --- Tool guidance ---
  const guidanceEntries: string[] = [];
  for (const t of tools) {
    if (t.guidance && t.guidance !== t.description) {
      guidanceEntries.push(`### ${t.name}\n${t.guidance}`);
    }
  }

  if (guidanceEntries.length > 0) {
    const guidanceContent = `## Tool Guidance\n\n${guidanceEntries.join("\n\n")}`;
    sections.push({
      name: "Tool Guidance",
      key: "auto-tool-guidance",
      content: guidanceContent,
      lines: guidanceContent.split("\n").length,
      tokens: estimateTextTokens(guidanceContent),
      source: { type: "tool-guidance" },
      included: true,
    });
  }

  return sections;
}
