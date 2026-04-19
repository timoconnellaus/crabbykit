import type { AgentTool } from "@crabbykit/agent-core";
import { filterToolsAndSections } from "@crabbykit/agent-runtime/modes";
import type { Mode, ResolvedSubagentSpawn } from "./types.js";

/**
 * Resolve a {@link Mode} into a concrete spawn configuration for a
 * child subagent.
 *
 * - Resolves `systemPromptOverride` (string, function, or undefined)
 *   into a final system prompt string. Function form receives the
 *   parent's system prompt as the `base` parameter and the parent's
 *   {@link import("@crabbykit/agent-runtime").AgentContext}
 *   as the second parameter (per design D11 / spec). When absent,
 *   the parent's base prompt is used unchanged.
 * - Filters the parent's tool list via the shared
 *   {@link filterToolsAndSections} helper — `Mode.tools.allow` /
 *   `Mode.tools.deny` are applied. Passing an empty section list to
 *   the helper is fine; subagents have no prompt-section plumbing.
 * - Passes through `mode.model` as `modelId` (applied to the child
 *   agent by the subagent host).
 */
export function resolveSubagentSpawn(
  mode: Mode,
  parentSystemPrompt: string,
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
  parentTools: AgentTool<any>[],
  // biome-ignore lint/suspicious/noExplicitAny: parent AgentContext shape is intentionally untyped here — the subagent package is one level above agent-runtime and doesn't import AgentContext. systemPromptOverride functions that need it read it positionally.
  parentContext?: any,
): ResolvedSubagentSpawn {
  let systemPrompt = parentSystemPrompt;
  if (typeof mode.systemPromptOverride === "function") {
    systemPrompt = mode.systemPromptOverride(parentSystemPrompt, parentContext);
  } else if (typeof mode.systemPromptOverride === "string") {
    systemPrompt = mode.systemPromptOverride;
  }

  const { tools } = filterToolsAndSections(parentTools, [], mode);

  return {
    mode,
    systemPrompt,
    tools,
    modelId: mode.model,
  };
}
