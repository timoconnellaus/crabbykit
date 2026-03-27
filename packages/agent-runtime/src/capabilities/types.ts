import type { AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "../agent-do.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { SessionStore } from "../session/session-store.js";

/**
 * Context provided to capability lifecycle hooks.
 */
export interface CapabilityHookContext {
  sessionId: string;
  sessionStore: SessionStore;
}

/**
 * A capability contributes tools, prompt sections, MCP servers,
 * and/or lifecycle hooks to an agent.
 *
 * Capabilities are registered via `getCapabilities()` on AgentDO.
 * Registration order determines hook execution order.
 */
export interface Capability {
  /** Unique identifier, kebab-case (e.g. "compaction-summary"). */
  id: string;

  /** Human-readable name. */
  name: string;

  /** One-line description. */
  description: string;

  /** Tools contributed by this capability. */
  tools?: (context: AgentContext) => AgentTool[];

  /** Prompt sections to append to the system prompt. */
  promptSections?: (context: AgentContext) => string[];

  /** MCP servers this capability requires. */
  mcpServers?: McpServerConfig[];

  /** Lifecycle hooks. */
  hooks?: {
    /**
     * Called before each LLM inference with the current messages.
     * Returns transformed messages (e.g., compacted).
     * Hooks run in capability registration order; each receives the
     * output of the previous hook.
     */
    beforeInference?: (
      messages: AgentMessage[],
      ctx: CapabilityHookContext,
    ) => Promise<AgentMessage[]>;
  };
}
