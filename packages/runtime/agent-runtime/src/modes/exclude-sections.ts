import type { PromptSection } from "../prompt/types.js";

/**
 * Module-private helper. Flips capability-sourced prompt sections to
 * `included: false` when their capabilityId appears in the dead-cap set.
 * Non-capability sections and already-excluded sections pass through
 * unchanged.
 *
 * This helper is NOT exported from the `modes/index.ts` barrel — it is
 * an implementation detail of `filterToolsAndSections`. Tests import it
 * directly from this module path.
 */
export function excludePromptSectionsForMode(
  sections: PromptSection[],
  deadCapIds: ReadonlySet<string>,
  modeId: string,
): PromptSection[] {
  if (deadCapIds.size === 0) return sections;
  return sections.map((section) => {
    if (!section.included) return section;
    if (section.source.type !== "capability") return section;
    if (!deadCapIds.has(section.source.capabilityId)) return section;
    return {
      ...section,
      content: "",
      lines: 0,
      tokens: 0,
      included: false,
      excludedReason: `Filtered by mode: ${modeId}`,
    };
  });
}
