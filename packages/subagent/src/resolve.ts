import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type { ResolvedProfile, SubagentProfile } from "./types.js";

/**
 * Resolve a subagent profile against parent context.
 *
 * - Resolves systemPrompt (string or function)
 * - Filters parent tools by allowlist (if specified)
 * - Passes through model override
 */
export function resolveProfile(
  profile: SubagentProfile,
  parentSystemPrompt: string,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
  parentTools: AgentTool<any>[],
): ResolvedProfile {
  // Resolve system prompt
  const systemPrompt =
    typeof profile.systemPrompt === "function"
      ? profile.systemPrompt(parentSystemPrompt)
      : profile.systemPrompt;

  // Filter tools by allowlist
  const tools = profile.tools
    ? parentTools.filter((t) => profile.tools!.includes(t.name))
    : parentTools;

  return {
    profile,
    systemPrompt,
    tools,
    modelId: profile.model,
  };
}
