import type { AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "../agent-runtime.js";
import type { ResolvedCapabilities } from "../capabilities/resolve.js";
import type { Capability } from "../capabilities/types.js";
import type { AppliedMode, Mode } from "./define-mode.js";
import { excludePromptSectionsForMode } from "./exclude-sections.js";
import { computeDeadCapIds, filterToolsAndSections } from "./filter-tools-and-sections.js";

/**
 * Higher-level wrapper used on the main session path (`ensureAgent`).
 * Computes dead-cap IDs from the full capability list, strips tools
 * contributed by dead caps, delegates the remaining tool/section
 * filtering to {@link filterToolsAndSections}, and resolves
 * `promptAppend` / `systemPromptOverride` function forms.
 *
 * Null-mode pass-through: returns the inputs in an `AppliedMode`
 * wrapper without running any filter.
 */
export function applyMode(
  resolved: ResolvedCapabilities,
  capabilities: Capability[],
  allTools: AnyAgentTool[],
  activeMode: Mode | null,
  context: AgentContext,
): AppliedMode {
  if (!activeMode) {
    return {
      tools: allTools,
      promptSections: resolved.promptSections,
    };
  }

  const capIds = capabilities.map((c) => c.id);
  const deadCapIds = activeMode.capabilities
    ? computeDeadCapIds(capIds, activeMode.capabilities)
    : new Set<string>();

  // Build map of capability -> tool names, so we can strip tools from
  // dead capabilities before the name-based filter runs.
  const deadCapToolNames = new Set<string>();
  if (deadCapIds.size > 0) {
    for (const cap of capabilities) {
      if (!deadCapIds.has(cap.id)) continue;
      if (!cap.tools) continue;
      for (const tool of cap.tools(context)) {
        deadCapToolNames.add(tool.name);
      }
    }
  }

  const toolsAfterCapFilter =
    deadCapToolNames.size === 0 ? allTools : allTools.filter((t) => !deadCapToolNames.has(t.name));

  const { tools: filteredTools, sections: filteredSections } = filterToolsAndSections(
    toolsAfterCapFilter,
    resolved.promptSections,
    activeMode,
  );

  // Auto-exclude capability sections when ALL of a capability's tools were
  // removed by the mode's tool deny/allow list. A capability whose entire
  // tool surface is gone contributes prompt noise the LLM can't act on.
  //
  // Also covers capabilities that contribute tools indirectly via
  // configNamespaces (surfaced as config_set/config_get/config_schema).
  // If those config tools are all gone, the capability's section is noise.
  const survivingToolNames = new Set(filteredTools.map((t) => t.name));
  const implicitDeadCapIds = new Set<string>();
  const configToolsAlive =
    survivingToolNames.has("config_set") ||
    survivingToolNames.has("config_get") ||
    survivingToolNames.has("config_schema");

  for (const cap of capabilities) {
    if (deadCapIds.has(cap.id)) continue; // already dead via capabilities filter

    // Direct tools: if the capability contributed tools and all were filtered out.
    if (cap.tools) {
      const capTools = cap.tools(context);
      if (capTools.length > 0 && !capTools.some((t) => survivingToolNames.has(t.name))) {
        implicitDeadCapIds.add(cap.id);
        continue;
      }
    }

    // Config-namespace-only capabilities: their prompt sections describe how
    // to use config_set/config_get, so they're useless if those tools are gone.
    if (!cap.tools && cap.configNamespaces && !configToolsAlive) {
      implicitDeadCapIds.add(cap.id);
    }
  }

  const finalSections =
    implicitDeadCapIds.size > 0
      ? excludePromptSectionsForMode(filteredSections, implicitDeadCapIds, activeMode.id)
      : filteredSections;

  const promptAppend =
    typeof activeMode.promptAppend === "function"
      ? activeMode.promptAppend(context)
      : activeMode.promptAppend;

  let systemPromptOverride: ((base: string) => string) | undefined;
  if (typeof activeMode.systemPromptOverride === "function") {
    const fn = activeMode.systemPromptOverride;
    systemPromptOverride = (base: string) => fn(base, context);
  } else if (typeof activeMode.systemPromptOverride === "string") {
    const str = activeMode.systemPromptOverride;
    systemPromptOverride = () => str;
  }

  return {
    tools: filteredTools,
    promptSections: finalSections,
    promptAppend,
    systemPromptOverride,
  };
}
