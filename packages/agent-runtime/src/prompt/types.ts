/** A named section of the system prompt, used for structured inspection. */
export interface PromptSection {
  /** Display name (e.g. "Identity", "Safety", "Web Search"). */
  name: string;
  /** Stable kebab-case key for styling (e.g. "identity", "cap-tavily-web-search"). */
  key: string;
  /** Section content (markdown string). */
  content: string;
  /** Number of lines in content. */
  lines: number;
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
