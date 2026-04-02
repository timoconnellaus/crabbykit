import { identitySection, runtimeSection, safetySection } from "./sections.js";
import type { PromptOptions, PromptSection } from "./types.js";

function makeSection(name: string, key: string, content: string): PromptSection {
  return { name, key, content, lines: content.split("\n").length };
}

/**
 * Build the default system prompt as structured sections.
 *
 * Section order: identity, safety, runtime, additionalSections.
 * Capability prompt sections are appended separately by AgentDO.
 */
export function buildDefaultSystemPromptSections(options?: PromptOptions): PromptSection[] {
  const sections: PromptSection[] = [];

  if (options?.identity !== false) {
    sections.push(
      makeSection("Identity", "identity", options?.identity ?? identitySection(options?.agentName)),
    );
  }

  if (options?.safety !== false) {
    sections.push(makeSection("Safety", "safety", options?.safety ?? safetySection()));
  }

  if (options?.runtime !== false) {
    sections.push(
      makeSection(
        "Runtime",
        "runtime",
        options?.runtime ?? runtimeSection({ timezone: options?.timezone }),
      ),
    );
  }

  if (options?.additionalSections) {
    for (const [i, s] of options.additionalSections.entries()) {
      if (s) sections.push(makeSection(`Additional (${i + 1})`, `additional-${i + 1}`, s));
    }
  }

  return sections;
}

/**
 * Build a system prompt from default sections, configured via {@link PromptOptions}.
 *
 * Section order: identity, safety, runtime, additionalSections.
 * Capability prompt sections are appended separately by AgentDO.
 */
export function buildDefaultSystemPrompt(options?: PromptOptions): string {
  return buildDefaultSystemPromptSections(options)
    .map((s) => s.content)
    .join("\n\n");
}
