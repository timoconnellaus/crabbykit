/**
 * Where a {@link PromptSection} originated. Used by the inspection UI to
 * attribute each section to its source (default block, tool list, capability,
 * etc.) so operators can debug "why is the model seeing X?".
 */
export type PromptSectionSource =
  | { type: "default"; id: "identity" | "safety" | "runtime" }
  | { type: "additional"; index: number }
  | { type: "tools" }
  | { type: "tool-guidance" }
  | { type: "custom" }
  | { type: "capability"; capabilityId: string; capabilityName: string };

/**
 * A named section of the system prompt, used for structured inspection.
 *
 * Sections with `included: false` are surfaced by the inspection path for
 * debugging — they describe a section that was declared (e.g. by a capability
 * or via PromptOptions) but conditionally omitted from the prompt the LLM
 * actually receives. Excluded sections always have `content: ""` and
 * `lines: 0`; their `excludedReason` describes why.
 */
export interface PromptSection {
  /** Display name (e.g. "Identity", "Safety", "Web Search"). */
  name: string;
  /** Stable kebab-case key for styling and UI state (e.g. "identity", "cap-tavily-web-search-1"). */
  key: string;
  /** Section content (markdown string). Empty string when `included` is false. */
  content: string;
  /** Number of lines in content. Zero when `included` is false. */
  lines: number;
  /** Where this section came from. Shown as a "source pill" in the inspection UI. */
  source: PromptSectionSource;
  /** True when this section is part of the final prompt sent to the LLM. */
  included: boolean;
  /** If `included` is false, a human-readable reason for exclusion. */
  excludedReason?: string;
}

/**
 * Options for customizing the default system prompt.
 * Pass to `buildDefaultSystemPrompt()` or return from `getPromptOptions()`.
 */
export interface PromptOptions {
  /** Agent display name (e.g. "Gia"). Used in the identity section and A2A agent card. */
  agentName?: string;
  /** Agent description. Used in A2A agent card. */
  agentDescription?: string;
  /** Agent skills. Used in A2A agent card for discoverability. */
  agentSkills?: Array<{ id: string; name: string; description: string }>;
  /** Custom identity section text. Set to `false` to omit entirely. */
  identity?: string | false;
  /** Custom safety section text. Set to `false` to omit entirely. */
  safety?: string | false;
  /** IANA timezone (e.g. "Australia/Sydney"). Enables local time in the runtime section. */
  timezone?: string;
  /** Custom runtime section text. Set to `false` to omit entirely. */
  runtime?: string | false;
  /** Extra sections appended after the default sections but before capability sections. */
  additionalSections?: string[];
}
