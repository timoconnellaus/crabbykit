import type { AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type { AgentContext } from "../agent-do.js";
import type { Command } from "../commands/define-command.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { ScheduleConfig } from "../scheduling/types.js";
import type { SessionStore } from "../session/session-store.js";
import type { CapabilityStorage } from "./storage.js";

/**
 * Context provided to capability lifecycle hooks.
 */
export interface CapabilityHookContext {
  sessionId: string;
  sessionStore: SessionStore;
  /** Persistent key-value storage scoped to this capability. */
  storage: CapabilityStorage;
}

/**
 * Event passed to `afterToolExecution` hooks after a tool finishes.
 */
export interface ToolExecutionEvent {
  /** Name of the tool that was executed. */
  toolName: string;
  /** Validated arguments the tool was called with. */
  args: unknown;
  /** Whether the tool execution was treated as an error. */
  isError: boolean;
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

  /** Slash commands contributed by this capability. */
  commands?: (context: AgentContext) => Command[];

  /** Prompt sections to append to the system prompt. */
  promptSections?: (context: AgentContext) => string[];

  /** MCP servers this capability requires. */
  mcpServers?: McpServerConfig[];

  /** Schedules this capability declares. Registered during agent initialization. */
  schedules?: (context: AgentContext) => ScheduleConfig[];

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

    /**
     * Called after a tool finishes executing.
     * Observation-only — the return value is ignored.
     * Hooks run in capability registration order. Errors are caught
     * per-hook so one failing hook does not block others.
     */
    afterToolExecution?: (event: ToolExecutionEvent, ctx: CapabilityHookContext) => Promise<void>;
  };
}
