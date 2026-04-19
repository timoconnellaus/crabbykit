/**
 * Normalize a bundle capability's `promptSections` entry into the full
 * {@link PromptSection} shape consumed by the inspection cache.
 *
 * Three input forms accepted (Phase 1 widening of
 * `BundleCapability.promptSections` return type):
 *   - bare `string` → `{ source: { type: "custom" } }`, included
 *   - `BundlePromptSection` (kind: "included" | "excluded") →
 *     `{ source: { type: "capability", capabilityId, capabilityName } }`
 *   - full `PromptSection` → pass through with default-fill for missing
 *     optional fields
 *
 * Anything else (null, missing kind, wrong types) returns `null` so the
 * caller can skip and emit a single warning per turn.
 */

import type { BundlePromptSection } from "../types.js";
import { estimateTextTokens } from "./build-system-prompt.js";
import type { PromptSection } from "./types.js";

function isFullPromptSection(value: object): value is PromptSection {
  const v = value as Record<string, unknown>;
  return typeof v.included === "boolean" && typeof v.content === "string" && "source" in v;
}

function isBundlePromptSection(value: object): value is BundlePromptSection {
  const v = value as Record<string, unknown>;
  return typeof v.kind === "string" && (v.kind === "included" || v.kind === "excluded");
}

function makeKey(capabilityId: string, index: number): string {
  return `cap-${capabilityId}-${index}`;
}

function makeIncludedFromString(text: string, capabilityId: string, index: number): PromptSection {
  return {
    name: `Capability (${capabilityId})`,
    key: makeKey(capabilityId, index),
    content: text,
    lines: text.split("\n").length,
    tokens: estimateTextTokens(text),
    source: { type: "custom" },
    included: true,
  };
}

function makeFromBundleSection(
  entry: BundlePromptSection,
  capabilityId: string,
  capabilityName: string,
  index: number,
): PromptSection {
  const isIncluded = entry.kind === "included";
  const content = typeof entry.content === "string" ? entry.content : "";
  if (!isIncluded) {
    return {
      name: entry.name ?? `Capability (${capabilityName})`,
      key: makeKey(capabilityId, index),
      content: "",
      lines: 0,
      tokens: 0,
      source: { type: "capability", capabilityId, capabilityName },
      included: false,
      excludedReason: typeof entry.reason === "string" ? entry.reason : "Excluded by capability",
    };
  }
  return {
    name: entry.name ?? `Capability (${capabilityName})`,
    key: makeKey(capabilityId, index),
    content,
    lines: content.length === 0 ? 0 : content.split("\n").length,
    tokens: content.length === 0 ? 0 : estimateTextTokens(content),
    source: { type: "capability", capabilityId, capabilityName },
    included: true,
  };
}

function fillFullPromptSection(
  entry: PromptSection,
  capabilityId: string,
  capabilityName: string,
  index: number,
): PromptSection {
  const content = entry.content;
  return {
    name: entry.name ?? `Capability (${capabilityName})`,
    key: entry.key && entry.key.length > 0 ? entry.key : makeKey(capabilityId, index),
    content,
    lines:
      typeof entry.lines === "number"
        ? entry.lines
        : content.length === 0
          ? 0
          : content.split("\n").length,
    tokens:
      typeof entry.tokens === "number"
        ? entry.tokens
        : content.length === 0
          ? 0
          : estimateTextTokens(content),
    source: entry.source,
    included: entry.included,
    excludedReason: entry.excludedReason,
  };
}

export function normalizeBundlePromptSection(
  entry: unknown,
  capabilityId: string,
  capabilityName: string,
  index: number,
): PromptSection | null {
  if (typeof entry === "string") {
    return makeIncludedFromString(entry, capabilityId, index);
  }
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  if (isFullPromptSection(entry)) {
    return fillFullPromptSection(entry, capabilityId, capabilityName, index);
  }
  if (isBundlePromptSection(entry)) {
    return makeFromBundleSection(entry, capabilityId, capabilityName, index);
  }
  return null;
}
