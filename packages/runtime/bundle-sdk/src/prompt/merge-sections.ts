/**
 * Merge capability-contributed prompt sections with a bundle's
 * `setup.prompt` to produce the final system-prompt string.
 *
 * Mirrors the static `defineAgent` rule: when `setup.prompt` is a
 * string, that string is the verbatim system prompt and capability
 * sections are NOT appended (Decision 5 in bundle-runtime-surface).
 * When `setup.prompt` is `PromptOptions` (or undefined), the default
 * builder runs and capability sections splice in after the default
 * sections.
 *
 * Phase 0a accepts the existing `Array<string | BundlePromptSection>`
 * shape from `BundleCapability.promptSections`. Phase 1 widens the
 * input type to also accept full `PromptSection` entries; the rule
 * encoded here is unchanged.
 */

import type { BundlePromptSection } from "../types.js";
import { buildDefaultSystemPrompt } from "./build-system-prompt.js";
import type { PromptOptions, PromptSection } from "./types.js";

export type CapabilityPromptEntry = string | BundlePromptSection | PromptSection;

function isFullPromptSection(entry: object): entry is PromptSection {
  const e = entry as Record<string, unknown>;
  return typeof e.included === "boolean" && typeof e.content === "string" && "source" in e;
}

function extractIncludedContent(entry: CapabilityPromptEntry): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return null;
  if (isFullPromptSection(entry)) {
    return entry.included ? entry.content : null;
  }
  const bundleSection = entry as BundlePromptSection;
  if (bundleSection.kind === "included" && typeof bundleSection.content === "string") {
    return bundleSection.content;
  }
  return null;
}

export function mergeSections(
  promptOption: string | PromptOptions | undefined,
  capabilitySections: CapabilityPromptEntry[],
): string {
  if (typeof promptOption === "string") {
    return promptOption;
  }
  const base = buildDefaultSystemPrompt(promptOption);
  if (capabilitySections.length === 0) return base;
  const capStrings: string[] = [];
  for (const entry of capabilitySections) {
    const content = extractIncludedContent(entry);
    if (content && content.length > 0) capStrings.push(content);
  }
  if (capStrings.length === 0) return base;
  if (base.length === 0) return capStrings.join("\n\n");
  return [base, ...capStrings].join("\n\n");
}
