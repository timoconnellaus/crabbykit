import { identitySection, runtimeSection, safetySection } from "./sections.js";
import type { PromptOptions } from "./types.js";

/**
 * Build a system prompt from default sections, configured via {@link PromptOptions}.
 *
 * Section order: identity, safety, runtime, additionalSections.
 * Capability prompt sections are appended separately by AgentDO.
 */
export function buildDefaultSystemPrompt(options?: PromptOptions): string {
  const sections: string[] = [];

  // Identity
  if (options?.identity !== false) {
    sections.push(options?.identity ?? identitySection(options?.agentName));
  }

  // Safety
  if (options?.safety !== false) {
    sections.push(options?.safety ?? safetySection());
  }

  // Runtime
  if (options?.runtime !== false) {
    sections.push(options?.runtime ?? runtimeSection({ timezone: options?.timezone }));
  }

  // Additional custom sections
  if (options?.additionalSections) {
    for (const s of options.additionalSections) {
      if (s) sections.push(s);
    }
  }

  return sections.join("\n\n");
}
