import { identitySection, runtimeSection, safetySection } from "./sections.js";
import type { PromptOptions, PromptSection, PromptSectionSource } from "./types.js";

function makeSection(
  name: string,
  key: string,
  content: string,
  source: PromptSectionSource,
): PromptSection {
  return {
    name,
    key,
    content,
    lines: content.split("\n").length,
    source,
    included: true,
  };
}

function makeExcluded(
  name: string,
  key: string,
  source: PromptSectionSource,
  excludedReason: string,
): PromptSection {
  return {
    name,
    key,
    content: "",
    lines: 0,
    source,
    included: false,
    excludedReason,
  };
}

/**
 * Concatenate the `included` sections of a prompt section list into the
 * newline-separated string the LLM actually receives. Excluded sections are
 * filtered out, guaranteeing no empty paragraphs or leaked inspection metadata.
 */
export function toPromptString(sections: PromptSection[]): string {
  return sections
    .filter((s) => s.included)
    .map((s) => s.content)
    .join("\n\n");
}

/**
 * Build the default system prompt as structured sections.
 *
 * Section order: identity, safety, runtime, additionalSections.
 * Capability prompt sections are appended separately by the runtime.
 *
 * Default sections are always emitted. When a section is disabled via
 * `PromptOptions` (e.g. `identity: false`), the section is still present in
 * the returned list but marked `included: false` with an `excludedReason` —
 * this lets the inspection UI surface opt-outs instead of silently hiding them.
 */
export function buildDefaultSystemPromptSections(options?: PromptOptions): PromptSection[] {
  const sections: PromptSection[] = [];

  if (options?.identity === false) {
    sections.push(
      makeExcluded(
        "Identity",
        "identity",
        { type: "default", id: "identity" },
        "Disabled via PromptOptions.identity=false",
      ),
    );
  } else {
    sections.push(
      makeSection(
        "Identity",
        "identity",
        options?.identity ?? identitySection(options?.agentName),
        { type: "default", id: "identity" },
      ),
    );
  }

  if (options?.safety === false) {
    sections.push(
      makeExcluded(
        "Safety",
        "safety",
        { type: "default", id: "safety" },
        "Disabled via PromptOptions.safety=false",
      ),
    );
  } else {
    sections.push(
      makeSection("Safety", "safety", options?.safety ?? safetySection(), {
        type: "default",
        id: "safety",
      }),
    );
  }

  if (options?.runtime === false) {
    sections.push(
      makeExcluded(
        "Runtime",
        "runtime",
        { type: "default", id: "runtime" },
        "Disabled via PromptOptions.runtime=false",
      ),
    );
  } else {
    sections.push(
      makeSection(
        "Runtime",
        "runtime",
        options?.runtime ?? runtimeSection({ timezone: options?.timezone }),
        { type: "default", id: "runtime" },
      ),
    );
  }

  if (options?.additionalSections) {
    for (const [i, s] of options.additionalSections.entries()) {
      if (s) {
        sections.push(
          makeSection(`Additional (${i + 1})`, `additional-${i + 1}`, s, {
            type: "additional",
            index: i + 1,
          }),
        );
      }
    }
  }

  return sections;
}

/**
 * Build a system prompt from default sections, configured via {@link PromptOptions}.
 *
 * Section order: identity, safety, runtime, additionalSections.
 * Capability prompt sections are appended separately by the runtime.
 */
export function buildDefaultSystemPrompt(options?: PromptOptions): string {
  return toPromptString(buildDefaultSystemPromptSections(options));
}
