import type { AgentMessage, AgentTool } from "@claw-for-cloudflare/agent-core";
import type { TObject } from "@sinclair/typebox";
import type { AgentContext } from "../agent-do.js";
import type { Command } from "../commands/define-command.js";
import type { ConfigNamespace } from "../config/config-namespace.js";
import type { CostEvent } from "../costs/types.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { ScheduleConfig } from "../scheduling/types.js";
import type { SessionStore } from "../session/session-store.js";
import type { CapabilityStorage } from "./storage.js";

/**
 * Context provided to capability lifecycle hooks.
 */
export interface CapabilityHookContext {
  /** The Durable Object ID of the agent (hex string). */
  agentId: string;
  sessionId: string;
  sessionStore: SessionStore;
  /** Persistent key-value storage scoped to this capability. */
  storage: CapabilityStorage;
  /** Broadcast a custom event to the current session's clients. Only available in onConnect. */
  broadcast?: (name: string, data: Record<string, unknown>) => void;
  /** Emit a cost event. Persisted to session and broadcast to clients. */
  emitCost?: (cost: CostEvent) => void;
}

/**
 * Event passed to `beforeToolExecution` hooks before a tool runs.
 */
export interface BeforeToolExecutionEvent {
  /** Name of the tool about to be executed. */
  toolName: string;
  /** Validated arguments the tool will be called with. */
  args: unknown;
  /** The tool call ID from the assistant message. */
  toolCallId: string;
}

/**
 * Result from a `beforeToolExecution` hook.
 * Return `{ block: true }` to prevent execution.
 */
export interface BeforeToolExecutionResult {
  block?: boolean;
  reason?: string;
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

  /**
   * TypeBox schema for capability-specific configuration.
   * Used by config tools to validate updates and expose schema to the agent.
   * Stored under `config:capability:{id}` in DO storage.
   */
  configSchema?: TObject;

  /**
   * Default configuration value. Should conform to `configSchema`.
   * Returned by config_get when no config has been explicitly set.
   */
  configDefault?: Record<string, unknown>;

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

  /**
   * Config namespaces contributed by this capability.
   * These are exposed via config_get/config_set/config_schema tools.
   * Use this to let the agent manage capability-owned resources (e.g. schedules)
   * through the unified config interface.
   */
  configNamespaces?: (context: AgentContext) => ConfigNamespace[];

  /**
   * HTTP request handlers contributed by this capability.
   * Registered on the Durable Object's fetch() method.
   * Use for inter-agent communication, webhooks, or any HTTP API surface.
   */
  httpHandlers?: (context: AgentContext) => HttpHandler[];

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
     * Called before a tool is executed. Return `{ block: true }` to prevent execution.
     * Hooks run in capability registration order. If any hook blocks, the tool is not executed.
     */
    beforeToolExecution?: (
      event: BeforeToolExecutionEvent,
      ctx: CapabilityHookContext,
    ) => Promise<BeforeToolExecutionResult | void>;

    /**
     * Called after a tool finishes executing.
     * Observation-only — the return value is ignored.
     * Hooks run in capability registration order. Errors are caught
     * per-hook so one failing hook does not block others.
     */
    afterToolExecution?: (event: ToolExecutionEvent, ctx: CapabilityHookContext) => Promise<void>;

    /**
     * Called when a WebSocket client connects or reconnects to a session.
     * Use this to reconcile state (e.g., verify a sandbox container is still running)
     * and broadcast current state to the reconnecting client.
     * Errors are caught per-hook so one failing hook does not block others.
     */
    onConnect?: (ctx: CapabilityHookContext) => Promise<void>;

    /**
     * Called when this capability's config is updated via config_set.
     * Use this to react to configuration changes (e.g., reschedule a cron job).
     * Receives the old and new config values.
     */
    onConfigChange?: (
      oldConfig: Record<string, unknown>,
      newConfig: Record<string, unknown>,
      ctx: CapabilityHookContext,
    ) => Promise<void>;
  };
}

/** An HTTP request handler contributed by a capability. */
export interface HttpHandler {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path to match (e.g., "/agent-handshake"). Must start with /. */
  path: string;
  handler: (request: Request, ctx: CapabilityHttpContext) => Promise<Response>;
}

/**
 * Context provided to capability HTTP handlers.
 * Similar to CapabilityHookContext but without sessionId (HTTP handlers are session-less)
 * and with sendPrompt for triggering agent inference.
 */
export interface CapabilityHttpContext {
  sessionStore: SessionStore;
  /** Persistent key-value storage scoped to this capability. */
  storage: CapabilityStorage;
  /** Broadcast a custom event to ALL connected WebSocket clients. */
  broadcastToAll: (name: string, data: Record<string, unknown>) => void;
  /**
   * Inject a prompt and run agent inference. Returns when the agent completes.
   * Creates a new session if sessionId is not provided.
   * Rejects with 409 if the session's agent is already busy.
   */
  sendPrompt: (opts: {
    text: string;
    sessionId?: string;
    sessionName?: string;
    source?: string;
  }) => Promise<{ sessionId: string; response: string }>;
}
