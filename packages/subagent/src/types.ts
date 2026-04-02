import type { AgentTool } from "@claw-for-cloudflare/agent-core";

/**
 * A subagent profile defines the configuration for a child agent.
 * Profiles control the system prompt, available tools, and model.
 */
export interface SubagentProfile {
  /** Unique identifier for this profile. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** One-line description of what this subagent does. */
  description: string;
  /**
   * System prompt for the subagent. Can be a string or a function
   * that receives the parent's base system prompt for context.
   */
  systemPrompt: string | ((parentPrompt: string) => string);
  /**
   * Tool name allowlist. Only tools with matching names are available.
   * If null/undefined, the subagent inherits all parent tools.
   */
  tools?: string[];
  /**
   * OpenRouter model ID override (e.g., "google/gemini-2.5-flash").
   * If not set, inherits the parent's model.
   */
  model?: string;
}

/** State of a running subagent. */
export type SubagentState = "running" | "completed" | "failed" | "canceled";

/** Record of an in-flight subagent (stored in CapabilityStorage). */
export interface PendingSubagent {
  subagentId: string;
  profileId: string;
  childSessionId: string;
  parentSessionId: string;
  prompt: string;
  state: SubagentState;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Resolved configuration for creating a subagent Agent instance. */
export interface ResolvedProfile {
  profile: SubagentProfile;
  systemPrompt: string;
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
  tools: AgentTool<any>[];
  modelId: string | undefined;
}
