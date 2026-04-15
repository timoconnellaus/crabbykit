import type { AnyAgentTool } from "@claw-for-cloudflare/agent-core";
import type { PromptSection } from "../prompt/types.js";
import type { Mode } from "./define-mode.js";
import { excludePromptSectionsForMode } from "./exclude-sections.js";

/**
 * Low-level pure filter over `(tools, sections, activeMode)`. When
 * `activeMode` is null, returns the inputs unchanged (pass-through).
 *
 * - Applies `mode.tools.allow` / `mode.tools.deny` to `tools`.
 * - Flips capability-sourced sections to `included: false` when their
 *   capabilityId is excluded by `mode.capabilities` allow/deny.
 *
 * This function is called directly by `packages/subagent`, which does
 * not have a `ResolvedCapabilities` object at its call site. Main
 * sessions go through `applyMode` which wraps this and adds
 * capability-level bookkeeping.
 */
export function filterToolsAndSections(
  tools: AnyAgentTool[],
  sections: PromptSection[],
  activeMode: Mode | null,
): { tools: AnyAgentTool[]; sections: PromptSection[] } {
  if (!activeMode) {
    return { tools, sections };
  }

  const filteredTools = filterTools(tools, activeMode);
  const deadCapIds = computeDeadCapIdsFromSections(sections, activeMode);
  const filteredSections = excludePromptSectionsForMode(sections, deadCapIds, activeMode.id);

  return { tools: filteredTools, sections: filteredSections };
}

function filterTools(tools: AnyAgentTool[], mode: Mode): AnyAgentTool[] {
  const filter = mode.tools;
  if (!filter) return tools;
  if (filter.allow && filter.allow.length > 0) {
    const allow = new Set(filter.allow);
    return tools.filter((t) => allow.has(t.name));
  }
  if (filter.deny && filter.deny.length > 0) {
    const deny = new Set(filter.deny);
    return tools.filter((t) => !deny.has(t.name));
  }
  return tools;
}

function computeDeadCapIdsFromSections(sections: PromptSection[], mode: Mode): ReadonlySet<string> {
  const filter = mode.capabilities;
  if (!filter) return new Set();
  const capabilityIds = new Set<string>();
  for (const section of sections) {
    if (section.source.type === "capability") {
      capabilityIds.add(section.source.capabilityId);
    }
  }
  return computeDeadCapIds(capabilityIds, filter);
}

/**
 * Shared helper used by both `filterToolsAndSections` (which only sees
 * sections) and `applyMode` (which sees the full capability list).
 */
export function computeDeadCapIds(
  knownCapabilityIds: Iterable<string>,
  filter: { allow?: string[]; deny?: string[] },
): Set<string> {
  const dead = new Set<string>();
  if (filter.allow && filter.allow.length > 0) {
    const allow = new Set(filter.allow);
    for (const id of knownCapabilityIds) {
      if (!allow.has(id)) dead.add(id);
    }
    return dead;
  }
  if (filter.deny && filter.deny.length > 0) {
    for (const id of filter.deny) dead.add(id);
    return dead;
  }
  return dead;
}
